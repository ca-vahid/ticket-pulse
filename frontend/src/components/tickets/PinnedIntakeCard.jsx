import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { FieldValueChip, accentTones } from './FieldCardNote';

/**
 * Pinned workflow field cards (custom-fields activation Phase 1).
 *
 * `ticket.pinnedCards` carries the ACTIVE cards a workflow pinned above the
 * conversation: [{ id, kind:'field_card', payload:<field_card shape>,
 * createdAt }]. This renders the compact variant of the Field Card grid —
 * chips inline-wrapped on an accent-tinted surface — so intake context stays
 * visible even after the thread folds older notes away.
 *
 * Dismiss is ticket-level (any agent) and one-way server-side, so instead of
 * an un-undoable undo toast the ✕ asks first via a small confirm popover.
 */
export default function PinnedIntakeCard({
  ticketId,
  cards = [],
  currentValues = null,
  canDismiss = false,
  onCopied = null,
  onDismissed = null,
}) {
  const [hiddenIds, setHiddenIds] = useState(() => new Set());
  const [confirmingId, setConfirmingId] = useState(null);
  const [error, setError] = useState(null);

  const active = (cards || []).filter((card) => card && card.kind === 'field_card' && !hiddenIds.has(card.id));
  if (active.length === 0) return null;

  const dismiss = async (card) => {
    setConfirmingId(null);
    setError(null);
    // Optimistic hide — the server marks it dismissed; on failure it returns.
    setHiddenIds((prev) => new Set(prev).add(card.id));
    try {
      await ticketsAPI.dismissPinnedCard(ticketId, card.id);
      onDismissed?.(card);
    } catch (e) {
      setHiddenIds((prev) => {
        const next = new Set(prev);
        next.delete(card.id);
        return next;
      });
      setError(e.response?.data?.message || e.message || 'Could not dismiss the card');
    }
  };

  return (
    <div className="mb-3 space-y-2" data-testid="pinned-intake-cards">
      {active.map((card) => {
        const payload = card.payload || {};
        const tones = accentTones(payload.accent);
        const fields = Array.isArray(payload.fields) ? payload.fields : [];
        return (
          <div
            key={card.id}
            className={`tp-surface relative overflow-visible rounded-xl border ${tones.wrap} pl-3.5 pr-3 py-2.5 animate-fadeIn`}
            data-testid="pinned-intake-card"
          >
            <span className={`absolute inset-y-0 left-0 w-1 rounded-l-xl ${tones.bar}`} aria-hidden="true" />
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Sparkles className={`w-3.5 h-3.5 ${tones.icon}`} aria-hidden="true" />
              <span className="text-xs font-bold text-foreground">{payload.title || 'Ticket details'}</span>
              <span className={`inline-flex items-center gap-1 text-[10px] font-semibold rounded-full px-1.5 py-0.5 border ${tones.chip}`}>
                {payload.workflowName ? `via ${payload.workflowName}` : 'Workflow'}
              </span>
              {canDismiss && (
                <span className="relative ml-auto">
                  <button
                    type="button"
                    onClick={() => setConfirmingId((cur) => (cur === card.id ? null : card.id))}
                    aria-label="Dismiss card"
                    title="Dismiss this card"
                    className="tp-focus-ring p-1 rounded text-muted-foreground/50 hover:text-muted-foreground hover:bg-card/70"
                  >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                  {confirmingId === card.id && (
                    <span
                      role="dialog"
                      aria-label="Confirm dismiss"
                      className="absolute right-0 top-7 z-20 block w-60 rounded-lg border border-border bg-card p-2.5 shadow-soft text-left"
                    >
                      <span className="block text-xs text-muted-foreground">
                        Dismiss this card? It won&apos;t return unless the workflow runs again.
                      </span>
                      <span className="mt-2 flex justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setConfirmingId(null)}
                          className="tp-focus-ring px-2 py-1 rounded-md text-[11px] font-medium text-muted-foreground hover:bg-muted"
                        >
                          Keep
                        </button>
                        <button
                          type="button"
                          onClick={() => dismiss(card)}
                          className="tp-focus-ring px-2 py-1 rounded-md bg-foreground text-[11px] font-semibold text-background hover:bg-foreground/90"
                        >
                          Dismiss
                        </button>
                      </span>
                    </span>
                  )}
                </span>
              )}
            </div>
            {payload.intro && <p className="mt-0.5 text-[11px] text-muted-foreground break-words">{payload.intro}</p>}
            {fields.length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {fields.map((field) => (
                  <span
                    key={field.key}
                    className="inline-flex max-w-full items-center gap-1 rounded-md border border-card/70 bg-card/70 px-1.5 py-0.5"
                  >
                    <span className="text-[11px] font-semibold text-muted-foreground whitespace-nowrap">{field.label || field.key}:</span>
                    <FieldValueChip field={field} currentValues={currentValues} onCopied={onCopied} compact />
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {error && <p className="text-[11px] text-red-500">{error}</p>}
    </div>
  );
}

/**
 * Single compact row for the peek preview's Details tab: chips only, no
 * dismiss, no edit affordances — a quick read of what the workflow captured.
 */
export function PinnedCardChipsRow({ cards = [], currentValues = null, onCopied = null }) {
  const active = (cards || []).filter((card) => card && card.kind === 'field_card');
  if (active.length === 0) return null;
  return (
    <div data-testid="pinned-card-chips-row">
      <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75 mb-1">
        Workflow card{active.length === 1 ? '' : 's'}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {active.map((card) => (Array.isArray(card.payload?.fields) ? card.payload.fields : []).map((field) => (
          <span
            key={`${card.id}-${field.key}`}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/50 px-1.5 py-0.5"
          >
            <span className="text-[11px] font-semibold text-muted-foreground whitespace-nowrap">{field.label || field.key}:</span>
            <FieldValueChip field={field} currentValues={currentValues} onCopied={onCopied} compact />
          </span>
        )))}
      </div>
    </div>
  );
}
