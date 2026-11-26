/**
 * Is this workspace linked to a FreshService workspace? (QA 11-24, item 4.)
 *
 * workspaces.freshservice_workspace_id is NOT NULL, so a workspace with no
 * FreshService link carries 0 — the convention the integration sandboxes
 * (Assetron, Simorgh, ContinuIT, Sentinel) and the "New workspace" button use.
 * FreshService sync, the fast status lane, the fallback mirror and sync-health
 * checks all skip such a workspace: without this, the per-workspace FS config
 * falls back to the GLOBAL credentials with no workspace filter, which is how
 * 202 sandbox tickets reached the real FreshService on 14 Sep.
 */

import { ConflictError } from './errors.js';

/** True when the row carries an FS workspace id other than 0. */
export function isFreshServiceBound(workspace) {
  if (!workspace) return false;
  const fsId = workspace.freshserviceWorkspaceId;
  if (fsId === null || fsId === undefined) return false;
  const text = String(fsId).trim();
  return text !== '' && text !== '0';
}

/**
 * True only when the row SAYS it has no link (the field is present and is 0,
 * null or empty). A partial object without the field is not judged — callers
 * that hold a full workspaces row get the real answer, and nothing that
 * worked before starts skipping because a caller selected fewer columns.
 */
export function isFreshServiceUnlinked(workspace) {
  if (!workspace || !Object.prototype.hasOwnProperty.call(workspace, 'freshserviceWorkspaceId')) return false;
  return !isFreshServiceBound(workspace);
}

export const NOT_LINKED_MESSAGE = "This workspace isn't linked to FreshService, so there is nothing to sync or backfill from FreshService.";

/**
 * 409 for a FreshService action asked of an unlinked workspace (review of
 * QA 11-24 #4). Without a link the FS config has no workspace filter, so a
 * "Sync week" or backfill there would pull EVERY FreshService workspace's
 * tickets and re-home them (the ticket upsert rewrites workspaceId).
 */
export class FreshServiceNotLinkedError extends ConflictError {
  constructor(message = NOT_LINKED_MESSAGE) {
    super(message);
    this.code = 'freshservice_not_linked';
  }
}

/** Throws FreshServiceNotLinkedError when the row says it has no link. */
export function assertFreshServiceLinked(workspace) {
  if (isFreshServiceUnlinked(workspace)) throw new FreshServiceNotLinkedError();
}

export const OFF_MESSAGE = 'FreshService is switched off for this workspace.';

/**
 * 409 for a FreshService action asked of a workspace whose FreshService mode
 * is 'off' (FreshService exit A1, 25 Nov 2026; services/fsModeService.js).
 * A linked workspace switched off is a different answer from "never linked",
 * so it carries its own code.
 */
export class FreshServiceOffError extends ConflictError {
  constructor(message = OFF_MESSAGE) {
    super(message);
    this.code = 'freshservice_off';
  }
}

export default { isFreshServiceBound, isFreshServiceUnlinked, assertFreshServiceLinked, FreshServiceNotLinkedError, FreshServiceOffError, NOT_LINKED_MESSAGE, OFF_MESSAGE };
