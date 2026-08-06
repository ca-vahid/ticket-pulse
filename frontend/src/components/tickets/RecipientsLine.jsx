import { useState } from 'react';
import { Mail } from 'lucide-react';

// Cc visibility (QA 08-05 #3). One quiet, reusable "To / Cc" line used in
// three places: the ticket description card, per-message thread headers, and
// the peek preview. FS shows To and Cc under the subject — we match that
// clarity in our own visual language: text-xs slate, mail icon, and long
// lists truncated to a couple of addresses with an inline "+N more" expand.

/**
 * Normalize a recipients list for display: strings only, deduped
 * (case-insensitive), and RFC "Name <email>" forms (how FS stores To on some
 * tickets) reduced to the bare address.
 */
export function normalizeRecipients(list) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const raw = String(item || '').trim();
    const angled = raw.match(/<([^<>\s]+@[^<>\s]+)>/);
    const value = angled ? angled[1] : raw;
    if (!value || !value.includes('@')) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Initial Cc seed for the reply composer — FS behavior: reply-cc wins when FS
 * recorded one, otherwise the ticket-level cc list. Lowercased, deduped and
 * capped at 10 (the server's cc schema limit). Seed ONLY — user edits are
 * authoritative, and notes/forwards never seed.
 */
export function seedReplyCc(ticket) {
  const source = ticket?.replyCcEmails?.length ? ticket.replyCcEmails : ticket?.ccEmails;
  return normalizeRecipients(source).map((e) => e.toLowerCase()).slice(0, 10);
}

function RecipientGroup({ label, emails, expanded, visibleCount }) {
  const shown = expanded ? emails : emails.slice(0, visibleCount);
  return (
    <span className="min-w-0">
      <span className="font-semibold text-slate-400">{label}:</span>{' '}
      <span className="break-all">{shown.join(', ')}</span>
    </span>
  );
}

/**
 * Quiet recipients line: "To: it@… · Cc: a@…, b@… +2 more". Renders nothing
 * when both lists are empty. `compact` shrinks it for thread-entry headers.
 */
export default function RecipientsLine({ to, cc, className = '', compact = false, visibleCount = 2 }) {
  const [expanded, setExpanded] = useState(false);
  const toList = normalizeRecipients(to);
  const ccList = normalizeRecipients(cc);
  if (toList.length === 0 && ccList.length === 0) return null;

  const hiddenCount = Math.max(0, toList.length - visibleCount) + Math.max(0, ccList.length - visibleCount);
  const textSize = compact ? 'text-[11px]' : 'text-xs';
  const iconSize = compact ? 'w-3 h-3' : 'w-3.5 h-3.5';

  return (
    <div className={`flex items-start gap-1.5 ${textSize} text-slate-500 ${className}`}>
      <Mail className={`${iconSize} mt-0.5 flex-none text-slate-400`} aria-hidden="true" />
      <span className="min-w-0 leading-relaxed">
        {toList.length > 0 && (
          <RecipientGroup label="To" emails={toList} expanded={expanded} visibleCount={visibleCount} />
        )}
        {toList.length > 0 && ccList.length > 0 && <span className="text-slate-300" aria-hidden="true">{' · '}</span>}
        {ccList.length > 0 && (
          <RecipientGroup label="Cc" emails={ccList} expanded={expanded} visibleCount={visibleCount} />
        )}
        {hiddenCount > 0 && (
          <>
            {' '}
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="tp-focus-ring inline rounded px-0.5 font-semibold text-slate-400 underline decoration-dotted underline-offset-2 hover:text-blue-600"
            >
              {expanded ? 'show less' : `+${hiddenCount} more`}
            </button>
          </>
        )}
      </span>
    </div>
  );
}
