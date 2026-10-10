import { urgentResponseAPI } from '../../services/api';
import { ConfirmDialog } from '../knowledge/knowledgeUi';
import { coverCommitment, formatOnCallRange } from '../../utils/onCallFormat';

/**
 * Cover requests addressed to the signed-in person, shared by the /on-call
 * page and the app-wide prompt (plans/URGENT_RESPONSE_PLAN.md): one way to
 * answer, one confirm, and one signal so both follow each other.
 */

export const COVER_CHANGED_EVENT = 'tp:on-call-cover-changed';

export function announceCoverChange() {
  try { window.dispatchEvent(new Event(COVER_CHANGED_EVENT)); } catch { /* no window */ }
}

/**
 * Answer a request. Never throws.
 * @returns {Promise<{ outcome: 'accepted' | 'declined' | 'taken' | 'error', message?: string, data?: object }>}
 */
export async function answerCoverRequest(request, answer) {
  try {
    const res = await urgentResponseAPI.respondCoverRequest(request.id, answer);
    announceCoverChange();
    return { outcome: answer === 'accept' ? 'accepted' : 'declined', data: res?.data || null };
  } catch (err) {
    // 409: somebody else was first (or the request was withdrawn).
    if (err?.status === 409) {
      announceCoverChange();
      return { outcome: 'taken' };
    }
    return { outcome: 'error', message: err?.message || 'Could not send your answer. Try again.' };
  }
}

/** "Andrew Fong needs on-call cover from Thu 15 Oct to Mon 19 Oct." */
export function coverRequestSentence(request, timeZone) {
  const who = request?.original?.name || 'A colleague';
  return `${who} needs on-call cover from ${formatOnCallRange(request.startsAt, request.endsAt, timeZone || request.timezone)}.`;
}

/** The one confirm before taking a cover: says exactly what is agreed to. */
export function TakeCoverDialog({ request, timeZone, onConfirm, onCancel }) {
  return (
    <ConfirmDialog
      open={Boolean(request)}
      title={request?.original?.name ? `Cover on-call for ${request.original.name}?` : 'Take this on-call cover?'}
      confirmLabel="Take it"
      cancelLabel="Cancel"
      onConfirm={onConfirm}
      onCancel={onCancel}
      testId="take-cover-dialog"
    >
      {request ? coverCommitment(request, timeZone) : null}
    </ConfirmDialog>
  );
}
