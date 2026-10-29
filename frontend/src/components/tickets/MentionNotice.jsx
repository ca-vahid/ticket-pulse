import { AtSign, X } from 'lucide-react';

/**
 * "You were mentioned" (29 Oct 2026): shown on the ticket the first time the
 * agent opens it after a colleague @mentioned them in a note. The server marks
 * those mentions seen as it hands them over; this line stays until dismissed.
 */

function whenLabel(at) {
  const d = at ? new Date(at) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-CA', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function mentionNoticeText(mentions = []) {
  const list = Array.isArray(mentions) ? mentions.filter(Boolean) : [];
  if (!list.length) return '';
  const names = [...new Set(list.map((m) => String(m.by || 'A colleague').trim()))];
  const who = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]} and ${names.length - 1} others`;
  const what = list.length === 1 ? 'a note' : `${list.length} notes`;
  const when = list.length === 1 && whenLabel(list[0].at) ? ` · ${whenLabel(list[0].at)}` : '';
  return `${who} mentioned you in ${what}${when}.`;
}

export default function MentionNotice({ mentions, onJump, onDismiss }) {
  const text = mentionNoticeText(mentions);
  if (!text) return null;
  const last = mentions[mentions.length - 1];
  return (
    <div data-testid="mention-notice" className="mt-3 flex items-center gap-2 p-2.5 bg-blue-50 dark:bg-blue-500/15 border border-blue-200 dark:border-blue-500/30 rounded-lg text-xs text-blue-800 dark:text-blue-200">
      <AtSign className="w-3.5 h-3.5 flex-shrink-0 text-blue-500" aria-hidden="true" />
      <span className="min-w-0 flex-1">{text}</span>
      {last?.entryId && onJump && (
        <button type="button" onClick={() => onJump(last.entryId)} className="tp-focus-ring font-semibold underline-offset-2 hover:underline">
          Show the note
        </button>
      )}
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="tp-focus-ring rounded p-0.5 hover:bg-blue-100 dark:hover:bg-blue-500/20">
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
