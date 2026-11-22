import { AlertTriangle } from 'lucide-react';
import { REPLY_WARNING_TEXT, useReplyWarning } from './replyWarning';

/**
 * A quiet line above the reply composer when the requester does not read
 * replies (22 Nov 2026): a machine sender on the workspace's no-reply list, or
 * an unattended requester. Amber text with an icon, no pill, no block; the
 * check behind it lives in replyWarning.js (once per ticket open, cached).
 */
export default function ReplyAudienceWarning({ ticketId, unattended = false, hasRequester = true, enabled = true, show = true }) {
  const kind = useReplyWarning(ticketId, { unattended, hasRequester, enabled });
  if (!show || !kind) return null;
  return (
    <p
      role="note"
      data-testid="reply-audience-warning"
      data-kind={kind}
      className="mb-2 flex items-start gap-1.5 px-1 text-xs text-amber-800 dark:text-amber-200"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{REPLY_WARNING_TEXT[kind]}</span>
    </p>
  );
}
