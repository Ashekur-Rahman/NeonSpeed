/**
 * NeonSpeed v7.3 — content.js
 *
 * PRIMARY real-time byte source via the Performance Resource Timing API.
 * No chrome.debugger, no browser warnings.
 *
 * ═══════════════════════════════════════════════════════════════════
 * HOW THE PERFORMANCE API GIVES US REAL-TIME DATA
 * ═══════════════════════════════════════════════════════════════════
 *
 * PerformanceResourceTiming entries are created by Chrome when network
 * activity starts and their fields are populated as the response arrives:
 *
 *   transferSize   — total wire bytes (headers + compressed body).
 *                    Available once the response headers are received.
 *                    For most resources this is the final value, set once.
 *                    For streaming fetch() / XHR with chunked responses,
 *                    Chrome updates it as chunks arrive.
 *
 *   encodedBodySize — compressed body bytes only (no headers).
 *                    Set on response completion.
 *
 *   decodedBodySize — uncompressed body bytes.
 *                    Set on response completion.
 *
 * KEY INSIGHT — entries appear early, before the download finishes:
 *   A 10MB file downloading over 8 seconds will create a PerformanceEntry
 *   almost immediately (as soon as response headers arrive). We can poll
 *   that entry and see transferSize increase each poll cycle for streaming
 *   resources. For non-streaming resources (simple images, scripts), the
 *   entry appears with its final transferSize all at once when done.
 *
 *   Either way, our delta-tracking approach works:
 *   - Streaming: we accumulate small deltas each poll → smooth real-time
 *   - Non-streaming: we get one delta when the entry first appears → small
 *     spike at completion, but no more flatline because each download is
 *     individually accounted for as soon as it finishes, not batched
 *
 * DUAL DETECTION — PerformanceObserver + setInterval:
 *   PerformanceObserver fires synchronously when a new entry is buffered.
 *   This gives us instant notification for resources that complete between
 *   poll cycles. setInterval handles entries whose transferSize is growing
 *   incrementally (streaming). Together they cover all cases.
 *
 * WEBSOCKET LIMITATION (honest):
 *   WebSocket connections appear as a single "other" entry with only the
 *   HTTP upgrade handshake bytes in transferSize. The actual WS frame
 *   payloads are NOT reflected in the Performance API after the upgrade.
 *   Ookla uses WebSocket binary frames for test data — those bytes will
 *   NOT appear here. They ARE caught by webRequest.onCompleted when the
 *   WebSocket connection closes (end of test), which gives a completion
 *   spike. This is the best available result without chrome.debugger.
 *
 * DOUBLE-COUNT PREVENTION — separate buckets, merged with MAX:
 *   content.js → bucketDownContent (in-progress bytes)
 *   webRequest → bucketDownRequest (completion-event bytes)
 *   tick() → rawDown = MAX(bucketDownContent, bucketDownRequest)
 *
 *   Why MAX works:
 *   - During active streaming: content >> request (request = 0, not done yet)
 *     → MAX = content  ✓
 *   - After completion (CORS blocks transferSize): content = 0, request = size
 *     → MAX = request  ✓
 *   - Both sources have data (CORS-ok page, request just finished):
 *     content ≈ request (same bytes, both counted them)
 *     → MAX = either one  ✓ (no double-count)
 *   - Streaming AND some requests completed this second:
 *     content has streaming + finished; request has finished only
 *     → MAX = content (larger, already includes the finished bytes)  ✓
 *
 * ═══════════════════════════════════════════════════════════════════
 */

// ── Constants ─────────────────────────────────────────────────────────────────
const POLL_MS      = 500;   // polling interval for streaming deltas
const MSG_INTERVAL = 1000;  // how often we send accumulated bytes to background

// ── State ─────────────────────────────────────────────────────────────────────
// Map<entryKey, lastKnownTransferSize>
// entryKey = url + "|" + startTime.toFixed(2)
// Using toFixed(2) gives 10ms resolution which is unique enough in practice.
const seen = new Map();

// Accumulated bytes waiting to be sent in the next MSG_INTERVAL flush
let pendingDown = 0;

// Navigation tracking — clear seen map on SPA navigation
let lastUrl = location.href;

// ── Performance buffer management ─────────────────────────────────────────────
// Chrome's default resource timing buffer holds 250 entries. Heavy pages
// (lots of assets, infinite scroll, video chunks) will overflow this.
// We expand it and reset it before it fills, preserving recent entries.
function expandBuffer() {
  try { performance.setResourceTimingBufferSize(600); } catch (_) {}
}
expandBuffer();

// When buffer is full, Chrome stops recording new entries but fires this event.
// We clear the buffer (Chrome auto-expands after clearResourceTimings) and
// re-snapshot the current entries into our seen map so we don't double-count.
performance.addEventListener("resourcetimingbufferfull", () => {
  // Snapshot current seen map — these entries are about to disappear
  // from getEntriesByType() after clearResourceTimings(). That's fine because
  // we've already accounted for their bytes in pendingDown.
  performance.clearResourceTimings();
  // After clear, old entries are gone. seen map still has their sizes.
  // New entries will appear fresh. seen.get(key) will return undefined for
  // new entries with the same URL+startTime (impossible — startTime will differ).
  expandBuffer();
}, { once: false }); // keep re-registering via the listener staying alive

// ── Entry key ─────────────────────────────────────────────────────────────────
// URL + startTime uniquely identifies a resource fetch.
// Two fetches to the same URL at different times have different startTimes.
// The same fetch observed across multiple polls has the same key — correct.
function entryKey(e) {
  // Round startTime to 1ms to avoid floating-point key drift across polls.
  return e.name + "|" + Math.round(e.startTime);
}

// ── Process a single entry — return delta bytes since last seen ───────────────
function processEntry(e) {
  // Skip cached resources (transferSize = 0 AND fetchStart === responseStart
  // for disk cache; or the browser sets transferSize explicitly to 0 for
  // memory cache). We use encodedBodySize as fallback only for non-cached entries.
  //
  // fromCache detection:
  //   transferSize === 0 AND encodedBodySize > 0 → served from HTTP cache
  //   (browser validated with conditional request but sent no body)
  //   transferSize === 0 AND encodedBodySize === 0 → memory cache, skip entirely
  //   transferSize > 0 → real network bytes, use transferSize
  //   transferSize === 0 AND encodedBodySize > 0 → might be cache, be conservative

  let size = 0;

  if (e.transferSize > 0) {
    // Best case: actual wire bytes reported
    size = e.transferSize;
  } else if (e.encodedBodySize > 0 && e.transferSize === 0) {
    // transferSize is 0 — could be:
    //   a) HTTP cache hit (304 or conditional GET) — body came from cache, 0 wire bytes
    //   b) CORS opaque entry — Timing-Allow-Origin not set, all sizes zeroed
    //   c) Resource hasn't started yet
    // For case (b), we WANT to count these bytes but we can't get the size.
    // We use encodedBodySize as an approximation, but only if the resource
    // has actually completed (responseEnd > 0). This avoids counting a 0-size
    // entry that just means "request started but no data yet".
    if (e.responseEnd > 0) {
      // Resource completed. If it was a real download (not just cache), count it.
      // Heuristic: if fetchStart is very close to responseStart, it was cache.
      // "Very close" = within 5ms (a real network request always has at least
      // TCP RTT, typically > 10ms; cache response is < 2ms).
      const networkTime = e.responseStart - e.fetchStart;
      if (networkTime > 5) {
        // Looks like a real network request where CORS blocked the size.
        // Use encodedBodySize as approximation.
        size = e.encodedBodySize;
      }
      // If networkTime <= 5ms, it's almost certainly cache — skip it (size=0).
    }
    // If responseEnd === 0: resource hasn't completed yet, size = 0.
  }
  // If both are 0: unknown size, skip.

  if (size <= 0) return 0;

  const key  = entryKey(e);
  const prev = seen.get(key) ?? 0;

  if (size > prev) {
    seen.set(key, size);
    return size - prev; // delta
  }
  return 0;
}

// ── Poll all buffered entries ─────────────────────────────────────────────────
function pollEntries() {
  // Navigation check — SPA route changes don't unload the page, so the
  // content script keeps running. We detect URL changes and clear the seen
  // map so old entries don't pollute delta calculations.
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    seen.clear();
    // Don't clear pendingDown — bytes already counted for the previous URL
    // are already in-flight to background. Clearing seen is enough.
  }

  const entries = performance.getEntriesByType("resource");
  let delta = 0;

  for (const e of entries) {
    delta += processEntry(e);
  }

  // Prune entries that have scrolled out of the buffer (URL changed, cleared, etc.)
  // Keep seen map bounded — remove keys not in current entries.
  // Only prune when map grows large to avoid O(n²) on every poll.
  if (seen.size > entries.length + 50) {
    const activeKeys = new Set(entries.map(entryKey));
    for (const k of seen.keys()) {
      if (!activeKeys.has(k)) seen.delete(k);
    }
  }

  if (delta > 0) {
    pendingDown += delta;
  }
}

// ── Flush pending bytes to background ─────────────────────────────────────────
// We accumulate for MSG_INTERVAL ms and send in one message to avoid
// flooding the background SW with hundreds of tiny messages per second.
function flush() {
  if (pendingDown <= 0) return;
  const toSend  = pendingDown;
  pendingDown   = 0;

  chrome.runtime.sendMessage({ type: "CONTENT_BYTES", down: toSend, up: 0 })
    .catch(() => {
      // Background SW may be temporarily asleep (MV3 lifecycle).
      // The bytes are lost for this interval but that's acceptable —
      // the SW will wake on the next message and resume from there.
    });
}

// ── PerformanceObserver — instant notification for new/updated entries ─────────
// This fires synchronously when a resource entry is added to the buffer.
// It catches resources that complete between poll intervals immediately,
// without waiting up to POLL_MS for the setInterval to fire.
try {
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const delta = processEntry(e);
      if (delta > 0) pendingDown += delta;
    }
  });
  // "resource" type covers fetch, XHR, script, img, etc.
  observer.observe({ type: "resource", buffered: false });
  // buffered: false — we don't want to reprocess already-polled entries.
  // We already snapshot them in the initial pollEntries() call below.
} catch (_) {
  // PerformanceObserver not available (very old browser) — setInterval covers this
}

// ── setInterval — catch incremental streaming updates ─────────────────────────
// PerformanceObserver fires when an entry is CREATED. For streaming resources
// where transferSize grows over time (chunked fetch, media streaming), the
// entry already exists but its size changes. We need setInterval to re-check
// those changing sizes between observer events.
setInterval(pollEntries, POLL_MS);

// ── Message flush timer ────────────────────────────────────────────────────────
setInterval(flush, MSG_INTERVAL);

// ── Initial snapshot — process any entries already in buffer ──────────────────
// Content script injected into a page that's already loaded.
// Snapshot current entries into seen map without sending bytes —
// we don't want to count bytes from before the extension was tracking.
(function initSnapshot() {
  const entries = performance.getEntriesByType("resource");
  for (const e of entries) {
    // Prime the seen map with current sizes. processEntry() will return 0
    // for entries already in seen, so we call it to populate the map.
    // This prevents counting pre-existing resources on first real poll.
    let size = e.transferSize > 0 ? e.transferSize : (e.encodedBodySize || 0);
    if (size > 0) seen.set(entryKey(e), size);
  }
})();
