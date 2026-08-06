import { useState } from 'react';
import { Check, Copy, ExternalLink, ListFilter, Pencil, Sparkles } from 'lucide-react';
import { formatDayTime, timeAgo } from './ticketUi';

/**
 * Workflow-written "Field Card" notes (custom-fields activation Phase 1).
 *
 * Thread entries whose `rawPayload.kind === 'field_card'` carry a structured
 * payload — { v, title, intro, accent, fields:[{key,label,type,value}],
 * workflowId, runId, workflowName } — written by the add_note workflow action
 * as a system note. This renders them as a real React card (approval-card
 * visual family), never as sanitized HTML soup.
 *
 * `fields[].value` is the SNAPSHOT the workflow saw at write time. When the
 * ticket's current customFields differ, the card overlays the live value with
 * a dashed underline + "Updated since this note" tooltip (snapshot preserved
 * in the tooltip).
 */

// Phase 2 (live): field chips carry a "Filter queue by this value" action
// navigating to /tickets?cf_<key>=<value> — the queue's cf_* filter grammar.
export const CF_FILTERING_ENABLED = true;

const ACCENT_TONES = {
  violet: { bar: 'bg-violet-500', wrap: 'bg-violet-50/60 border-violet-200', icon: 'text-violet-500', chip: 'bg-violet-100 text-violet-700 border-violet-200' },
  blue: { bar: 'bg-blue-500', wrap: 'bg-blue-50/60 border-blue-200', icon: 'text-blue-500', chip: 'bg-blue-100 text-blue-700 border-blue-200' },
  emerald: { bar: 'bg-emerald-500', wrap: 'bg-emerald-50/60 border-emerald-200', icon: 'text-emerald-500', chip: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  amber: { bar: 'bg-amber-500', wrap: 'bg-amber-50/60 border-amber-200', icon: 'text-amber-500', chip: 'bg-amber-100 text-amber-700 border-amber-200' },
  slate: { bar: 'bg-slate-400', wrap: 'bg-slate-50/80 border-slate-200', icon: 'text-slate-500', chip: 'bg-slate-100 text-slate-600 border-slate-200' },
};

export const FIELD_CARD_ACCENTS = Object.keys(ACCENT_TONES);

export function accentTones(accent) {
  return ACCENT_TONES[accent] || ACCENT_TONES.violet;
}

/** Structured payload if this thread entry is a field card, else null. */
export function fieldCardPayload(entry) {
  const payload = entry?.rawPayload;
  return payload && payload.kind === 'field_card' ? payload : null;
}

const isUrlValue = (v) => typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim());
const isEmpty = (v) => v === null || v === undefined || v === '';
const norm = (v) => (v === null || v === undefined ? '' : String(v));

/** Human rendering of a field value (dates through the shared formatter). */
function formatFieldValue(type, value) {
  if (isEmpty(value)) return '';
  if (type === 'boolean') return value === true || value === 'true' ? 'Yes' : 'No';
  if (type === 'date') return formatDayTime(value);
  return String(value);
}

/**
 * One interactive field value: copy-on-click for text/number/date, external
 * link for URLs, Yes/No pill for booleans — plus the live-value overlay when
 * the ticket's current value has drifted from the snapshot.
 */
export function FieldValueChip({ field, currentValues = null, onCopied = null, compact = false }) {
  const [copied, setCopied] = useState(false);
  const hasCurrent = Boolean(currentValues) && Object.prototype.hasOwnProperty.call(currentValues, field.key);
  const changed = hasCurrent && norm(currentValues[field.key]) !== norm(field.value);
  const shown = changed ? currentValues[field.key] : field.value;
  const overlayTitle = changed
    ? `Updated since this note — was: ${formatFieldValue(field.type, field.value) || '—'}`
    : undefined;
  const overlayCls = changed ? 'underline decoration-dashed decoration-slate-400 underline-offset-2' : '';
  const textSize = compact ? 'text-[11px]' : 'text-sm';

  if (isEmpty(shown)) {
    return <span className={`${textSize} text-slate-300 ${overlayCls}`} title={overlayTitle} data-changed={changed || undefined}>—</span>;
  }

  if (field.type === 'boolean') {
    const yes = shown === true || shown === 'true';
    return (
      <span title={overlayTitle} data-changed={changed || undefined} className={overlayCls ? 'inline-flex' : undefined}>
        <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold border ${
          yes ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-500 border-slate-200'
        } ${overlayCls}`}
        >
          {yes ? 'Yes' : 'No'}
        </span>
      </span>
    );
  }

  if (isUrlValue(shown)) {
    const href = String(shown).trim();
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={overlayTitle ? `${href} — ${overlayTitle}` : href}
        aria-label={`${field.label || field.key} (opens in a new tab)`}
        data-changed={changed || undefined}
        className={`tp-focus-ring inline-flex max-w-full items-center gap-1 rounded ${textSize} text-blue-600 hover:text-blue-700 hover:underline`}
      >
        <span className={`truncate ${compact ? 'max-w-[160px]' : 'max-w-[240px]'} ${overlayCls}`}>{href.replace(/^https?:\/\//i, '')}</span>
        <ExternalLink className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
      </a>
    );
  }

  const display = formatFieldValue(field.type, shown);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(display);
    } catch { /* clipboard unavailable — the visual feedback still confirms intent */ }
    setCopied(true);
    onCopied?.();
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? 'Copied' : 'Click to copy'}
      className={`tp-focus-ring group/chip inline-flex max-w-full items-center gap-1 rounded text-left ${textSize} text-slate-700 hover:text-slate-900`}
    >
      <span className={`truncate ${overlayCls}`} title={overlayTitle} data-changed={changed || undefined}>{display}</span>
      {copied
        ? <Check className="w-3 h-3 flex-shrink-0 text-emerald-500" aria-hidden="true" />
        : <Copy className="w-3 h-3 flex-shrink-0 text-slate-300 opacity-0 group-hover/chip:opacity-100 transition-opacity" aria-hidden="true" />}
    </button>
  );
}

/**
 * The Field Card itself, dispatched from the conversation renderer by the
 * structured discriminator (keeps its timeline position). `as="div"` renders
 * a non-list variant for previews outside a thread <ul>.
 */
export default function FieldCardNote({
  entry, currentValues = null, onEditField = null, onCopied = null, as = 'li',
  // Router hosts (TicketDetail) pass a SPA navigate; the default hard-navigates
  // so the card stays usable outside a Router context (builder preview).
  onFilterNavigate = (url) => window.location.assign(url),
}) {
  const payload = fieldCardPayload(entry) || {};
  const tones = accentTones(payload.accent);
  const fields = Array.isArray(payload.fields) ? payload.fields : [];
  const title = payload.title || 'Ticket details';

  const card = (
    <div
      className={`relative w-full max-w-[92%] overflow-hidden rounded-2xl border ${tones.wrap} pl-4 pr-3.5 py-3 shadow-subtle`}
      data-testid="field-card-note"
    >
      <span className={`absolute inset-y-0 left-0 w-1.5 ${tones.bar}`} aria-hidden="true" />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Sparkles className={`w-3.5 h-3.5 ${tones.icon}`} aria-hidden="true" />
        <span className="text-sm font-bold text-slate-800">{title}</span>
        <span className={`inline-flex items-center gap-1 text-[10px] font-semibold rounded-full px-1.5 py-0.5 border ${tones.chip}`}>
          {payload.workflowName ? `via ${payload.workflowName} · Auto` : 'Auto'}
        </span>
        {entry?.occurredAt && (
          <span className="ml-auto text-xs text-slate-400 whitespace-nowrap" title={new Date(entry.occurredAt).toLocaleString()}>
            {timeAgo(entry.occurredAt)}
          </span>
        )}
      </div>
      {payload.intro && <p className="mt-1 text-xs text-slate-500 break-words">{payload.intro}</p>}
      {fields.length > 0 && (
        <dl className="mt-2.5 grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-2">
          {fields.map((field) => (
            <div key={field.key} className="min-w-0">
              <dt className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                <span className="truncate">{field.label || field.key}</span>
                {onEditField && (
                  <button
                    type="button"
                    onClick={() => onEditField(field.key)}
                    aria-label={`Edit ${field.label || field.key}`}
                    title="Edit in the ticket's custom fields"
                    className="tp-focus-ring p-0.5 rounded text-slate-300 hover:text-slate-600 flex-shrink-0"
                  >
                    <Pencil className="w-3 h-3" aria-hidden="true" />
                  </button>
                )}
                {CF_FILTERING_ENABLED && !isEmpty(field.value) && (
                  <button
                    type="button"
                    onClick={() => {
                      const current = currentValues && Object.prototype.hasOwnProperty.call(currentValues, field.key)
                        ? currentValues[field.key] : field.value;
                      onFilterNavigate(`/tickets?cf_${encodeURIComponent(field.key)}=${encodeURIComponent(String(current))}`);
                    }}
                    aria-label={`Filter queue by ${field.label || field.key}`}
                    title="Filter queue by this value"
                    className="tp-focus-ring p-0.5 rounded text-slate-300 hover:text-slate-600 flex-shrink-0"
                  >
                    <ListFilter className="w-3 h-3" aria-hidden="true" />
                  </button>
                )}
              </dt>
              <dd className="mt-0.5 min-w-0">
                <FieldValueChip field={field} currentValues={currentValues} onCopied={onCopied} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );

  if (as === 'div') return <div className="flex justify-center">{card}</div>;
  return <li className="flex justify-center">{card}</li>;
}
