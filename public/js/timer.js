/**
 * Timer display helpers. The authoritative elapsed time always comes from
 * the backend (server-side timers - Section 6); this module only smooths
 * the display between polls by ticking a local offset, it never invents
 * time on its own.
 */
(function () {
  function formatHHMMSS(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const s = String(totalSeconds % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  let tickHandle = null;
  let baseElapsedMs = 0;
  let baseAt = 0;
  let running = false;
  let renderFn = null;

  function tick() {
    if (!renderFn) return;
    const elapsed = running ? baseElapsedMs + (Date.now() - baseAt) : baseElapsedMs;
    renderFn(elapsed);
  }

  /**
   * Start/update the live display for an active timer object as returned
   * by the API: { elapsedMs, status }. status 'running' keeps ticking;
   * 'paused' or absent freezes the display at elapsedMs.
   */
  function bind(activeTimer, onRender) {
    renderFn = onRender;
    if (!activeTimer) {
      baseElapsedMs = 0;
      running = false;
      tick();
      return;
    }
    baseElapsedMs = activeTimer.elapsedMs || 0;
    baseAt = Date.now();
    running = activeTimer.status === 'running';
    tick();
  }

  function unbind() {
    renderFn = null;
  }

  if (!tickHandle) {
    tickHandle = setInterval(tick, 1000);
  }

  window.DepDashTimer = { formatHHMMSS, bind, unbind };
})();
