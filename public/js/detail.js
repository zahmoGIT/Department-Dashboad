/** Detail panel rendering: header, PDF/doc tabs, action buttons (Section 4). */
(function () {
  const els = {};
  let activeTab = 'job_sheet';
  let currentTask = null;
  let currentDocs = null;

  function cacheEls() {
    els.empty = document.getElementById('detail-empty');
    els.content = document.getElementById('detail-content');
    els.client = document.getElementById('detail-client');
    els.quoteRef = document.getElementById('detail-quote-ref');
    els.cuRef = document.getElementById('detail-cu-ref');
    els.statusBadge = document.getElementById('detail-status-badge');
    els.worker = document.getElementById('detail-worker');
    els.timer = document.getElementById('detail-timer');
    els.tabs = document.querySelectorAll('.doc-tab');
    els.frame = document.getElementById('doc-frame');
    els.missing = document.getElementById('doc-missing');
  }

  function renderDocTab() {
    els.tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === activeTab));
    const doc = currentDocs ? currentDocs[activeTab] : null;
    if (doc) {
      els.frame.hidden = false;
      els.missing.hidden = true;
      els.frame.src = `/api/documents/file/${doc.file_id}`;
    } else {
      els.frame.hidden = true;
      els.frame.src = '';
      els.missing.hidden = false;
      const label = activeTab === 'job_sheet' ? 'Job Sheet' : activeTab === 'cutlist' ? 'Cutlist' : 'Drawing';
      els.missing.textContent = `No ${label} found for ${currentTask ? currentTask.cu_reference || currentTask.item_name : ''}`;
    }
  }

  async function render(task) {
    currentTask = task;
    els.empty.hidden = true;
    els.content.hidden = false;

    const clientLine = task.client_name && task.quote_ref ? `${task.client_name}` : (task.client_name || '');
    els.client.textContent = clientLine || task.item_name || 'Untitled';
    els.quoteRef.textContent = task.quote_ref || '';
    els.cuRef.textContent = task.cu_reference || '';
    els.statusBadge.textContent = (task.status || '-').toUpperCase();
    els.worker.textContent = task.activeTimer
      ? `${task.activeTimer.staffName || task.activeTimer.staffId} (${task.activeTimer.status})`
      : 'Unassigned';

    window.DepDashTimer.bind(task.activeTimer, (ms) => {
      els.timer.textContent = window.DepDashTimer.formatHHMMSS(ms);
    });

    currentDocs = null;
    if (task.cu_reference) {
      try {
        const res = await fetch(`/api/documents/${encodeURIComponent(task.cu_reference)}`);
        currentDocs = await res.json();
      } catch (err) {
        currentDocs = null;
      }
    }
    renderDocTab();
  }

  function clear() {
    currentTask = null;
    currentDocs = null;
    els.empty.hidden = false;
    els.content.hidden = true;
    window.DepDashTimer.unbind();
  }

  function initTabs() {
    els.tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        activeTab = tab.dataset.tab;
        renderDocTab();
      });
    });
  }

  function getCurrentTask() { return currentTask; }

  document.addEventListener('DOMContentLoaded', () => {
    cacheEls();
    initTabs();
  });

  window.DepDashDetail = { render, clear, getCurrentTask };
})();
