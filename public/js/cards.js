/** Card rendering + column management (left panel, Section 3). */
(function () {
  function priorityClass(priority) {
    if (!priority) return '';
    const p = String(priority).toLowerCase();
    return ['urgent', 'high', 'normal', 'low'].includes(p) ? `priority-${p}` : '';
  }

  function formatDueDate(dueDateMs) {
    if (!dueDateMs) return '-';
    const due = new Date(Number(dueDateMs));
    const today = new Date();
    const sameDay = due.toDateString() === today.toDateString();
    if (sameDay) return 'Today';
    return due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function assigneeLabel(task) {
    if (!task.assignees || task.assignees.length === 0) return '-';
    return task.assignees.map((a) => a.username || a.email || a.id).join(', ');
  }

  function renderCard(task, onSelect, selectedId) {
    const el = document.createElement('div');
    el.className = `card ${priorityClass(task.priority)}`.trim();
    if (task.task_id === selectedId) el.classList.add('selected');
    el.dataset.taskId = task.task_id;

    const clientLine = task.client_name && task.quote_ref
      ? `${task.client_name} ${task.quote_ref}`
      : (task.client_name || task.quote_ref || '');

    el.innerHTML = `
      <div class="card-client">${escapeHtml(clientLine)}</div>
      <div class="card-item">${escapeHtml(task.item_name || '')}</div>
      <div class="card-meta">
        <span>≡ ${task.description ? 1 : 0}</span>
        <span>◎ ${task.attachment_count || 0}</span>
      </div>
      <div class="card-status-row">
        <span class="status-dot"></span>
        <span>${escapeHtml((task.status || '').toUpperCase())}</span>
      </div>
      <div class="card-meta">
        <span>⊙ ${escapeHtml(assigneeLabel(task))}</span>
        <span>📅 ${formatDueDate(task.due_date)}</span>
        <span>${escapeHtml(task.priority || 'Normal')}</span>
      </div>
      ${task.activeTimer ? `<div class="card-timer-indicator ${task.activeTimer.status}">${escapeHtml(task.activeTimer.staffName || task.activeTimer.staffId)} - ${task.activeTimer.status}</div>` : ''}
    `;
    el.addEventListener('click', () => onSelect(task));
    return el;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function renderColumns(data, containers, onSelect, selectedId) {
    data.columns.forEach((col) => {
      const container = containers[col.key];
      if (!container) return;
      container.innerHTML = '';
      col.items.forEach((task) => {
        container.appendChild(renderCard(task, onSelect, selectedId));
      });
    });
  }

  window.DepDashCards = { renderColumns };
})();
