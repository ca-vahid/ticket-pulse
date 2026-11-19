/**
 * Paste a list into the Tasks tab (QA 11-18 item 3): every line becomes a task.
 *
 * Pure helpers, no React. `parsePastedTasks` turns pasted text (an e-mail's
 * bulleted list, a numbered list, plain lines) into task titles:
 *   - each line is trimmed, leading bullets and numbering are stripped
 *     (-, *, •, ◦, ▪, ·, "1.", "1)", "a)", "(a)", Outlook's "o" sub-bullet);
 *   - empty lines are dropped;
 *   - a heading line ending in ":" ("Floor 6:") is not a task of its own — it
 *     is put in front of the lines under it ("Floor 6 · 11-652 - Keyboard"),
 *     until the next heading or a blank line. A heading with no lines under it is kept as a
 *     task, so nothing pasted is lost.
 */

export const MAX_PASTED_TASKS = 50;
export const HEADING_JOINER = ' · ';

// Symbol bullets may touch the text ("•Item"); "-" and "*" need a space after
// them so "-5 degrees" or "*nix" are not eaten.
const SYMBOL_BULLET = /^[•◦▪▫·‣⁃●○■□☐➢➤►–—]\s*/;
const ASCII_BULLET = /^[-*+](?:\s+|$)/;
// Outlook's plain-text second-level bullet: a lone "o" followed by a tab or 2+ spaces.
const OUTLOOK_BULLET = /^o(?:\t|\s{2,})/;
// Pasted e-mail text often carries non-breaking spaces (U+00A0).
const NBSP = new RegExp(String.fromCharCode(160), 'g');
// "1." "1)" "(1)" "a)" "(a)" "iv." — numbering needs whitespace after it, so
// "11-652" or "2.5 GB" stay as they are. A letter followed by "." is left
// alone ("A. Smith").
const NUMBERING = /^(?:\(?\d{1,3}[.)]|\(?[a-z]\)|\([a-z]\)|\(?[ivx]{1,4}[.)])\s+/i;

/** Strip every leading bullet/number marker from one line ("- 1. Foo" → "Foo"). */
export function cleanTaskLine(raw) {
  let line = String(raw ?? '').replace(NBSP, ' ').trim();
  for (let i = 0; i < 4; i += 1) {
    const next = line
      .replace(SYMBOL_BULLET, '')
      .replace(ASCII_BULLET, '')
      .replace(OUTLOOK_BULLET, '')
      .replace(NUMBERING, '')
      .trim();
    if (next === line) break;
    line = next;
  }
  return line;
}

/** Count the non-empty lines in pasted text (before any cleaning). */
export function countNonEmptyLines(text) {
  return String(text ?? '').split(/\r\n|\r|\n/).filter((l) => l.trim() !== '').length;
}

/**
 * Pasted text → { tasks, headings, total, truncated }.
 *   tasks     — the task titles, capped at `max` (default 50)
 *   headings  — the heading words that were put in front of lines (for the
 *               confirmation's "Headings like 'Floor 6' are kept…" note)
 *   total     — how many tasks the paste held before the cap
 *   truncated — true when the cap cut the list
 */
export function parsePastedTasks(text, { max = MAX_PASTED_TASKS } = {}) {
  const lines = String(text ?? '').split(/\r\n|\r|\n/);
  const all = [];
  const usedHeadings = [];
  let heading = null;
  let headingUsed = false;

  const closeHeading = () => {
    // A heading with nothing under it is kept as a task of its own.
    if (heading && !headingUsed) all.push(heading);
  };

  for (const raw of lines) {
    if (String(raw).trim() === '') {
      // A blank line ends a heading's group once it has lines under it
      // ("Floor 6:\n- Keyboard\n\nOrder cables" → "Order cables" stands alone).
      // A blank line straight after the heading does not.
      if (heading && headingUsed) { heading = null; headingUsed = false; }
      continue;
    }
    const line = cleanTaskLine(raw);
    if (!line) continue;
    if (/:\s*$/.test(line)) {
      const word = line.replace(/:\s*$/, '').trim();
      if (word) {
        closeHeading();
        heading = word;
        headingUsed = false;
        continue;
      }
    }
    if (heading) {
      all.push(`${heading}${HEADING_JOINER}${line}`);
      if (!headingUsed && !usedHeadings.includes(heading)) usedHeadings.push(heading);
      headingUsed = true;
    } else {
      all.push(line);
    }
  }
  closeHeading();

  const cap = Math.max(1, Number(max) || MAX_PASTED_TASKS);
  return {
    tasks: all.slice(0, cap),
    headings: usedHeadings,
    total: all.length,
    truncated: all.length > cap,
  };
}
