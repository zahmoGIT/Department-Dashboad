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
 * Climb a task's parent chain up to the true root ancestor (the task with
 * no parent at all) - that root is the actual client/quote task. A leaf
 * item's immediate parent is often a mid-level grouping task instead (e.g.
 * "Upstairs TV room" sitting between a TV-room component and the client's
 * "Mohammed wadia QU-5224" task), confirmed both by spot-checking the live
 * WIP list and by the ZCreations Full Intelligence doc's own Wendy Gajic
 * split-item example. `nodeCache` memoizes fetched nodes across calls since
 * many leaf tasks in the same order share the same ancestors.
 */
async function resolveRootAncestor(taskId, nodeCache, depth = 0) {
  let node = nodeCache.get(taskId);
  if (node === undefined) {
    node = await getTask(taskId).catch(() => null);
    nodeCache.set(taskId, node);
  }
  if (!node || !node.parent || depth >= 6) return node;
  return resolveRootAncestor(node.parent, nodeCache, depth + 1);
}

/**
 * Pull all subtasks from the WIP list currently in one of the woodwork
 * statuses. ClickUp's task list endpoint returns top-level tasks; subtasks
 * are fetched via subtasks=true and the client/quote task (the root
 * ancestor, not just the immediate parent - see resolveRootAncestor) is
 * resolved separately because the list endpoint doesn't include it.
 */
async function fetchWipTasks(statuses = ['wood work', 'assembly wood work']) {
  const qs = new URLSearchParams();
  qs.set('subtasks', 'true');
  qs.set('include_closed', 'false');
  statuses.forEach((s) => qs.append('statuses[]', s));

  const data = await request(`/list/${config.clickup.wipListId}/task?${qs.toString()}`);
  const tasks = data.tasks || [];

  const nodeCache = new Map();
  const roots = {};
  await Promise.all(tasks.map(async (task) => {
    if (!task.parent || roots[task.parent] !== undefined) return;
    roots[task.parent] = await resolveRootAncestor(task.parent, nodeCache);
  }));

  return tasks.map((task) => ({ task, parent: task.parent ? roots[task.parent] : null }));
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
