# ⚡ NeonSpeed — Internet Speed Meter

> A real-time upload & download speed monitor for Chrome, with a live 60-second graph, neon glass UI, theme support, speed alerts, and CSV export.

![Version](https://img.shields.io/badge/version-7.3.0-cyan)
![Manifest](https://img.shields.io/badge/Manifest-V3-blue)
![License](https://img.shields.io/badge/license-MIT-green)

---

## 📸 Screenshot

> *(Add your popup screenshot here)*

---

## ✨ Features

- 📡 **Real-time speed** — updates every second, no spikes or freezing
- 📈 **60-second live graph** — download and upload overlaid, auto-scaling Y-axis
- ⬆️⬇️ **Upload + Download tracking** — both shown simultaneously
- 🎨 **Three themes** — Dark, Light, and System (follows OS preference)
- 🔔 **Speed alerts** — get a browser notification if speed drops below your threshold
- 📊 **CSV export** — download your 60-second speed history as a spreadsheet
- 🏷️ **Badge display** — see live speed on the extension icon without opening the popup
- ⏸️ **Pause / Resume** — stop monitoring at any time
- 🔄 **Session reset** — clear totals and history with one click
- 💾 **Persistent settings** — preferences saved across browser restarts
- 🚫 **No browser warnings** — zero use of `chrome.debugger`; no "Chrome is being debugged" banner

---

## 🏗️ How It Works

NeonSpeed uses a **two-source hybrid architecture** to give accurate, real-time readings without any invasive APIs.

### Source A — Performance API (Primary, real-time)
`content.js` runs on every page and uses:
- **`PerformanceObserver`** — fires instantly when a new network resource entry appears
- **`performance.getEntriesByType("resource")`** polled every 500ms — catches streaming resources whose `transferSize` grows as chunks arrive

This gives smooth, per-chunk byte tracking for fetch, XHR, images, video segments, scripts, and CSS — even while downloads are in progress.

### Source B — `chrome.webRequest` (Fallback + Upload)
`background.js` listens to:
- **`onCompleted`** — captures completed request sizes, including CORS-opaque responses the Performance API can't measure
- **`onBeforeRequest`** — reads raw request body bytes for file uploads and binary POST bodies
- **`onBeforeSendHeaders`** — reads `Content-Length` header as upload size fallback

### Anti-Double-Count: MAX Merge
Both sources report to separate buckets. Every second, `tick()` merges them using:

```
rawDown = MAX(bucketDownContent, bucketDownRequest)
```

This ensures whichever source has better data wins, without summing both and doubling the count.

| Scenario | Content | Request | MAX result |
|---|---|---|---|
| Streaming download, not finished | 5 MB | 0 | **5 MB** ✓ |
| CORS-opaque, completed | 0 | 3 MB | **3 MB** ✓ |
| Same-origin, just completed | ~X | ~X | **~X** ✓ |
| Streaming + some requests done | 8 MB | 2 MB | **8 MB** ✓ |

---

## 🛡️ Permissions Explained

| Permission | Why it's needed |
|---|---|
| `webRequest` | Count bytes from completed HTTP requests (download fallback + upload) |
| `storage` | Save settings and session totals across browser restarts |
| `alarms` | Recovery heartbeat — restarts the 1-second tick if the service worker sleeps |
| `notifications` | Show alert when speed drops below your configured threshold |
| `<all_urls>` | Monitor network traffic across all websites |

**No `debugger` permission. No `tabs` permission. No remote code. No data ever leaves your device.**

---

## 📂 File Structure

```
neonspeed_fixed/
├── manifest.json       # MV3 manifest — permissions, content scripts, SW
├── background.js       # Service worker — tick engine, byte merging, badge, alerts
├── content.js          # Content script — Performance API real-time polling
├── popup.html          # Popup markup
├── popup.js            # Popup logic — graph, render, settings, port keepalive
├── style.css           # Neon glass UI styles + theme variables
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## ⚙️ Technical Details

### Service Worker Keep-Alive (MV3)
Chrome MV3 service workers can be suspended after ~30s of inactivity. NeonSpeed keeps the SW alive using three mechanisms:
1. **Self-rescheduling `setTimeout` chain** — each tick immediately schedules the next, keeping the SW active
2. **Popup PING every 20s** — the popup sends a keepalive ping while it's open
3. **`chrome.alarms` at 1-minute** — acts as a recovery heartbeat; restarts the tick chain if the SW was suspended

> Note: `chrome.alarms` has a minimum period of **1 minute** in MV3 service workers, so it cannot be used as the primary 1-second tick source. The `setTimeout` chain is the correct MV3 pattern.

### Speed Calculation
```
rawBps = (bytesThisTick × 8 × 1000) / elapsedMs
```
Display uses **EMA smoothing** (`α = 0.35`) to reduce jitter without hiding real spikes. History stores **raw unsmoothed values** so the graph shows true activity — real peaks and real silence.

### Known Limitations
- **WebSocket frame payloads** (e.g., Ookla speed test data) are not visible to the Performance API after the WS upgrade. Ookla traffic will appear as a lump sum when the WebSocket closes, not in real-time. The only workaround would be `chrome.debugger` which triggers a browser warning — by design, NeonSpeed does not use it.
- **CORS-opaque resources** (cross-origin without `Timing-Allow-Origin` header) have `transferSize = 0` in the Performance API. These are caught by the `webRequest` fallback.
- **Web Worker fetches** are not visible to the main-frame content script. Standard page fetches are fully covered.

---

## 🚀 Installation (Developer Mode)

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in top right)
4. Click **Load unpacked**
5. Select the `neonspeed_fixed/` folder
6. The NeonSpeed icon appears in your toolbar — pin it for easy access

---

## 🏪 Chrome Web Store

> *(Add your store link here once published)*

---

## 🛠️ Development

### Modifying the extension
- **Speed logic** → `background.js` (`tick()` function, bucket constants)
- **Real-time tracking** → `content.js` (`processEntry()`, `pollEntries()`)
- **UI / graph** → `popup.js` + `popup.html` + `style.css`
- **Permissions / metadata** → `manifest.json`

### After making changes
Go to `chrome://extensions` → find NeonSpeed → click the **refresh icon (↺)**. Then close and reopen the popup.

### Useful debugging
- Open `chrome://extensions` → NeonSpeed → **Service Worker** → inspect background logs
- Right-click popup → **Inspect** for popup console
- Right-click any page → **Inspect** → **Console** for content script logs

---

## 📋 Changelog

### v7.3.0 (Current)
- Removed `chrome.debugger` entirely — no more browser warning banner
- Added `PerformanceObserver` for instant new-resource detection
- Added dual-bucket MAX merge to prevent double-counting
- Fixed service worker keep-alive (self-rescheduling setTimeout chain)
- Fixed graph: history now stores raw bps, not EMA-smoothed values
- Fixed upload tracking via `requestBody.raw` byte counting
- Fixed session total double-counting (`totalBytesDown/Up` now owned exclusively by `tick()`)
- Fixed icon sizes: proper 16×16 and 48×48 PNGs
- Improved SPA navigation detection (clears seen-resource map on URL change)
- Improved performance buffer management (expands to 600 entries, handles overflow)

### v7.1.0 – v7.2.0
- Added popup PING keepalive (20s interval)
- Added `chrome.debugger` CDP layer (removed in v7.3 due to browser warning)
- Added content script fallback with `performance.getEntriesByType`

### v7.0.0
- Initial MV3 port
- Neon glass UI, 60s graph, themes, alerts, CSV export

---

## 📄 License

MIT — free to use, modify, and distribute. Attribution appreciated but not required.

---

## 🔒 Privacy

NeonSpeed operates **100% locally**. It measures byte counts from your browser's own network activity and displays them in the popup. No data is collected, stored on any server, or transmitted anywhere outside your device. Settings and session totals are saved only in your browser's local extension storage (`chrome.storage.local`).
