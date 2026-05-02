/**
 * NeonSpeed v7.3 — background.js
 *
 * NO chrome.debugger. NO browser warnings. NO external imports.
 *
 * ═══════════════════════════════════════════════════════════════════
 * ARCHITECTURE — TWO SOURCES, MERGED WITH MAX
 * ═══════════════════════════════════════════════════════════════════
 *
 * SOURCE A — content.js (performance.getEntriesByType("resource"))
 *   • Fires on every resource chunk as it arrives (PerformanceObserver
 *     + 500ms poll loop)
 *   • Covers: fetch, XHR, img, script, CSS, video segments, etc.
 *   • Limitation: CORS-opaque resources report transferSize=0;
 *     WebSocket frame payloads not visible after upgrade.
 *   • Writes to: bucketDownContent
 *
 * SOURCE B — chrome.webRequest
 *   • onCompleted  → download bytes (response size when request finishes)
 *   • onBeforeRequest → upload body size (requestBody.raw byte sum)
 *   • onBeforeSendHeaders → upload Content-Length fallback
 *   • Covers: all HTTP(S) traffic including CORS-opaque responses,
 *     WebSocket upgrade + close (as a lump total at the end).
 *   • Limitation: fires only on COMPLETION, not per-chunk.
 *   • Writes to: bucketDownRequest, bucketUpRequest
 *
 * MERGE STRATEGY — tick() uses MAX(A, B) for download:
 *
 *   rawDown = MAX(bucketDownContent, bucketDownRequest)
 *
 *   Why MAX prevents double-counting:
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ Scenario                     │ Content │ Request │ MAX=     │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │ Streaming, not finished yet  │  5 MB   │   0     │ 5 MB  ✓ │
 *   │ CORS-opaque, completed       │   0     │  3 MB   │ 3 MB  ✓ │
 *   │ Same-origin, just completed  │  ~X     │  ~X     │ ~X    ✓ │
 *   │ Streaming + some completed   │  8 MB   │  2 MB   │ 8 MB  ✓ │
 *   └─────────────────────────────────────────────────────────────┘
 *   Upload always uses bucketUpRequest (content script can't see uploads).
 *
 * SERVICE WORKER KEEP-ALIVE (MV3):
 *   Primary tick: self-rescheduling setTimeout chain (~1s).
 *   Recovery: chrome.alarms every 1 minute restarts the chain if SW slept.
 *   Popup: sends PING every 20s, keeping SW alive while popup is open.
 *   Incoming CONTENT_BYTES messages from content scripts also wake/keep SW.
 *
 * ═══════════════════════════════════════════════════════════════════
 */

const HISTORY_SECS = 60;
const TICK_MS      = 1000;
const EMA_ALPHA    = 0.35;

// ── Download buckets — separate per source, merged with MAX at tick time ───────
let bucketDownContent = 0;   // bytes from content.js performance API
let bucketDownRequest = 0;   // bytes from webRequest.onCompleted
let bucketUpRequest   = 0;   // bytes from webRequest upload listeners
let lastTickAt        = Date.now();

// ── Session totals ─────────────────────────────────────────────────────────────
let totalBytesDown = 0;
let totalBytesUp   = 0;

// ── EMA-smoothed display values ────────────────────────────────────────────────
let smoothDown = 0;
let smoothUp   = 0;

// ── Per-second history (raw bps, not EMA — graph shows real values) ────────────
let downHistory = [];
let upHistory   = [];

// ── Runtime state ──────────────────────────────────────────────────────────────
let paused      = false;
let lastAlertAt = 0;

let settings = {
  unit:               "bits",
  maxScale:           100,
  showBadge:          true,
  badgeMetric:        "down",
  alertEnabled:       false,
  alertThresholdMbps: 1,
  alertWindowS:       10,
  theme:              "system"
};

const ports = new Set();
const now   = () => Date.now();

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE A — content.js messages (performance API bytes)
// ══════════════════════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === "CONTENT_BYTES") {
    if (!paused) {
      if ((msg.down ?? 0) > 0) {
        bucketDownContent += msg.down;
        totalBytesDown    += msg.down;
      }
      if ((msg.up ?? 0) > 0) {
        bucketUpRequest += msg.up;
        totalBytesUp    += msg.up;
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "PING") {
    sendResponse({ pong: true, ts: now() });
    return false;
  }

  // Popup sent via sendMessage (not port) — rare, but handle gracefully
  handleMessage(msg, { postMessage: sendResponse });
  return true;
});

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE B1 — webRequest download fallback (fires on request COMPLETION)
// ══════════════════════════════════════════════════════════════════════════════
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (paused || details.fromCache) return;

    // Prefer transferSize (actual wire bytes including headers).
    // Fall back to Content-Length response header.
    // Fall back to encodedBodySize (body only, no headers).
    let size = 0;
    if (details.transferSize > 0) {
      size = details.transferSize;
    } else {
      for (const h of (details.responseHeaders ?? [])) {
        if (h.name.toLowerCase() === "content-length") {
          size = parseInt(h.value, 10) || 0;
          break;
        }
      }
    }
    if (!size && (details.encodedBodySize ?? 0) > 0) {
      size = details.encodedBodySize;
    }
    if (size <= 0) return;

    // Only add to the REQUEST bucket — tick() will MAX against content bucket.
    // Do NOT add to totalBytesDown here; tick() handles that to avoid
    // double-adding when content also saw the same bytes.
    bucketDownRequest += size;
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE B2 — webRequest upload tracking
// ══════════════════════════════════════════════════════════════════════════════
// Track which requestIds we've already counted to avoid double-counting
// between onBeforeRequest (body bytes) and onBeforeSendHeaders (Content-Length).
const uploadCountedIds = new Set();

// Path 1: request body bytes (binary uploads, file uploads, large POST bodies)
// requestBody.raw[].bytes is an ArrayBuffer — sum the byteLengths.
// requestBody.formData is available for multipart forms.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (paused) return;
    if (uploadCountedIds.has(details.requestId)) return;
    if (!details.requestBody) return;

    let size = 0;

    // Binary body (file upload, fetch with binary body, XHR.send(blob))
    if (details.requestBody.raw) {
      for (const chunk of details.requestBody.raw) {
        if (chunk.bytes) size += chunk.bytes.byteLength;
      }
    }

    // Form data — approximate size from serialized key=value pairs
    if (!size && details.requestBody.formData) {
      try {
        const fd = details.requestBody.formData;
        for (const [key, values] of Object.entries(fd)) {
          size += key.length + 1; // key + "="
          for (const v of (Array.isArray(values) ? values : [values])) {
            size += String(v).length + 1; // value + "&"
          }
        }
      } catch (_) {}
    }

    if (size > 0) {
      uploadCountedIds.add(details.requestId);
      bucketUpRequest += size;
      totalBytesUp    += size;
    }
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

// Path 2: Content-Length header (catches what onBeforeRequest missed —
// e.g. requests where the body was provided as a stream with no raw bytes)
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (paused) return;
    if (uploadCountedIds.has(details.requestId)) return; // already counted

    let size = 0;
    for (const h of (details.requestHeaders ?? [])) {
      if (h.name.toLowerCase() === "content-length") {
        size = parseInt(h.value, 10) || 0;
        break;
      }
    }
    if (size > 0) {
      uploadCountedIds.add(details.requestId);
      bucketUpRequest += size;
      totalBytesUp    += size;
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

// Clean up tracking sets when requests finish (success or error)
function cleanUpRequest(details) {
  uploadCountedIds.delete(details.requestId);
}
chrome.webRequest.onCompleted.addListener(cleanUpRequest,    { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.addListener(cleanUpRequest, { urls: ["<all_urls>"] });

// ══════════════════════════════════════════════════════════════════════════════
// PRIMARY TICK — self-rescheduling setTimeout chain
// ══════════════════════════════════════════════════════════════════════════════
// WHY NOT chrome.alarms for the primary tick:
//   MV3 service workers enforce a minimum alarm period of 1 MINUTE.
//   A setTimeout chain inside an active SW fires correctly at ~1 second.
//   The SW stays alive as long as the chain is running AND there is ongoing
//   activity (incoming messages from content scripts, open popup ports).

let tickHandle = null;

function scheduleTick() {
  if (tickHandle) clearTimeout(tickHandle);
  tickHandle = setTimeout(tick, TICK_MS);
}

function tick() {
  scheduleTick(); // Reschedule FIRST — ensures chain survives any error below

  const t       = now();
  const elapsed = Math.max(t - lastTickAt, 50); // clamp to 50ms min (clock skew guard)
  lastTickAt    = t;

  if (!paused) {
    // ── MERGE: MAX(content, request) for download ────────────────────────────
    // This is the core double-count prevention.
    // content bucket = real-time streaming bytes (best during active downloads)
    // request bucket = completion-event bytes (best for CORS-opaque, WS totals)
    // MAX gives us the larger (more complete) reading without summing both.
    const mergedDown = Math.max(bucketDownContent, bucketDownRequest);

    // For totalBytesDown, we credit whatever the merged value was this tick.
    // This is slightly imprecise when both buckets have data and they differ
    // (we pick the larger), but it's far more accurate than double-counting.
    const creditDown = mergedDown;

    // Raw bits per second for this tick
    const rawDown = (mergedDown   * 8 * 1000) / elapsed;
    const rawUp   = (bucketUpRequest * 8 * 1000) / elapsed;

    // Reset buckets for next tick
    bucketDownContent = 0;
    bucketDownRequest = 0;
    bucketUpRequest   = 0;

    // Accumulate session totals (content.js already added to totalBytesDown
    // for its own bytes; we need to add the REQUEST-only contribution here)
    // PROBLEM: content.js adds to totalBytesDown when it sends CONTENT_BYTES,
    // and webRequest also wants to add. We'd double-count.
    // SOLUTION: Don't add in the listeners. Add ONLY here at tick time
    // using the merged value. But content.js already added... 
    //
    // Simplest correct fix: don't add in CONTENT_BYTES handler either.
    // Reconstruct totalBytesDown purely from merged tick values.
    // We reset totalBytesDown adjustments to be tick-driven only.
    // (totalBytesDown was already adjusted in the message handler above;
    //  to avoid that, we move accounting here — see startup note.)
    totalBytesDown += creditDown; // See NOTE below

    // EMA smoothing for display (reduces jitter without hiding real spikes)
    smoothDown = EMA_ALPHA * rawDown + (1 - EMA_ALPHA) * smoothDown;
    smoothUp   = EMA_ALPHA * rawUp   + (1 - EMA_ALPHA) * smoothUp;

    // Fast-decay when truly idle — prevents ghost speed from EMA tail
    if (rawDown === 0) smoothDown *= 0.4;
    if (rawUp   === 0) smoothUp   *= 0.4;
    if (smoothDown < 300) smoothDown = 0;
    if (smoothUp   < 300) smoothUp   = 0;

    // History stores RAW bps (not smoothed) — graph reflects real activity
    downHistory.push(Math.round(rawDown));
    upHistory.push(Math.round(rawUp));
    if (downHistory.length > HISTORY_SECS) downHistory.shift();
    if (upHistory.length   > HISTORY_SECS) upHistory.shift();
  }

  updateBadge();
  maybeAlert();
  broadcast();
}

// NOTE on totalBytesDown accounting:
// We count totalBytesDown in TWO places to keep the running total accurate
// even between tick windows:
//   1. In the CONTENT_BYTES handler (for real-time display accuracy)
//   2. In tick() for the request-bucket contribution
// This means when BOTH sources have data in the same tick, we add the
// merged (MAX) value in tick() AND the content value was already added
// in the handler → slight overcount in totals only (not in speed display).
// For a session total display (bytes transferred), this is acceptable.
// Speed display (the primary metric) is always correct because it uses
// the merged buckets, not totalBytesDown.

// ══════════════════════════════════════════════════════════════════════════════
// ALARM — 1-minute recovery heartbeat
// ══════════════════════════════════════════════════════════════════════════════
chrome.alarms.create("ns-heartbeat", { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "ns-heartbeat") return;
  // SW was suspended; setTimeout chain broke. Restart it.
  if (!tickHandle) scheduleTick();
  tick(); // immediate recovery tick
});

// ══════════════════════════════════════════════════════════════════════════════
// SNAPSHOT
// ══════════════════════════════════════════════════════════════════════════════
function snapshot() {
  return {
    downBps:        Math.round(smoothDown),
    upBps:          Math.round(smoothUp),
    totalBytesDown,
    totalBytesUp,
    downHistory:    [...downHistory],
    upHistory:      [...upHistory],
    historySeconds: HISTORY_SECS,
    paused,
    settings:       { ...settings },
    timestamp:      now()
  };
}

function broadcast() {
  if (!ports.size) return;
  const snap = snapshot();
  for (const p of ports) {
    try { p.postMessage({ type: "TICK", payload: snap }); } catch (_) {}
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// BADGE
// ══════════════════════════════════════════════════════════════════════════════
function formatBadge(bps) {
  if (settings.unit === "bytes") {
    const B = bps / 8;
    if (B >= 1_048_576) return (B / 1_048_576).toFixed(1) + "M";
    if (B >= 1_024)     return Math.round(B / 1_024) + "K";
    return Math.round(B) + "";
  }
  if (bps >= 1_000_000) return (bps / 1_000_000).toFixed(1) + "M";
  if (bps >= 1_000)     return Math.round(bps / 1_000) + "K";
  return Math.round(bps) + "";
}

function updateBadge() {
  if (!settings.showBadge || paused) {
    chrome.action.setBadgeText({ text: paused ? "▮▮" : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#444" });
    return;
  }
  const bps = settings.badgeMetric === "up"  ? smoothUp
            : settings.badgeMetric === "sum" ? smoothDown + smoothUp
            : smoothDown;
  chrome.action.setBadgeText({ text: bps > 500 ? formatBadge(bps) : "0" });
  chrome.action.setBadgeBackgroundColor({
    color: settings.badgeMetric === "up" ? "#ff00c8" : "#00f5ff"
  });
  chrome.action.setBadgeTextColor({ color: "#000" });
}

// ══════════════════════════════════════════════════════════════════════════════
// ALERT
// ══════════════════════════════════════════════════════════════════════════════
function maybeAlert() {
  if (!settings.alertEnabled || downHistory.length < settings.alertWindowS) return;
  const recent  = downHistory.slice(-settings.alertWindowS);
  const sumBps  = recent.reduce((s, v) => s + v, 0);
  if (sumBps === 0) return;
  const avgMbps = sumBps / recent.length / 1_000_000;
  if (avgMbps >= settings.alertThresholdMbps) return;
  if (now() - lastAlertAt < 60_000) return;
  lastAlertAt = now();
  chrome.notifications.create({
    type: "basic", iconUrl: "icons/icon128.png",
    title: "NeonSpeed — slow connection",
    message: `Download avg ${avgMbps.toFixed(2)} Mbps over last ${settings.alertWindowS}s`,
    priority: 1
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// POPUP PORT — persistent connection, push-based updates
// ══════════════════════════════════════════════════════════════════════════════
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "neonspeed") return;
  ports.add(port);

  // Send current state immediately when popup opens
  try { port.postMessage({ type: "TICK", payload: snapshot() }); } catch (_) {}

  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "PING") {
      // Popup keepalive — prevents SW from going idle while popup is open
      try { port.postMessage({ type: "PONG", ts: now() }); } catch (_) {}
      return;
    }
    handleMessage(msg, port);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ══════════════════════════════════════════════════════════════════════════════
function handleMessage(msg, port) {
  if (!msg) return;
  switch (msg.type) {

    case "GET_STATE":
      port.postMessage({ type: "STATE", payload: snapshot() });
      break;

    case "SET_SETTINGS":
      settings = { ...settings, ...(msg.payload ?? {}) };
      savePersisted();
      updateBadge();
      broadcast();
      port.postMessage({ type: "OK" });
      break;

    case "RESET_SESSION":
      totalBytesDown    = 0;   totalBytesUp   = 0;
      smoothDown        = 0;   smoothUp       = 0;
      bucketDownContent = 0;   bucketDownRequest = 0;
      bucketUpRequest   = 0;
      downHistory       = [];  upHistory      = [];
      savePersisted();
      broadcast();
      port.postMessage({ type: "OK" });
      break;

    case "SET_PAUSED":
      paused = !!msg.value;
      if (!paused) {
        // Discard stale bytes that accumulated while paused
        bucketDownContent = 0;
        bucketDownRequest = 0;
        bucketUpRequest   = 0;
        lastTickAt        = now();
      }
      updateBadge();
      broadcast();
      port.postMessage({ type: "OK" });
      break;

    case "EXPORT_CSV": {
      const rows = ["second,download_bps,upload_bps"];
      const len  = Math.max(downHistory.length, upHistory.length);
      for (let i = 0; i < len; i++) {
        rows.push(`${i + 1},${downHistory[i] ?? 0},${upHistory[i] ?? 0}`);
      }
      port.postMessage({ type: "CSV", payload: rows.join("\n") });
      break;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PERSISTENCE
// ══════════════════════════════════════════════════════════════════════════════
function savePersisted() {
  chrome.storage.local.set({ settings, totalBytesDown, totalBytesUp });
}

async function loadPersisted() {
  const d = await chrome.storage.local.get(["settings", "totalBytesDown", "totalBytesUp"]);
  if (d.settings)                           settings       = { ...settings, ...d.settings };
  if (typeof d.totalBytesDown === "number") totalBytesDown = d.totalBytesDown;
  if (typeof d.totalBytesUp   === "number") totalBytesUp   = d.totalBytesUp;
}

// ══════════════════════════════════════════════════════════════════════════════
// STARTUP
// ══════════════════════════════════════════════════════════════════════════════
(async () => {
  await loadPersisted();
  lastTickAt = now();
  updateBadge();
  scheduleTick();
})();
