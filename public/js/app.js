/** Main dashboard wiring: polling, scan event handling, overlays. */
(function () {
  const TASKS_POLL_MS = 30000;
  const STATUS_POLL_MS = 10000;
  const STAFF_TIMEOUT_MS = 10000;

  let selectedTaskId = null;
  let latestTasksById = {};

  const containers = {};

  function $(id) { return document.getElementById(id); }

  function showOverlay(id) { $(id).hidden = false; }
  function hideOverlay(id) { $(id).hidden = true; }
  function hideAllOverlays() {
    ['overlay-awaiting-staff', 'overlay-conflict', 'overlay-countdown', 'overlay-choice', 'overlay-toast', 'overlay-problem']
      .forEach(hideOverlay);
  }

  function toast(message, ms = 2500) {
    $('toast-text').textContent = message;
    showOverlay('overlay-toast');
    setTimeout(() => hideOverlay('overlay-toast'), ms);
  }

  // --- Tasks polling -------------------------------------------------------

  async function loadTasks() {
    try {
      const res = await fetch('/api/tasks');
      const data = await res.json();
      latestTasksById = {};
      data.columns.forEach((col) => col.items.forEach((t) => { latestTasksById[t.task_id] = t; }));

      window.DepDashCards.renderColumns(data, containers, selectTask, selectedTaskId);

      if (selectedTaskId && latestTasksById[selectedTaskId]) {
        window.DepDashDetail.render(latestTasksById[selectedTaskId]);
      } else if (selectedTaskId && !latestTasksById[selectedTaskId]) {
        // Item moved off this dashboard (status advanced beyond woodwork).
        selectedTaskId = null;
        window.DepDashDetail.clear();
      }
    } catch (err) {
      // Cached data (if any) stays on screen; status bar will show offline.
      console.error('loadTasks failed', err);
    }
  }

  function selectTask(task) {
    selectedTaskId = task.task_id;
    window.DepDashDetail.render(task);
    document.querySelectorAll('.card').forEach((el) => {
      el.classList.toggle('selected', el.dataset.taskId === task.task_id);
    });
  }

  // --- Status bar ------------------------------------------------------

  async function loadStatus() {
    try {
      const res = await fetch('/api/status');
      const s = await res.json();
      const dot = $('status-connection-dot');
      dot.classList.toggle('offline', !s.clickup.online);
      const syncTime = s.clickup.lastSuccessAt ? new Date(s.clickup.lastSuccessAt + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';
      $('status-sync').textContent = `last sync: ${syncTime}`;
      $('status-timers').textContent = `timers: ${s.activeTimerCount}`;
      const queueEl = $('status-queue');
      if (s.offlineQueuePending > 0) {
        queueEl.hidden = false;
        queueEl.textContent = `OFFLINE - ${s.offlineQueuePending} queued`;
      } else {
        queueEl.hidden = true;
      }
    } catch (err) {
      $('status-connection-dot').classList.add('offline');
    }
  }

  // --- Scan event handling --------------------------------------------

  let awaitingTimeoutHandle = null;

  function handleScanResult(result) {
    hideAllOverlays();
    if (awaitingTimeoutHandle) { clearInterval(awaitingTimeoutHandle); awaitingTimeoutHandle = null; }

    switch (result.type) {
      case 'awaiting_staff': {
        $('awaiting-item-name').textContent = `${result.item.client_name || ''} - ${result.item.item_name}`;
        const fill = $('awaiting-timeout-fill');
        const start = Date.now();
        fill.style.width = '100%';
        showOverlay('overlay-awaiting-staff');
        awaitingTimeoutHandle = setInterval(() => {
          const remaining = Math.max(0, STAFF_TIMEOUT_MS - (Date.now() - start));
          fill.style.width = `${(remaining / STAFF_TIMEOUT_MS) * 100}%`;
          if (remaining <= 0) {
            clearInterval(awaitingTimeoutHandle);
            awaitingTimeoutHandle = null;
            hideOverlay('overlay-awaiting-staff');
            toast('Scan timed out');
          }
        }, 100);
        break;
      }
      case 'started':
      case 'resumed': {
        toast(`${result.timer.staff_name || result.timer.staff_id} ${result.type === 'started' ? 'started' : 'resumed'} on ${result.item.item_name}`);
        loadTasks();
        break;
      }
      case 'conflict': {
        $('conflict-text').textContent = `This item is being worked by ${result.currentStaffName}. Take over?`;
        showOverlay('overlay-conflict');
        $('conflict-yes').onclick = async () => {
          hideOverlay('overlay-conflict');
          await fetch('/api/scan/takeover', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemId: result.item.task_id, staffCode: result.staff.staff_id }),
          });
          loadTasks();
        };
        $('conflict-no').onclick = () => hideOverlay('overlay-conflict');
        break;
      }
      case 'confirm_completion': {
        runCompletionCountdown(result);
        break;
      }
      case 'error': {
        toast(result.message);
        break;
      }
      default:
        break;
    }
  }

  function runCompletionCountdown(result) {
    const title = result.nextStatus
      ? `Moving ${result.item.item_name} to ${result.nextStatus.toUpperCase()} in`
      : `Confirming ${result.item.item_name} is done in`;
    $('countdown-title').textContent = title;
    let remaining = result.countdownSeconds || 5;
    $('countdown-number').textContent = remaining;
    showOverlay('overlay-countdown');

    let cancelled = false;
    $('countdown-cancel').onclick = async () => {
      cancelled = true;
      hideOverlay('overlay-countdown');
      await fetch(`/api/completion/${result.timerId}/cancel`, { method: 'POST' });
      loadTasks();
    };

    const interval = setInterval(async () => {
      remaining -= 1;
      if (cancelled) { clearInterval(interval); return; }
      if (remaining <= 0) {
        clearInterval(interval);
        hideOverlay('overlay-countdown');
        if (result.ambiguousChoices) {
          showChoiceOverlay(result);
        } else {
          await finalizeCompletion(result.timerId, null);
        }
        return;
      }
      $('countdown-number').textContent = remaining;
    }, 1000);
  }

  function showChoiceOverlay(result) {
    const container = $('choice-buttons');
    container.innerHTML = '';
    result.ambiguousChoices.forEach((choice) => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-done';
      btn.textContent = choice.toUpperCase();
      btn.onclick = async () => {
        hideOverlay('overlay-choice');
        await finalizeCompletion(result.timerId, choice);
      };
      container.appendChild(btn);
    });
    showOverlay('overlay-choice');
  }

  async function finalizeCompletion(timerId, chosenStatus) {
    const res = await fetch(`/api/completion/${timerId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chosenStatus }),
    });
    const data = await res.json();
    if (data.ok) {
      toast(`Moved to ${data.nextStatus}`);
    } else {
      toast(data.message || 'Could not update status');
    }
    loadTasks();
  }

  function initScanner() {
    window.DepDashScanner.onScan(async (code) => {
      try {
        const res = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const result = await res.json();
        handleScanResult(result);
      } catch (err) {
        toast('Scan failed - check connection');
      }
    });
  }

  // --- Action buttons ----------------------------------------------------

  function initButtons() {
    $('btn-im-done').addEventListener('click', () => {
      toast('Scan the item, then your badge, to confirm completion');
    });

    $('btn-report-problem').addEventListener('click', () => {
      const task = window.DepDashDetail.getCurrentTask();
      if (!task) return;
      $('problem-note').hidden = true;
      $('problem-note').value = '';
      $('problem-submit').hidden = true;
      showOverlay('overlay-problem');
    });

    $('problem-cancel').addEventListener('click', () => hideOverlay('overlay-problem'));

    let selectedCategory = null;
    document.querySelectorAll('.problem-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedCategory = btn.dataset.category;
        document.querySelectorAll('.problem-btn').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        const isOther = selectedCategory === 'Other';
        $('problem-note').hidden = !isOther;
        $('problem-submit').hidden = false;
      });
    });

    $('problem-submit').addEventListener('click', async () => {
      const task = window.DepDashDetail.getCurrentTask();
      if (!task || !selectedCategory) return;
      const note = $('problem-note').value;
      hideOverlay('overlay-problem');
      const res = await fetch(`/api/tasks/${task.task_id}/report-problem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: selectedCategory, note }),
      });
      const data = await res.json();
      toast(data.queued ? 'Problem queued (offline) - will sync' : 'Problem reported');
      selectedCategory = null;
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    containers.wood_work = $('scroll-wood-work');
    containers.assembly_wood_work = $('scroll-assembly-wood-work');

    initButtons();
    initScanner();
    loadTasks();
    loadStatus();
    setInterval(loadTasks, TASKS_POLL_MS);
    setInterval(loadStatus, STATUS_POLL_MS);
  });
})();
