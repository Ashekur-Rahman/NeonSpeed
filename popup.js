/**
 * NeonSpeed v7 — popup.js
 *
 * Changes vs v6:
 *  - Single merged graph (Download + Upload overlaid, different colours)
 *  - Y-axis labels: human-readable scale ticks (500K, 1M, 5M, 10M, 50M …)
 *  - Graph redraws every second on new data (storage.onChanged + port push)
 *  - Canvas never resizes mid-draw (ResizeObserver + flag guard)
 *  - Auto-scales Y to session peak with nice rounded ceiling
 */

const $ = (id) => document.getElementById(id);

// ── DOM ───────────────────────────────────────────────────────────────────────
const downSpeedEl   = $("down-speed"),   downUnitEl    = $("down-unit");
const downFillEl    = $("down-fill"),    downTotalEl   = $("down-total");
const upSpeedEl     = $("up-speed"),     upUnitEl      = $("up-unit");
const upFillEl      = $("up-fill"),      upTotalEl     = $("up-total");
const totalDataEl   = $("total-data");
const tickerEl      = $("ticker");
const liveDot       = $("live-dot"),     liveLabel = $("live-label"), liveMeta = $("live-meta");
const pauseBtn      = $("pause-btn"),    pauseIcon = $("pause-icon");
const resetBtn      = $("reset-btn"),    exportBtn = $("export-btn");
const settingsBtn   = $("settings-btn"), settingsPanel = $("settings-panel");
const setUnit       = $("set-unit"),     setMax = $("set-max"), maxDisplay = $("max-display");
const setBadge      = $("set-badge"),    setBadgeMetric = $("set-badge-metric");
const setAlert      = $("set-alert"),    setThreshold = $("set-threshold");
const thDisplay     = $("th-display"),   alertRow = $("alert-threshold-row");
const peakEl        = $("graph-peak");
const yAxisEl       = $("y-axis");
const canvas        = $("graph-main");
const ctx           = canvas.getContext("2d");

// ── State ─────────────────────────────────────────────────────────────────────
let lastSnapshot   = null;
let port           = null;
let reconnectDelay = 250;
let peakDown       = 0;
let peakUp         = 0;
let drawing        = false;

// ── Canvas sizing ─────────────────────────────────────────────────────────────
let canvasCssW = 0, canvasCssH = 0;

function setupCanvas() {
  const dpr  = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth  || 290;
  const cssH = canvas.clientHeight || 130;
  if (canvasCssW === cssW && canvasCssH === cssH) return;
  canvasCssW = cssW; canvasCssH = cssH;
  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

new ResizeObserver(() => {
  setupCanvas();
  if (lastSnapshot) drawGraph(lastSnapshot);
}).observe(canvas);

// ── Theme ─────────────────────────────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  document.querySelectorAll(".theme-opt").forEach(b =>
    b.classList.toggle("active", b.dataset.theme === t)
  );
  if (lastSnapshot) drawGraph(lastSnapshot);
}
document.querySelectorAll(".theme-opt").forEach(b =>
  b.addEventListener("click", () => {
    applyTheme(b.dataset.theme);
    chrome.storage.local.set({ uiTheme: b.dataset.theme });
  })
);
chrome.storage.local.get(["uiTheme"], (d) => applyTheme(d.uiTheme || "system"));
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if ((document.documentElement.getAttribute("data-theme") || "system") === "system")
    if (lastSnapshot) drawGraph(lastSnapshot);
});

// ── Formatters ────────────────────────────────────────────────────────────────
function formatSpeed(bps, unit) {
  if (unit === "bytes") {
    const B = bps / 8;
    if (B >= 1_073_741_824) return { value: (B/1_073_741_824).toFixed(2), unit:"GB/s" };
    if (B >= 1_048_576)     return { value: (B/1_048_576).toFixed(2),     unit:"MB/s" };
    if (B >= 1_024)         return { value: (B/1_024).toFixed(1),         unit:"KB/s" };
    return                         { value: B.toFixed(0),                 unit:"B/s"  };
  }
  if (bps >= 1_000_000_000) return { value: (bps/1_000_000_000).toFixed(2), unit:"Gbps" };
  if (bps >= 1_000_000)     return { value: (bps/1_000_000).toFixed(2),     unit:"Mbps" };
  if (bps >= 1_000)         return { value: (bps/1_000).toFixed(1),         unit:"Kbps" };
  return                           { value: bps.toFixed(0),                 unit:"bps"  };
}

function formatBytes(b) {
  if (b >= 1_073_741_824) return (b/1_073_741_824).toFixed(2)+" GB";
  if (b >= 1_048_576)     return (b/1_048_576).toFixed(2)+" MB";
  if (b >= 1_024)         return (b/1_024).toFixed(1)+" KB";
  return b+" B";
}

/** Format a bps value as a short Y-axis label */
function fmtYLabel(bps) {
  if (bps >= 1_000_000_000) return (bps/1_000_000_000).toFixed(0)+"G";
  if (bps >= 1_000_000)     return (bps/1_000_000) >= 10
                                   ? Math.round(bps/1_000_000)+"M"
                                   : (bps/1_000_000).toFixed(1)+"M";
  if (bps >= 1_000)         return Math.round(bps/1_000)+"K";
  return bps+"b";
}

/**
 * Pick a "nice" ceiling for the Y axis given the current peak bps.
 * Returns an array of tick values [0, t1, t2, ..., ceiling] (5 ticks total).
 */
function niceYTicks(peakBps) {
  // Candidates in bps: 500K, 1M, 2M, 5M, 10M, 20M, 50M, 100M, 200M, 500M, 1G
  const candidates = [
    500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000,
    20_000_000, 50_000_000, 100_000_000, 200_000_000, 500_000_000, 1_000_000_000
  ];
  // Choose the smallest candidate that is >= peak * 1.2 (20% headroom)
  const target = Math.max(peakBps * 1.2, 1_000_000); // minimum 1 Mbps scale
  let ceiling = candidates.find(c => c >= target) || candidates[candidates.length - 1];
  // Produce 4 evenly spaced ticks + ceiling
  const step = ceiling / 4;
  return [ceiling, step * 3, step * 2, step, 0]; // top → bottom order for flex-col
}

// ── Y-axis DOM update ─────────────────────────────────────────────────────────
function updateYAxis(ticks) {
  yAxisEl.innerHTML = "";
  ticks.forEach(v => {
    const div = document.createElement("div");
    div.className = "y-label";
    div.textContent = v === 0 ? "0" : fmtYLabel(v);
    yAxisEl.appendChild(div);
  });
}

function gaugePercent(bps, maxMbps, peak) {
  const ref = Math.max(maxMbps * 1_000_000, peak, 1_000);
  return Math.min(100, (bps / ref) * 100);
}

let lastDownText = null, lastUpText = null;
function flash(el) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }

// ── Render ────────────────────────────────────────────────────────────────────
function render(s) {
  lastSnapshot = s;
  const unit   = s.settings.unit;

  if (s.downBps > peakDown) peakDown = s.downBps;
  if (s.upBps   > peakUp)   peakUp   = s.upBps;

  // Speed numbers
  const ds = formatSpeed(s.downBps, unit);
  const us = formatSpeed(s.upBps,   unit);
  if (ds.value !== lastDownText) { downSpeedEl.textContent = ds.value; flash(downSpeedEl); lastDownText = ds.value; }
  if (us.value !== lastUpText)   { upSpeedEl.textContent   = us.value; flash(upSpeedEl);   lastUpText   = us.value; }
  downUnitEl.textContent = ds.unit;
  upUnitEl.textContent   = us.unit;

  // Bars
  downFillEl.style.width = gaugePercent(s.downBps, s.settings.maxScale, peakDown) + "%";
  upFillEl.style.width   = gaugePercent(s.upBps,   s.settings.maxScale, peakUp)   + "%";

  // Totals
  downTotalEl.textContent = formatBytes(s.totalBytesDown);
  upTotalEl.textContent   = formatBytes(s.totalBytesUp);
  totalDataEl.textContent = formatBytes(s.totalBytesDown + s.totalBytesUp);

  // Live indicator
  liveDot.classList.toggle("paused", s.paused);
  liveLabel.textContent = s.paused ? "PAUSED" : "LIVE";
  liveMeta.textContent  = s.paused ? "monitoring off" : "~1 update / sec";
  pauseIcon.textContent = s.paused ? "▶" : "⏸";

  tickerEl.textContent = "updated " + new Date(s.timestamp).toLocaleTimeString();

  drawGraph(s);
}

// ── Graph ─────────────────────────────────────────────────────────────────────
function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawGraph(s) {
  if (drawing) return;
  drawing = true;

  setupCanvas();
  const W = canvasCssW || 290;
  const H = canvasCssH || 130;

  ctx.clearRect(0, 0, W, H);

  const N   = 60;
  const pad = { l: 0, r: 4, t: 6, b: 2 }; // y-axis is in DOM, not canvas
  const w   = W - pad.l - pad.r;
  const h   = H - pad.t - pad.b;

  // Pad both series to N entries
  const downSeries = new Array(N).fill(0);
  const upSeries   = new Array(N).fill(0);
  (s.downHistory || []).forEach((v, i) => { downSeries[N - s.downHistory.length + i] = v; });
  (s.upHistory   || []).forEach((v, i) => { upSeries[N   - s.upHistory.length   + i] = v; });

  const allPeak = Math.max(...downSeries, ...upSeries, 1_000_000);
  const ticks   = niceYTicks(allPeak);
  const ceiling = ticks[0]; // highest tick = Y-axis max

  updateYAxis(ticks);

  const gridSoft   = getCssVar("--grid")        || "rgba(255,255,255,0.04)";
  const gridStrong = getCssVar("--grid-strong") || "rgba(255,255,255,0.11)";

  // Horizontal grid lines at each tick level
  ticks.forEach((tick, i) => {
    const y = pad.t + h - (tick / ceiling) * h + 0.5;
    ctx.strokeStyle = i === 0 ? gridStrong : gridSoft;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + w, y);
    ctx.stroke();
  });

  // Vertical tick marks every 15s
  for (let i = 0; i <= 4; i++) {
    const x = pad.l + (w * (i * 15)) / (N - 1) + 0.5;
    ctx.strokeStyle = gridSoft;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + h);
    ctx.stroke();
  }

  /**
   * Draw one line + filled area
   * @param {number[]} series
   * @param {string}   hex      – solid hex colour like "#00f5ff"
   * @param {string}   glow     – glow colour for shadow
   * @param {number}   fillOpacity
   */
  function plotSeries(series, hex, glow, fillOpacity) {
    const pts = series.map((v, i) => ({
      x: pad.l + (w * i) / (N - 1),
      y: pad.t + h - (v / ceiling) * h
    }));

    // Filled area under line
    ctx.save();
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.lineTo(pts[pts.length - 1].x, pad.t + h);
    ctx.lineTo(pts[0].x, pad.t + h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + h);
    grad.addColorStop(0, hex + Math.round(fillOpacity * 255).toString(16).padStart(2,"0"));
    grad.addColorStop(1, hex + "00");
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    // Line with glow
    ctx.save();
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.lineWidth   = 2;
    ctx.strokeStyle = hex;
    ctx.shadowColor = glow;
    ctx.shadowBlur  = 9;
    ctx.lineJoin    = "round";
    ctx.lineCap     = "round";
    ctx.stroke();
    ctx.restore();
  }

  const hasData = downSeries.some(v => v > 0) || upSeries.some(v => v > 0);

  if (!hasData) {
    const textColor = getCssVar("--text-mute") || "rgba(255,255,255,0.4)";
    ctx.fillStyle    = textColor;
    ctx.font         = "10px Orbitron, system-ui";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("no data yet — browse to start", W / 2, H / 2);
    peakEl.textContent = "peak —";
    drawing = false;
    return;
  }

  // Draw upload first (behind download)
  plotSeries(upSeries,   "#ff00c8", "rgba(255,0,200,0.8)",  0.18);
  // Draw download on top
  plotSeries(downSeries, "#00f5ff", "rgba(0,245,255,0.8)",  0.22);

  // Peak label
  const peakBps = Math.max(...downSeries, ...upSeries);
  const pk      = formatSpeed(peakBps, s.settings.unit);
  peakEl.textContent = `peak ${pk.value} ${pk.unit}`;

  drawing = false;
}

// ── Port (push from background every ~1s) ─────────────────────────────────────
let pingInterval = null;

function connect() {
  try { port = chrome.runtime.connect({ name: "neonspeed" }); }
  catch (e) { scheduleReconnect(); return; }
  reconnectDelay = 250;

  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "TICK" || msg.type === "STATE") render(msg.payload);
    if (msg.type === "CSV")  downloadCsv(msg.payload);
    // PONG responses just confirm SW is alive — no action needed
  });

  port.onDisconnect.addListener(() => {
    port = null;
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    scheduleReconnect();
  });

  // Send a PING every 20s to keep the service worker alive while popup is open.
  // Without this, Chrome may suspend the SW after ~30s of no activity,
  // breaking the setTimeout tick chain in background.js.
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = setInterval(() => {
    if (port) {
      try { port.postMessage({ type: "PING" }); } catch (_) {}
    }
  }, 20_000);
}

function scheduleReconnect() {
  reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  setTimeout(connect, reconnectDelay);
}
connect();

// ── Buttons ───────────────────────────────────────────────────────────────────
pauseBtn.addEventListener("click", () => {
  if (!lastSnapshot || !port) return;
  port.postMessage({ type: "SET_PAUSED", value: !lastSnapshot.paused });
});
resetBtn.addEventListener("click", () => {
  if (!port) return;
  peakDown = 0; peakUp = 0;
  lastDownText = null; lastUpText = null;
  port.postMessage({ type: "RESET_SESSION" });
  const orig = resetBtn.textContent;
  resetBtn.textContent = "↺ DONE";
  setTimeout(() => (resetBtn.textContent = orig), 900);
});
exportBtn.addEventListener("click", () => { if (port) port.postMessage({ type: "EXPORT_CSV" }); });
function downloadCsv(text) {
  const blob = new Blob([text], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), {
    href: url, download: `neonspeed-${new Date().toISOString().replace(/[:.]/g,"-")}.csv`
  });
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
}
settingsBtn.addEventListener("click", () => {
  settingsPanel.hidden = !settingsPanel.hidden;
  if (!settingsPanel.hidden) syncSettingsUi();
});

// ── Settings ──────────────────────────────────────────────────────────────────
function syncSettingsUi() {
  if (!lastSnapshot) return;
  const s = lastSnapshot.settings;
  setUnit.value          = s.unit;
  setMax.value           = String(s.maxScale);
  maxDisplay.textContent = s.unit==="bytes" ? `${(s.maxScale/8).toFixed(1)} MB/s` : `${s.maxScale} Mbps`;
  setBadge.checked       = !!s.showBadge;
  setBadgeMetric.value   = s.badgeMetric;
  setAlert.checked       = !!s.alertEnabled;
  setThreshold.value     = String(s.alertThresholdMbps);
  thDisplay.textContent  = `${s.alertThresholdMbps} Mbps`;
  alertRow.style.display = s.alertEnabled ? "" : "none";
}
function pushSettings(patch) { if (port) port.postMessage({ type:"SET_SETTINGS", payload:patch }); }
setUnit.addEventListener("change", () => pushSettings({ unit: setUnit.value }));
setMax.addEventListener("input",  () => {
  const v = parseInt(setMax.value, 10);
  maxDisplay.textContent = lastSnapshot?.settings.unit==="bytes" ? `${(v/8).toFixed(1)} MB/s` : `${v} Mbps`;
});
setMax.addEventListener("change",        () => pushSettings({ maxScale: parseInt(setMax.value,10) }));
setBadge.addEventListener("change",      () => pushSettings({ showBadge: setBadge.checked }));
setBadgeMetric.addEventListener("change",() => pushSettings({ badgeMetric: setBadgeMetric.value }));
setAlert.addEventListener("change", () => {
  alertRow.style.display = setAlert.checked ? "" : "none";
  pushSettings({ alertEnabled: setAlert.checked });
});
setThreshold.addEventListener("input",  () => { thDisplay.textContent = `${setThreshold.value} Mbps`; });
setThreshold.addEventListener("change", () => pushSettings({ alertThresholdMbps: parseInt(setThreshold.value,10) }));

window.addEventListener("unload", () => {
  if (pingInterval) clearInterval(pingInterval);
  try { port?.disconnect(); } catch(_) {}
});
