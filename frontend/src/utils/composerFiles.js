/**
 * Files staged in the ticket composer (reply, note, forward).
 *
 * QA 11-16 #3: the composer kept the first 5 files and dropped the rest
 * without a word, while the editor had already written "[Image: …]" for every
 * pasted screenshot — 7 of 12 pictures never left the browser and the note
 * showed chips that opened nothing. The cap is now the server's
 * (MAX_FILES_PER_MESSAGE in tickets.routes.js), and anything over it is
 * handed back so the composer can refuse it out loud.
 */
export const MAX_COMPOSER_FILES = 20;

/** Same name + size = the same file staged twice. */
const sameFile = (a, b) => a.name === b.name && a.size === b.size;

export function mergeComposerFiles(prev, incoming, max = MAX_COMPOSER_FILES) {
  const merged = [...(prev || [])];
  const dropped = [];
  for (const file of incoming || []) {
    if (merged.some((f) => sameFile(f, file))) continue;
    if (merged.length >= max) { dropped.push(file); continue; }
    merged.push(file);
  }
  return { merged, dropped };
}

/** The toast for files the composer could not take. */
export function droppedFilesMessage(dropped, max = MAX_COMPOSER_FILES) {
  const n = dropped?.length || 0;
  if (!n) return null;
  return `A message can carry up to ${max} files. ${n === 1 ? `${dropped[0].name} was` : `${n} files were`} not added.`;
}

/** The toast for files the server could not store (sent response `attachmentsFailed`). */
export function failedFilesMessage(failed) {
  const list = Array.isArray(failed) ? failed : [];
  if (!list.length) return null;
  const names = list.map((f) => f.fileName).filter(Boolean);
  const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
  return `${list.length === 1 ? 'One file was' : `${list.length} files were`} not stored: ${shown}. ${list[0].reason || ''}`.trim();
}
