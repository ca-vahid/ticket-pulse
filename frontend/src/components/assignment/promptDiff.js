// Prompt diff size guard (Mega 08-26 Phase PD1).
//
// This file used to hold a hand-rolled LCS line diff: a full O(L·M) DP matrix
// (8·L·M bytes — 4k lines ≈ 114MB, 8k ≈ 366MB) computed synchronously inside
// a useMemo, which is what froze the tab on "Compare this version with live"
// (QA 08-25 #1). The diff itself is now Monaco's <DiffEditor> (Myers +
// virtualized rendering); what remains here is the guard that decides when a
// pair is big enough to show raw side-by-side first and let the user opt in.

export const DIFF_MAX_LINES = 1500;
export const DIFF_MAX_CELLS = 2e6;

export function countLines(text) {
  const value = String(text || '');
  return value ? value.split(/\r\n|\r|\n/).length : 0;
}

/** True when either side is past DIFF_MAX_LINES or the L·M cell count is past DIFF_MAX_CELLS. */
export function isDiffTooLarge(baseText, compareText) {
  const left = countLines(baseText);
  const right = countLines(compareText);
  return Math.max(left, right) > DIFF_MAX_LINES || left * right > DIFF_MAX_CELLS;
}
