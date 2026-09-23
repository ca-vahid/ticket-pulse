import { CheckCircle2, MessageCircleQuestion, ShieldCheck, XCircle } from 'lucide-react';
import { PersonAvatar, timeAgo } from './ticketUi';
import { useRequesterPhoto } from '../../hooks/useRequesterPhoto';
import { cleanNoteText } from '../../utils/noteText';

/**
 * An approval verdict in the ticket conversation (18 Sep 2026 redesign).
 *
 * Before: one fully tinted block with the whole sentence — verdict, condition and
 * the original ask — run together in bold coloured text, a status pill, and no
 * face. Dense, and everything shouted equally.
 *
 * Now: a neutral card. The approver's photo sits on the left; ONLY the verdict
 * words carry colour; the condition, the decision note and what was asked are
 * separate, labelled blocks in ordinary text with room to breathe.
 *
 * Entries written since v2 of the payload carry `rawPayload.parts`. Older ones
 * are one sentence, so `parseApprovalSentence` recovers the same parts from the
 * text; anything it cannot parse falls back to the plain body.
 */
const TONES = {
  approved: { Icon: CheckCircle2, text: 'text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-500', rule: 'bg-emerald-500' },
  rejected: { Icon: XCircle, text: 'text-red-700 dark:text-red-300', dot: 'bg-red-500', rule: 'bg-red-500' },
  clarification: { Icon: MessageCircleQuestion, text: 'text-violet-700 dark:text-violet-300', dot: 'bg-violet-500', rule: 'bg-violet-500' },
  requested: { Icon: ShieldCheck, text: 'text-blue-700 dark:text-blue-300', dot: 'bg-blue-500', rule: 'bg-blue-500' },
};

const unquote = (s) => String(s || '').trim().replace(/^["“]/, '').replace(/["”]$/, '').trim();

/** "Approval APPROVED WITH CONDITION ✔ by Name — "note" · Condition: "…" · Requested by x: "…"" → parts. */
export function parseApprovalSentence(text) {
  const t = String(text || '').trim();
  const m = t.match(/^Approval (CHANGED to )?(APPROVED WITH CONDITION|APPROVED|REJECTED)\s*[✔✓✘✗]?\s*by\s+([\s\S]+)$/i);
  if (!m) return null;
  let rest = m[3];
  const take = (re) => {
    const hit = rest.match(re);
    if (!hit) return null;
    rest = rest.slice(0, hit.index);
    return hit;
  };
  // Peel from the END: the asked-for quote, then the condition, then the note.
  const asked = take(/\s·\sRequested by\s+([^:]+):\s*([\s\S]+)$/);
  const condition = take(/\s·\sCondition:\s*([\s\S]+)$/);
  const note = take(/\s—\s([\s\S]+)$/);
  return {
    verdict: /REJECTED/i.test(m[2]) ? 'rejected' : 'approved',
    changed: Boolean(m[1]),
    actorName: rest.trim(),
    note: note ? unquote(note[1]) : null,
    condition: condition ? unquote(condition[1]) : null,
    requestedBy: asked ? asked[1].trim() : null,
    requestedByName: null,
    requestNote: asked ? unquote(asked[2]) : null,
  };
}

/**
 * "Approval requested · Category → a@x, b@x by Name · CAD 1200 — "note"" → parts
 * (23 Sep 2026). v1 payloads also carry category / approvers / note, which win.
 */
export function parseApprovalRequest(entry) {
  const raw = entry?.rawPayload || {};
  const text = String(entry?.bodyText || entry?.content || '').trim();
  const m = text.match(/^Approval requested\s*·\s*([\s\S]+?)\s*→\s*([\s\S]+?)\s+by\s+([\s\S]+?)(?:\s*·\s*([A-Z]{3}\s+[\d.,]+))?(?:\s+—\s+([\s\S]*))?$/);
  if (raw.kind === 'approval_event' && raw.event === 'requested') {
    return {
      category: raw.category || (m ? m[1].trim() : null),
      approvers: Array.isArray(raw.approvers) && raw.approvers.length ? raw.approvers : (m ? m[2].split(',').map((s) => s.trim()).filter(Boolean) : []),
      requesterName: entry?.actorName || (m ? m[3].trim() : null),
      amount: m && m[4] ? m[4] : null,
      note: cleanNoteText(raw.note || (m && m[5] ? unquote(m[5]) : '')) || null,
    };
  }
  if (!m) return null;
  return {
    category: m[1].trim(),
    approvers: m[2].split(',').map((s) => s.trim()).filter(Boolean),
    requesterName: entry?.actorName || m[3].trim(),
    amount: m[4] || null,
    note: cleanNoteText(m[5] ? unquote(m[5]) : '') || null,
  };
}

const prettyFromEmail = (v) => {
  const s = String(v || '');
  if (!s.includes('@')) return s;
  return s.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};

function Block({ label, labelClass = 'text-muted-foreground/75', children }) {
  return (
    <div className="mt-3.5">
      <p className={`text-[11px] font-semibold uppercase tracking-wide ${labelClass}`}>{label}</p>
      <div className="mt-1 text-[15px] leading-relaxed text-foreground/85 break-words">{children}</div>
    </div>
  );
}

export default function ApprovalEventCard({ entry, meta, body, nameForEmail = null }) {
  const request = meta?.label === 'Requested' ? parseApprovalRequest(entry) : null;
  const parsed = request ? null : (entry?.rawPayload?.parts || parseApprovalSentence(entry?.bodyText || entry?.content));
  // Every note reads as text: stored notes could carry "&nbsp;" and friends.
  const structured = parsed ? {
    ...parsed,
    note: cleanNoteText(parsed.note) || null,
    condition: cleanNoteText(parsed.condition) || null,
    requestNote: cleanNoteText(parsed.requestNote) || null,
  } : null;
  const toneKey = structured?.verdict
    // "Not approved" contains "approv" — test the negative FIRST or it reads as approved.
    || (/reject|not approved/i.test(meta?.label || '') ? 'rejected' : /clarif/i.test(meta?.label || '') ? 'clarification' : /approv/i.test(meta?.label || '') ? 'approved' : 'requested');
  const tone = TONES[toneKey] || TONES.requested;
  const photo = useRequesterPhoto(structured || request ? entry?.actorEmail : null);
  const personName = (email) => (typeof nameForEmail === 'function' && nameForEmail(email)) || prettyFromEmail(email);
  const when = (
    <span className="ml-auto text-xs text-muted-foreground/75 whitespace-nowrap" title={new Date(entry.occurredAt).toLocaleString()}>
      {timeAgo(entry.occurredAt)}
    </span>
  );

  // An approval request (23 Sep 2026): who asked, for what, of whom — and the
  // note as its own block, instead of one run-on sentence with raw entities.
  if (request) {
    const approverNames = request.approvers.map(personName).filter(Boolean);
    return (
      <li className="flex justify-center">
        <div className="relative w-full max-w-[92%] overflow-hidden rounded-2xl border border-border bg-card pl-5 pr-5 py-4 shadow-subtle" data-testid="approval-request-card">
          <span className={`absolute inset-y-0 left-0 w-1 ${tone.rule}`} aria-hidden="true" />
          <div className="flex items-start gap-3.5">
            <div className="relative flex-shrink-0">
              <PersonAvatar name={request.requesterName} photoUrl={typeof photo === 'string' ? photo : null} size="h-11 w-11" textSize="text-xs" />
              <span className={`absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full border-2 border-card ${tone.dot} flex items-center justify-center`}>
                <tone.Icon className="w-2.5 h-2.5 text-white" aria-hidden="true" />
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <p className="text-[15px] text-foreground">
                  <span className="font-semibold">{request.requesterName || 'Someone'}</span>{' '}
                  <span className={`font-semibold ${tone.text}`}>{meta?.label === 'Started' ? 'started an approval' : 'asked for approval'}</span>
                </p>
                {when}
              </div>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                {request.category && <span className="font-medium text-foreground/85">{request.category}</span>}
                {request.amount && <span> · {request.amount}</span>}
                {approverNames.length > 0 && <span> · to {approverNames.join(', ')}</span>}
              </p>
              {request.note && (
                <Block label="Request">
                  <span className="whitespace-pre-line">{request.note}</span>
                </Block>
              )}
            </div>
          </div>
        </div>
      </li>
    );
  }

  // Clarifications, starts and anything unparseable: the quiet one-paragraph form.
  if (!structured) {
    return (
      <li className="flex justify-center">
        <div className="relative w-full max-w-[92%] overflow-hidden rounded-2xl border border-border bg-card pl-5 pr-4 py-3.5 shadow-subtle">
          <span className={`absolute inset-y-0 left-0 w-1 ${tone.rule}`} aria-hidden="true" />
          <div className="flex items-center gap-2">
            <tone.Icon className={`w-4 h-4 ${tone.text}`} aria-hidden="true" />
            <span className={`text-sm font-semibold ${tone.text}`}>Approval · {meta?.label}</span>
            {when}
          </div>
          <p className="mt-1.5 text-[15px] leading-relaxed text-foreground/85 break-words whitespace-pre-line">{typeof body === 'string' ? cleanNoteText(body) : body}</p>
        </div>
      </li>
    );
  }

  const verdictWords = structured.verdict === 'rejected'
    ? 'Not approved'
    : structured.condition ? 'Approved with a condition' : 'Approved';
  const askedBy = structured.requestedByName || prettyFromEmail(structured.requestedBy) || 'the agent';
  return (
    <li className="flex justify-center">
      <div className="relative w-full max-w-[92%] overflow-hidden rounded-2xl border border-border bg-card pl-5 pr-5 py-4 shadow-subtle" data-testid="approval-event-card">
        <span className={`absolute inset-y-0 left-0 w-1 ${tone.rule}`} aria-hidden="true" />
        <div className="flex items-start gap-3.5">
          <div className="relative flex-shrink-0">
            <PersonAvatar name={structured.actorName} photoUrl={typeof photo === 'string' ? photo : null} size="h-11 w-11" textSize="text-xs" />
            <span className={`absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full border-2 border-card ${tone.dot} flex items-center justify-center`}>
              <tone.Icon className="w-2.5 h-2.5 text-white" aria-hidden="true" />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <p className="text-[15px] text-foreground">
                <span className={`font-semibold ${tone.text}`}>{structured.changed ? `Changed to ${verdictWords.toLowerCase()}` : verdictWords}</span>
                {' '}<span className="text-muted-foreground">by</span>{' '}
                <span className="font-semibold">{structured.actorName}</span>
              </p>
              {when}
            </div>
            <p className="text-xs text-muted-foreground/75 mt-0.5">Approval decision</p>

            {structured.condition && (
              <Block label="Condition" labelClass="text-amber-700 dark:text-amber-300">{structured.condition}</Block>
            )}
            {structured.note && <Block label="Decision note">{structured.note}</Block>}
            {typeof structured.requesterNotified === 'boolean' && (
              <p className="mt-2.5 text-[12px] text-muted-foreground" data-testid="requester-notified">
                {structured.requesterNotified ? 'E-mailed to the agents and the requester.' : 'E-mailed to the agents only — the requester was not copied.'}
              </p>
            )}
            {structured.requestNote && (
              <Block label={`Asked by ${askedBy}`}>
                <span className="text-muted-foreground">“{structured.requestNote}”</span>
              </Block>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
