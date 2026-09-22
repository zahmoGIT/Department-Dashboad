/**
 * Global QR scanner input listener (Section 5).
 *
 * The USB scanner is a HID keyboard: a scan arrives as a burst of keydown
 * events (<50ms apart) followed by Enter. Human typing is slower (>100ms
 * between keys), so we tell the two apart by inter-key timing rather than
 * trying to detect the device itself. This module is the pluggable "QR HID"
 * input adapter (Section 14.2) - a future NFC reader adapter would just
 * call window.DepDashScanner.emit(code) directly instead of listening to
 * keydown, producing the same scan events for the rest of the app.
 */
(function () {
  const FAST_KEY_THRESHOLD_MS = 50;
  const MIN_CODE_LENGTH = 3;

  let buffer = '';
  let lastKeyTime = 0;
  let listeners = [];

  function emit(code) {
    listeners.forEach((fn) => fn(code));
  }

  function onKeyDown(e) {
    // Ignore modifier-only presses and don't intercept typing into a text
    // input (e.g. the "Other" problem note field).
    const target = e.target;
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;

    const now = Date.now();
    const gap = now - lastKeyTime;
    lastKeyTime = now;

    if (e.key === 'Enter') {
      if (buffer.length >= MIN_CODE_LENGTH) {
        emit(buffer);
      }
      buffer = '';
      return;
    }

    if (e.key.length !== 1) return; // ignore Shift, Tab, arrow keys, etc.

    if (gap > FAST_KEY_THRESHOLD_MS && buffer.length > 0) {
      // Too slow to be a scanner burst - this looks like human typing that
      // wandered into the page; drop what we had and start over.
      buffer = '';
    }
    buffer += e.key;
  }

  document.addEventListener('keydown', onKeyDown, true);

  window.DepDashScanner = {
    onScan(fn) { listeners.push(fn); },
    emit, // exposed for a future non-keyboard input adapter (Section 14.2)
  };
})();
