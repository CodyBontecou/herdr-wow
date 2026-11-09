// Shared display state. Legacy T3 fields remain supported for its adapter;
// other backends supply uiStatus directly instead of inventing T3 run objects.
const WORKING = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);

export function threadStatus(t) {
  if (t.uiStatus) return t.uiStatus;
  if (t.archivedAt || t.deletedAt) return 'archived';
  if (t.pendingRuntimeRequest) return 'input';
  if (t.activityRunStatus || WORKING.has(t.status)) return 'working';
  if (t.settledOverride === 'settled') return 'settled';
  if (t.hasActionableProposedPlan) return 'plan';
  if (t.status === 'failed' || t.lastError) return 'failed';
  return 'open';
}

export function isUnread(t) {
  const done = t.latestRunCompletedAt ? Date.parse(t.latestRunCompletedAt) : 0;
  const seen = t.lastVisitedAt ? Date.parse(t.lastVisitedAt) : 0;
  return done > seen;
}
