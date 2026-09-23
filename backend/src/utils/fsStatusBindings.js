// FreshService status id <-> Ticket Pulse status name, per workspace
// (Pending Response build, 23 Sep 2026 — plans/PENDING_RESPONSE_STATUS_SYNC.md).
//
// The transformer and the write-back helpers are synchronous and have no
// database access, so the bindings live here as a plain in-memory map, loaded
// by statusService.loadFsBindings() at boot, after every registry write and on
// each FreshService status-choice sync. An unloaded map is safe: callers fall
// back to the fixed labels below.

// Labels used when a workspace has no binding for these ids yet.
export const FALLBACK_STATUS_LABELS = Object.freeze({
  6: 'Pending Response',
  7: 'Waiting on Third Party',
});

const byWorkspace = new Map(); // tpWorkspaceId -> { idToName: Map<number,string>, nameToId: Map<string,number>, fsLabels: Map<number,string> }
const fsWorkspaceToTp = new Map(); // freshservice workspace id (string) -> tpWorkspaceId

function entry(workspaceId) {
  const key = Number(workspaceId);
  if (!byWorkspace.has(key)) byWorkspace.set(key, { idToName: new Map(), nameToId: new Map(), fsLabels: new Map() });
  return byWorkspace.get(key);
}

/**
 * Replace one workspace's bindings.
 * @param {number} workspaceId Ticket Pulse workspace id
 * @param {{ fsWorkspaceId?: number|string|null, bindings?: Array<{fsId:number,name:string}>, fsLabels?: Record<number,string>|null }} data
 */
export function setWorkspaceBindings(workspaceId, { fsWorkspaceId = null, bindings = [], fsLabels = null } = {}) {
  const e = entry(workspaceId);
  e.idToName = new Map();
  e.nameToId = new Map();
  for (const b of bindings) {
    const id = Number(b?.fsId);
    const name = String(b?.name || '').trim();
    if (!Number.isInteger(id) || !name) continue;
    e.idToName.set(id, name);
    e.nameToId.set(name.toLowerCase(), id);
  }
  if (fsLabels) {
    e.fsLabels = new Map(Object.entries(fsLabels).map(([id, label]) => [Number(id), String(label)]));
  }
  if (fsWorkspaceId !== null && fsWorkspaceId !== undefined) fsWorkspaceToTp.set(String(fsWorkspaceId), Number(workspaceId));
}

export function clearFsStatusBindings() {
  byWorkspace.clear();
  fsWorkspaceToTp.clear();
}

function resolveWorkspace({ workspaceId = null, fsWorkspaceId = null } = {}) {
  if (workspaceId !== null && workspaceId !== undefined) return Number(workspaceId);
  if (fsWorkspaceId !== null && fsWorkspaceId !== undefined) return fsWorkspaceToTp.get(String(fsWorkspaceId)) ?? null;
  return null;
}

/** Ticket Pulse name bound to a FreshService status id, else null. */
export function boundNameForFsStatus(fsStatusId, scope = {}) {
  const ws = resolveWorkspace(scope);
  if (ws === null) return null;
  return byWorkspace.get(ws)?.idToName.get(Number(fsStatusId)) ?? null;
}

/** FreshService label last read for this id (status-choice sync), else null. */
export function fsLabelForStatus(fsStatusId, scope = {}) {
  const ws = resolveWorkspace(scope);
  if (ws === null) return null;
  return byWorkspace.get(ws)?.fsLabels.get(Number(fsStatusId)) ?? null;
}

/** FreshService status id bound to a Ticket Pulse status name, else null. */
export function boundFsStatusForName(name, scope = {}) {
  const ws = resolveWorkspace(scope);
  if (ws === null) return null;
  return byWorkspace.get(ws)?.nameToId.get(String(name || '').trim().toLowerCase()) ?? null;
}

/** "Pending response" -> "Pending Response" (the name Vahid chose for the app). */
export function titleCaseStatusLabel(label) {
  return String(label || '')
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}
