const fetch = require('node-fetch');
const config = require('../config');

const BASE_URL = 'https://api.clickup.com/api/v2';

function headers() {
  return {
    Authorization: config.clickup.apiToken,
    'Content-Type': 'application/json',
  };
}

async function request(pathname, options = {}) {
  if (!config.clickup.apiToken) {
    throw new Error('CLICKUP_API_TOKEN is not configured');
  }
  const res = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`ClickUp API ${res.status} ${res.statusText} on ${pathname}: ${body}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Pull all subtasks from the WIP list currently in one of the woodwork
 * statuses. ClickUp's task list endpoint returns top-level tasks; subtasks
 * are fetched via subtasks=true and parent info is attached separately
 * because the list endpoint doesn't include full parent task fields.
 */
async function fetchWipTasks(statuses = ['wood work', 'assembly wood work']) {
  const qs = new URLSearchParams();
  qs.set('subtasks', 'true');
  qs.set('include_closed', 'false');
  statuses.forEach((s) => qs.append('statuses[]', s));

  const data = await request(`/list/${config.clickup.wipListId}/task?${qs.toString()}`);
  const tasks = data.tasks || [];

  // Resolve parent task info (client name / quote ref) for subtasks whose
  // parent isn't included inline.
  const parentIds = [...new Set(tasks.map((t) => t.parent).filter(Boolean))];
  const parents = {};
  await Promise.all(parentIds.map(async (pid) => {
    try {
      parents[pid] = await request(`/task/${pid}`);
    } catch (err) {
      // Parent lookup failing shouldn't take down the whole poll; the task
      // just renders without client name and gets logged by the caller.
      parents[pid] = null;
    }
  }));

  return tasks.map((task) => ({ task, parent: task.parent ? parents[task.parent] : null }));
}

async function getTask(taskId) {
  return request(`/task/${taskId}`);
}

async function updateTaskStatus(taskId, status) {
  return request(`/task/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
}

async function moveTaskStatus(taskId, status) {
  return updateTaskStatus(taskId, status);
}

async function startTimeEntry(taskId, assigneeUserId) {
  return request(`/team/${config.clickup.teamId}/time_entries`, {
    method: 'POST',
    body: JSON.stringify({
      tid: taskId,
      start: Date.now(),
      billable: false,
      assignee: assigneeUserId ? Number(assigneeUserId) : undefined,
    }),
  });
}

async function stopTimeEntry(timeEntryId) {
  // ClickUp's "stop running timer" endpoint stops whatever timer is
  // currently running for the authenticated token's team; there is no
  // per-id stop, so we instead PUT an end time on the specific entry.
  return request(`/team/${config.clickup.teamId}/time_entries/${timeEntryId}`, {
    method: 'PUT',
    body: JSON.stringify({ end: Date.now() }),
  });
}

async function postComment(taskId, commentText, notifyUserIds = []) {
  return request(`/task/${taskId}/comment`, {
    method: 'POST',
    body: JSON.stringify({
      comment_text: commentText,
      notify_all: false,
      assignees: notifyUserIds.map(Number),
    }),
  });
}

module.exports = {
  fetchWipTasks,
  getTask,
  updateTaskStatus,
  moveTaskStatus,
  startTimeEntry,
  stopTimeEntry,
  postComment,
};
