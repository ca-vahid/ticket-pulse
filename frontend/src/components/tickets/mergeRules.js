import { baseStatusOf } from './statusDefs';

// Merge survivor rules, spelled out ONCE (Phase MB1/MB2, QA 08-27 #7): the
// detail header's disabled Merge button and the survivor radios inside
// MergeTicketsModal say the same thing. Mirrors ticketMergeService's target
// gate (TP-born + Open/Pending base). Sources may be any origin and any
// status except Deleted/Spam.
export const MERGE_FS_BLOCKED_REASON = 'FreshService owns this ticket’s conversation — merge it in FreshService (it can still be folded INTO a Ticket Pulse ticket from that ticket’s Merge dialog)';
export const MERGE_TERMINAL_BLOCKED_REASON = 'Only Open or Pending tickets can receive a merge — reopen this ticket first';

/** Why `t` cannot be the surviving primary, or null when it can. */
export function mergeSurvivorBlockedReason(t, statusDefs = null) {
  if (!t) return null;
  if (t.origin !== 'ticketpulse') return MERGE_FS_BLOCKED_REASON;
  if (!['Open', 'Pending'].includes(baseStatusOf(statusDefs, t.status))) return MERGE_TERMINAL_BLOCKED_REASON;
  return null;
}
