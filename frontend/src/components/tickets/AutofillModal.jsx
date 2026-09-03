import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, AlertCircle, ArrowLeft, Building2, Check, ImagePlus, ShieldCheck, Sparkles, UserRound, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import RichTextEditor, { sanitizeRichHtml } from './RichTextEditor';
import StagedFileChip from './StagedFileChip';
import ImageMarkupModal from './ImageMarkupModal';
import { PRIORITY_LABELS, formatBytes } from './ticketUi';
import { downscaleAll } from '../../utils/imageDownscale';

/**
 * Autofill intake (Mega 08-31 Phase AF, QA #2).
 *
 * The agent pastes ANYTHING — a Teams thread, a forwarded Outlook mail,
 * screenshots via Ctrl+V or drag-drop — and the AI proposes the ticket
 * fields. Every proposal is reviewed per field (checkbox + confidence chip)
 * before "Apply to form" hands it to TicketCreate; nothing is ever created
 * from here. Output is PROPOSED, never auto-submitted.
 *
 * Three zones on compose: (a) the shared RichTextEditor (it already stages
 * pasted images through onImagePaste and scrubs Office HTML) inside a
 * drop-target wrapper + a paperclip picker; (b) the staged-screenshot strip
 * with click-to-mark-up so anything sensitive is redacted BEFORE it leaves the
 * browser; (c) the caps with live counters. Images are downscaled client-side
 * (utils/imageDownscale) for the upload only — the originals are what the
 * host stages as ticket attachments.
 */

// Mirrors the route's multer/text caps (tickets.routes.js autofill-extract).
export const AUTOFILL_CAPS = Object.freeze({
  maxImages: 6,
  maxImageBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxTextChars: 20000,
  maxNotesChars: 2000,
});

export const AUTOFILL_FIELDS = [
  { key: 'subject', label: 'Subject', valueKey: 'subject', confKey: 'subject' },
  { key: 'description', label: 'Description', valueKey: 'descriptionHtml', confKey: 'description' },
  { key: 'requester', label: 'Requester', valueKey: 'requesterNameOrEmail', confKey: 'requester' },
  { key: 'category', label: 'Category', valueKey: 'categoryHint', confKey: 'category' },
  { key: 'priority', label: 'Priority', valueKey: 'priorityHint', confKey: 'priority' },
  { key: 'type', label: 'Type', valueKey: 'typeHint', confKey: 'type' },
  { key: 'assignee', label: 'Assignee', valueKey: 'assigneeMatch', confKey: 'assignee' },
];

/**
 * The value a review row is about (v2 shape, tolerant of the v1 one):
 * description → the structured HTML, falling back to the plain text or the
 * old narrative string; assignee → the matched technician's name (or the
 * hint's, when only a hint came back); everything else is a plain field.
 */
export function fieldValue(data, field) {
  if (!data) return null;
  if (field.key === 'description') {
    if (typeof data.descriptionHtml === 'string' && data.descriptionHtml.trim()) return data.descriptionHtml;
    if (typeof data.descriptionText === 'string' && data.descriptionText.trim()) return data.descriptionText;
    return typeof data.description === 'string' ? data.description : null;
  }
  if (field.key === 'assignee') {
    return data.assigneeMatch?.technician?.name || data.assigneeHint?.name || null;
  }
  return data[field.valueKey];
}

const matchStatus = (m) => (m && typeof m === 'object' ? String(m.status || 'none') : 'none');

/** 0..1 → high (≥0.75) / medium (≥0.5) / low. Rows pre-check at ≥0.5. */
export function confidenceTier(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'low';
  if (n >= 0.75) return 'high';
  if (n >= 0.5) return 'medium';
  return 'low';
}

const TIER_CHIP = {
  high: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-200 dark:border-emerald-500/30',
  medium: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/30',
  low: 'bg-muted text-muted-foreground border-border',
};

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[contenteditable="true"],[tabindex]:not([tabindex="-1"])';

const hasValue = (v) => v !== null && v !== undefined && String(v).trim() !== '';

/** Case-insensitive name match helper shared with the host (exported for it). */
export function matchByName(hint, names) {
  if (!hasValue(hint) || !Array.isArray(names)) return null;
  const needle = String(hint).trim().toLowerCase();
  return names.find((n) => String(n).trim().toLowerCase() === needle) ?? null;
}

function errorMessageFor(err) {
  const status = err?.response?.status;
  const serverMsg = err?.response?.data?.message;
  if (status === 429) return 'Slow down — try again in a minute.';
  if (status === 503) return 'No AI provider configured for this workspace — Settings → AI Providers.';
  if (status === 400 || status === 413) return serverMsg || 'That paste is over the limits — trim the text or drop a screenshot.';
  return serverMsg || err?.message || 'Could not read the paste — try again.';
}

export default function AutofillModal({
  open,
  onClose,
  onApply,
  /** Field keys the host will keep as-is (already filled by the agent). */
  lockedFields = [],
  /** Workspace vocabularies so the review can flag hints with no match. */
  categoryNames = [],
  typeNames = [],
}) {
  const [stage, setStage] = useState('compose'); // compose | loading | result
  const [dumpHtml, setDumpHtml] = useState('');
  const [dumpText, setDumpText] = useState('');
  const [notes, setNotes] = useState(''); // AF3: the technician's own instructions (authoritative)
  const [staged, setStaged] = useState([]); // [{ id, file }]
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [result, setResult] = useState(null);
  const [meta, setMeta] = useState(null);
  const [selected, setSelected] = useState({});
  const [editId, setEditId] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const dialogRef = useRef(null);
  const fileInputRef = useRef(null);
  const counterRef = useRef(0);
  const aliveRef = useRef(true);
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  const locked = useMemo(() => new Set(lockedFields), [lockedFields]);

  // Focus management: move in on open, return to the trigger on close.
  useEffect(() => {
    if (!open) return undefined;
    aliveRef.current = true;
    const previous = typeof document !== 'undefined' ? document.activeElement : null;
    const t = setTimeout(() => dialogRef.current?.focus(), 0);
    return () => {
      aliveRef.current = false;
      clearTimeout(t);
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, [open]);

  // Escape closes (unless the markup editor is on top); Tab cycles inside.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && editId === null) { e.stopPropagation(); onClose?.(); return; }
      if (e.key !== 'Tab' || !dialogRef.current || editId !== null) return;
      const nodes = Array.from(dialogRef.current.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, editId]);

  const totalBytes = staged.reduce((sum, s) => sum + (s.file.size || 0), 0);
  const textChars = dumpText.length;
  const overText = textChars > AUTOFILL_CAPS.maxTextChars;
  const hasMaterial = dumpText.trim().length > 0 || staged.length > 0;

  /**
   * Stage one image from paste / drop / picker. Returns the label the editor
   * drops at the caret, or null when the caps reject it (the editor then
   * inserts nothing). Caps are enforced on the ORIGINAL bytes so the
   * counters always mean what they say.
   */
  const stageDumpImage = useCallback((file) => {
    if (!file || !(file.type || '').startsWith('image/')) {
      setError('Only images can be sent for autofill — attach other files on the form itself.');
      return null;
    }
    const current = stagedRef.current;
    if (current.length >= AUTOFILL_CAPS.maxImages) {
      setError(`Up to ${AUTOFILL_CAPS.maxImages} screenshots per autofill — remove one to add another.`);
      return null;
    }
    if (file.size > AUTOFILL_CAPS.maxImageBytes) {
      setError(`"${file.name || 'image'}" is ${formatBytes(file.size)} — each screenshot must be under ${formatBytes(AUTOFILL_CAPS.maxImageBytes)}.`);
      return null;
    }
    const running = current.reduce((sum, s) => sum + (s.file.size || 0), 0);
    if (running + file.size > AUTOFILL_CAPS.maxTotalBytes) {
      setError(`That would push the screenshots past ${formatBytes(AUTOFILL_CAPS.maxTotalBytes)} in total.`);
      return null;
    }
    const ext = ((file.type || 'image/png').split('/')[1] || 'png').replace('jpeg', 'jpg');
    const name = /^screenshot-\d+\./.test(file.name || '') ? file.name : `screenshot-${++counterRef.current}.${ext}`;
    const named = file.name === name ? file : new File([file], name, { type: file.type || 'image/png' });
    const entry = { id: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, file: named };
    stagedRef.current = [...current, entry];
    setStaged(stagedRef.current);
    setError(null);
    return name;
  }, []);

  const stageMany = (list) => {
    const files = Array.from(list || []).filter((f) => (f.type || '').startsWith('image/'));
    if (!files.length && list?.length) {
      setError('Only images can be sent for autofill — attach other files on the form itself.');
      return;
    }
    for (const f of files) { if (stageDumpImage(f) === null) break; }
  };

  const removeStaged = (id) => {
    stagedRef.current = stagedRef.current.filter((s) => s.id !== id);
    setStaged(stagedRef.current);
    setError(null);
  };

  const reset = () => {
    setStage('compose');
    setResult(null);
    setMeta(null);
    setSelected({});
    setError(null);
    setExpanded(false);
  };

  const close = () => { onClose?.(); };

  const extract = async () => {
    if (!hasMaterial || overText) return;
    setError(null);
    setStage('loading');
    try {
      const prepared = await downscaleAll(staged.map((s) => s.file));
      const res = await ticketsAPI.autofillExtract(dumpText.slice(0, AUTOFILL_CAPS.maxTextChars), prepared, notes.trim());
      if (!aliveRef.current) return;
      // The API client unwraps axios responses to the JSON envelope; tolerate a raw axios response too.
      const body = res && res.data && res.data.data !== undefined ? res.data : (res || {});
      const data = body.data || {};
      const nextSelected = {};
      const fromNotes = Array.isArray(data.notesApplied) ? data.notesApplied : [];
      for (const f of AUTOFILL_FIELDS) {
        const value = fieldValue(data, f);
        let ok = hasValue(value) && !locked.has(f.key) && confidenceTier(data.confidence?.[f.confKey]) !== 'low';
        // AF3: a value the technician's own notes set is ticked whatever the
        // model's confidence — it is what they asked for (vocabulary still applies).
        if (!ok && hasValue(value) && !locked.has(f.key) && fromNotes.includes(f.key) && !['requester', 'assignee'].includes(f.key)) ok = true;
        if (ok && f.key === 'category' && categoryNames.length && !matchByName(value, categoryNames)) ok = false;
        if (ok && f.key === 'type' && typeNames.length && !matchByName(value, typeNames)) ok = false;
        if (ok && f.key === 'priority' && !(Number(value) >= 1 && Number(value) <= 4)) ok = false;
        if (f.key === 'requester' && !locked.has(f.key) && hasValue(value)) {
          // The server already resolved the person: a clean match is ticked
          // regardless of the name's confidence; an ambiguous one never is.
          const status = matchStatus(data.requesterMatch);
          if (status === 'matched' && data.requesterMatch?.candidate?.email) ok = true;
          else if (status === 'ambiguous') ok = false;
        }
        if (f.key === 'assignee') {
          // Only a clean technician match may pre-tick — and only when the
          // model is at least medium-sure the chat really named the handler.
          ok = ok && matchStatus(data.assigneeMatch) === 'matched' && Boolean(data.assigneeMatch?.technician?.id);
        }
        nextSelected[f.key] = ok;
      }
      setResult(data);
      setMeta(body.meta || null);
      setSelected(nextSelected);
      setStage('result');
    } catch (err) {
      if (!aliveRef.current) return;
      setError(errorMessageFor(err));
      setStage('compose');
    }
  };

  const apply = () => {
    if (!result) return;
    const picks = Object.fromEntries(Object.entries(selected).filter(([, v]) => v));
    onApply?.({
      result,
      meta,
      selected: picks,
      sourceHtml: dumpHtml,
      sourceText: dumpText,
      files: staged.map((s) => s.file),
    });
  };

  if (!open || typeof document === 'undefined') return null;

  const anySelected = Object.values(selected).some(Boolean);
  const editing = editId !== null ? staged.find((s) => s.id === editId) : null;

  const renderValue = (field, value) => {
    if (!hasValue(value)) {
      return <span className="italic text-muted-foreground/75">{field.key === 'assignee' ? 'Not named in the material' : 'Not found in the material'}</span>;
    }
    if (field.key === 'priority') {
      const n = Number(value);
      return PRIORITY_LABELS[n] ? `${PRIORITY_LABELS[n]} (P${n})` : String(value);
    }
    if (field.key === 'description') {
      const isHtml = typeof result?.descriptionHtml === 'string' && result.descriptionHtml.trim() !== '';
      const text = String(isHtml ? (result.descriptionText || '') : value);
      const long = (isHtml ? Math.max(text.length, value.length / 2) : text.length) > 360;
      const discussed = Array.isArray(result?.description?.discussedWith)
        ? result.description.discussedWith.filter((d) => d && d.name)
        : [];
      return (
        <>
          {isHtml ? (
            <div
              data-testid="autofill-description-html"
              className={`break-words [&_p]:my-0.5 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0 ${expanded || !long ? '' : 'max-h-28 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]'}`}
              // Server-built structured HTML, passed through the composer's
              // sanitizer (same allow-list the description field uses).
              dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(value) }}
            />
          ) : (
            <span className={`whitespace-pre-wrap break-words ${expanded || !long ? '' : 'line-clamp-4'}`}>{text}</span>
          )}
          {/* The server-rendered HTML already carries the 'Discussed with' line — only add it for the text fallback. */}
          {!value && discussed.length > 0 && (expanded || !long) && (
            <p className="mt-1 text-[11px] text-muted-foreground" data-testid="autofill-discussed-with">
              <span className="font-semibold text-foreground/85">Discussed with:</span>{' '}
              {discussed.map((d) => [d.name, d.role ? `(${d.role})` : null, d.channel ? `via ${d.channel}` : null, d.when || null].filter(Boolean).join(' ')).join(' · ')}
            </p>
          )}
          {long && (
            <button type="button" onClick={() => setExpanded((v) => !v)} className="tp-focus-ring mt-1 block text-[11px] font-semibold text-indigo-600 dark:text-indigo-300 hover:underline rounded">
              {expanded ? 'Show less' : 'Show all'}
            </button>
          )}
        </>
      );
    }
    if (field.key === 'requester') {
      const match = result?.requesterMatch;
      const status = matchStatus(match);
      if (status === 'matched' && match.candidate?.email) {
        const c = match.candidate;
        const fromDirectory = c.source === 'directory';
        return (
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5" data-testid="autofill-requester-match">
            <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full flex-shrink-0 ${fromDirectory ? 'bg-violet-50 dark:bg-violet-500/15 text-violet-700 dark:text-violet-200' : 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-200'}`} aria-hidden="true">
              {fromDirectory ? <Building2 className="w-3.5 h-3.5" /> : <UserRound className="w-3.5 h-3.5" />}
            </span>
            <span className="font-medium">{c.name || c.email}</span>
            {c.name && <span className="text-muted-foreground">· {c.email}</span>}
            <span className="text-[11px] text-muted-foreground/75">· matched from {fromDirectory ? 'the directory' : 'known requesters'}</span>
          </span>
        );
      }
      if (status === 'ambiguous') {
        const n = Array.isArray(match.candidates) ? match.candidates.length : 0;
        return (
          <span data-testid="autofill-requester-match">
            <span className="break-words">{String(value)}</span>
            <span className="ml-2 text-muted-foreground">{' '}— {n > 0 ? `${n} people match` : 'several people match'} — pick on the form</span>
          </span>
        );
      }
      return <span className="break-words">{String(value)}</span>;
    }
    if (field.key === 'assignee') {
      const match = result?.assigneeMatch;
      const status = matchStatus(match);
      const reason = result?.assigneeHint?.reason || match?.reason || null;
      if (status === 'matched' && match.technician) {
        return (
          <span data-testid="autofill-assignee-match">
            <span className="font-medium">{match.technician.name}</span>
            {reason && <span className="text-muted-foreground"> — from: “{reason}”</span>}
          </span>
        );
      }
      if (status === 'ambiguous') {
        const names = (Array.isArray(match.candidates) ? match.candidates : []).map((t) => t?.name).filter(Boolean);
        return (
          <span data-testid="autofill-assignee-match">
            <span className="break-words">{String(value)}</span>
            <span className="ml-2 text-muted-foreground">{' '}— could be {names.length ? names.join(', ') : 'more than one member'} — pick on the form</span>
          </span>
        );
      }
      return <span className="break-words">{String(value)}</span>;
    }
    return <span className="break-words">{String(value)}</span>;
  };

  const rowCaption = (field, value) => {
    if (locked.has(field.key)) return 'You already filled this in — kept as is.';
    if (!hasValue(value)) return null;
    if (field.key === 'category' && categoryNames.length && !matchByName(value, categoryNames)) return 'No matching category in this workspace — skipped.';
    if (field.key === 'category' && result?.categoryLevel === 'top') return 'Category only — pick a subcategory on the form.';
    if (field.key === 'type' && typeNames.length && !matchByName(value, typeNames)) return 'No matching type in this workspace — skipped.';
    if (field.key === 'priority' && !(Number(value) >= 1 && Number(value) <= 4)) return 'Not a priority this workspace uses — skipped.';
    if (field.key === 'requester') {
      const status = matchStatus(result?.requesterMatch);
      if (status === 'matched' && result.requesterMatch?.candidate?.email) return 'Selected on the form the moment you apply — no search needed.';
      if (status === 'ambiguous') return 'The search opens pre-filled so you can pick the right person.';
      return 'Matched against known requesters on apply — a fuzzy name opens the search for you to confirm.';
    }
    if (field.key === 'assignee') {
      const status = matchStatus(result?.assigneeMatch);
      if (status === 'matched' && result.assigneeMatch?.technician?.id) return 'Sets “Assign to…” on the form — AI assignment stays off.';
      if (status === 'ambiguous') return 'Nobody is set — choose the member under Assignment.';
      return 'No workspace member matches that name — choose under Assignment.';
    }
    if (field.key === 'description') return 'The pasted source material is appended under this summary so nothing is lost.';
    return null;
  };

  const rowDisabled = (field, value) => {
    if (locked.has(field.key) || !hasValue(value)) return true;
    if (field.key === 'category' && categoryNames.length && !matchByName(value, categoryNames)) return true;
    if (field.key === 'type' && typeNames.length && !matchByName(value, typeNames)) return true;
    if (field.key === 'priority' && !(Number(value) >= 1 && Number(value) <= 4)) return true;
    if (field.key === 'assignee' && !(matchStatus(result?.assigneeMatch) === 'matched' && result?.assigneeMatch?.technician?.id)) return true;
    return false;
  };

  const people = Array.isArray(result?.peopleMentioned) ? result.peopleMentioned.filter((p) => p && (p.name || p.email)) : [];
  // "Run #123 · claude-sonnet-5 · 7.5 s" — discreet, but there when the
  // agent wants to know what read the paste (and to find it again later).
  const runStamp = [
    meta?.runId != null ? `Run #${meta.runId}` : null,
    meta?.model || null,
    Number.isFinite(Number(meta?.durationMs)) && meta?.durationMs != null ? `${(Number(meta.durationMs) / 1000).toFixed(1)} s` : null,
  ].filter(Boolean).join(' · ');

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-6">
      <button
        type="button"
        aria-label="Close autofill"
        onClick={close}
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px] animate-fadeIn cursor-default"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="autofill-title"
        aria-describedby="autofill-intro"
        tabIndex={-1}
        className="tp-focus-ring relative w-full sm:max-w-3xl max-h-[94vh] sm:max-h-[90vh] flex flex-col tp-card rounded-t-2xl sm:rounded-2xl shadow-soft overflow-hidden animate-scaleIn"
      >
        <header className="flex items-center gap-3 px-4 sm:px-5 py-3 border-b border-border/60 bg-gradient-to-r from-indigo-50/80 dark:from-indigo-500/10 via-card to-card">
          <span className="h-8 w-8 rounded-lg bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 inline-flex items-center justify-center flex-shrink-0">
            <Sparkles className="w-4 h-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="autofill-title" className="text-sm font-bold text-foreground leading-tight">Autofill from a paste</h2>
            <p id="autofill-intro" className="text-xs text-muted-foreground/75 truncate">
              {stage === 'result' ? 'Review each proposal — only ticked rows reach the form.' : 'Teams chat, forwarded email, screenshots — the AI drafts the fields, you decide.'}
            </p>
          </div>
          <button type="button" onClick={close} aria-label="Close" className="tp-focus-ring rounded-lg p-1.5 text-muted-foreground/75 hover:text-foreground/85 hover:bg-muted/50">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto settings-scrollbar px-4 sm:px-5 py-4">
          {stage === 'compose' && (
            <div className="space-y-3">
              {/* (a) paste / drop zone */}
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); stageMany(e.dataTransfer?.files); }}
                data-testid="autofill-dropzone"
                className={`rounded-xl transition-colors ${dragOver ? 'ring-2 ring-indigo-300 dark:ring-indigo-500/40 bg-indigo-50/40 dark:bg-indigo-500/10' : ''}`}
              >
                <RichTextEditor
                  value={dumpHtml}
                  onChange={({ html, text }) => { setDumpHtml(html); setDumpText(text); }}
                  placeholder="Paste the chat, email or screenshots here (Ctrl+V) — or drop images onto this box."
                  ariaLabel="Pasted source material"
                  minHeight={280}
                  onImagePaste={stageDumpImage}
                />
              </div>

              {/* (a2) AF3 — the technician's own notes: authoritative, applied on top of the paste */}
              <div>
                <label htmlFor="autofill-notes" className="block text-xs font-semibold text-foreground/85">
                  Your notes for the AI <span className="font-normal text-muted-foreground/75">(optional — applied on top of the paste)</span>
                </label>
                <textarea
                  id="autofill-notes"
                  data-testid="autofill-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value.slice(0, AUTOFILL_CAPS.maxNotesChars))}
                  rows={2}
                  maxLength={AUTOFILL_CAPS.maxNotesChars}
                  placeholder="Anything the material doesn’t say — “make it urgent”, “he also needs a new laptop”, “Soheil will handle it”."
                  className="tp-focus-ring mt-1 w-full resize-y rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/75"
                />
              </div>

              {/* (c) caps + live counters */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground/75">
                <span className={overText ? 'font-semibold text-red-600 dark:text-red-300' : ''} aria-live="polite">
                  {textChars.toLocaleString()} / {AUTOFILL_CAPS.maxTextChars.toLocaleString()} characters
                </span>
                <span aria-hidden="true">·</span>
                <span>{staged.length} / {AUTOFILL_CAPS.maxImages} images</span>
                <span aria-hidden="true">·</span>
                <span>{formatBytes(totalBytes)} / {formatBytes(AUTOFILL_CAPS.maxTotalBytes)}</span>
                <span aria-hidden="true">·</span>
                <span>≤ {formatBytes(AUTOFILL_CAPS.maxImageBytes)} each</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => { stageMany(e.target.files); e.target.value = ''; }}
                  className="sr-only"
                  aria-label="Choose screenshots to send"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={staged.length >= AUTOFILL_CAPS.maxImages}
                  className="tp-focus-ring ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-semibold text-foreground/85 hover:bg-muted/50 disabled:opacity-50"
                >
                  <ImagePlus className="w-3.5 h-3.5" aria-hidden="true" /> Add screenshots
                </button>
              </div>

              {/* (b) staged strip + redact-before-send */}
              {staged.length > 0 && (
                <div className="rounded-xl border border-border bg-muted/30 p-3">
                  <ul className="flex flex-wrap gap-2.5 items-start" aria-label="Screenshots to send">
                    {staged.map((s) => (
                      <StagedFileChip
                        key={s.id}
                        file={s.file}
                        onRemove={() => removeStaged(s.id)}
                        onEdit={() => setEditId(s.id)}
                      />
                    ))}
                  </ul>
                  <p className="mt-2.5 flex items-start gap-1.5 text-[11px] text-muted-foreground">
                    <ShieldCheck className="w-3.5 h-3.5 mt-px flex-shrink-0 text-emerald-600 dark:text-emerald-300" aria-hidden="true" />
                    <span>Blur or crop anything sensitive before sending — screenshots go to the AI provider. Click a thumbnail to mark it up — the AI sees a shrunk copy, and the full-resolution version (with your markup) is what gets attached to the ticket.</span>
                  </p>
                </div>
              )}

              {error && (
                <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-xl" role="alert">
                  <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-300 mt-0.5 flex-shrink-0" aria-hidden="true" />
                  <span className="text-sm text-red-800 dark:text-red-200">{error}</span>
                </div>
              )}
            </div>
          )}

          {stage === 'loading' && (
            <div className="flex flex-col items-center justify-center py-16 text-center" role="status" aria-live="polite">
              <Activity className="w-7 h-7 animate-spin text-indigo-500" aria-hidden="true" />
              <p className="mt-3 text-sm font-semibold text-foreground">Reading your paste…</p>
              <p className="mt-1 text-xs text-muted-foreground/75">
                Usually 5–15 seconds.{staged.length > 0 ? ` ${staged.length} screenshot${staged.length === 1 ? '' : 's'} sent shrunk to 1568 px.` : ''}
              </p>
            </div>
          )}

          {stage === 'result' && result && (
            <div className="space-y-3">
              {result.technicianNotes && (
                <p className="text-xs text-violet-800 dark:text-violet-200 bg-violet-50 dark:bg-violet-500/10 border border-violet-200 dark:border-violet-500/20 rounded-lg px-3 py-2" data-testid="autofill-notes-used">
                  <span className="font-semibold">{result.notesDetected ? 'Treated as your notes' : 'Your notes'}:</span> “{result.technicianNotes}”
                  {result.notesDetected ? ' — typed next to the paste, so it was applied as your instruction rather than read as material.' : ''}
                </p>
              )}
              {hasValue(result.sourceSummary) && (
                <p className="text-xs text-muted-foreground flex items-start gap-1.5" data-testid="autofill-source-summary">
                  <Sparkles className="w-3.5 h-3.5 mt-px flex-shrink-0 text-indigo-500" aria-hidden="true" />
                  <span><span className="font-semibold text-foreground/85">Looks like:</span> {result.sourceSummary}</span>
                </p>
              )}
              <ul className="divide-y divide-border/60 rounded-xl border border-border overflow-hidden" aria-label="Proposed fields">
                {AUTOFILL_FIELDS.map((field) => {
                  const value = fieldValue(result, field);
                  const tier = confidenceTier(result.confidence?.[field.confKey]);
                  const disabled = rowDisabled(field, value);
                  const caption = rowCaption(field, value);
                  const id = `autofill-row-${field.key}`;
                  return (
                    <li key={field.key} className={`flex items-start gap-3 px-3 py-2.5 ${disabled ? 'bg-muted/30' : 'bg-card'}`} data-testid={id}>
                      <input
                        id={id}
                        type="checkbox"
                        checked={Boolean(selected[field.key])}
                        disabled={disabled}
                        onChange={(e) => setSelected((prev) => ({ ...prev, [field.key]: e.target.checked }))}
                        className="tp-focus-ring mt-1 h-4 w-4 rounded border-input text-indigo-600 dark:text-indigo-300 disabled:opacity-40"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <label htmlFor={id} className={`text-xs font-semibold ${disabled ? 'text-muted-foreground' : 'text-foreground/85'}`}>{field.label}</label>
                          {hasValue(value) && (
                            <span className={`inline-flex items-center rounded-full border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${TIER_CHIP[tier]}`} data-testid={`${id}-confidence`}>
                              {tier}
                            </span>
                          )}
                          {hasValue(value) && Array.isArray(result.notesApplied) && result.notesApplied.includes(field.key) && (
                            <span className="inline-flex items-center rounded-full border border-violet-200 dark:border-violet-500/30 bg-violet-50 dark:bg-violet-500/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-200" data-testid={`${id}-from-notes`}>
                              from your notes
                            </span>
                          )}
                        </div>
                        <div className={`mt-0.5 text-sm ${disabled ? 'text-muted-foreground' : 'text-foreground'}`}>{renderValue(field, value)}</div>
                        {caption && <p className="mt-0.5 text-[11px] text-muted-foreground/75">{caption}</p>}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {people.length > 0 && (
                <p className="text-[11px] text-muted-foreground" data-testid="autofill-people">
                  <span className="font-semibold text-foreground/85">Also mentioned:</span>{' '}
                  {people.map((p) => [p.name, p.email ? `<${p.email}>` : null, p.role ? `(${p.role})` : null].filter(Boolean).join(' ')).join(' · ')}
                  {' '}— add them under “Also for” on the form if they should get replies.
                </p>
              )}
              <p className="text-[11px] text-muted-foreground/75">
                Nothing is saved yet — Apply fills the form, and every field stays editable before you create the ticket.
              </p>
            </div>
          )}
        </div>

        <footer className="flex flex-col-reverse sm:flex-row sm:items-center gap-2 border-t border-border/60 px-4 sm:px-5 py-3 bg-card">
          {stage === 'result' ? (
            <>
              <button type="button" onClick={reset} className="tp-focus-ring inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted/50">
                <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back
              </button>
              {runStamp && (
                <span className="hidden sm:block text-[11px] text-muted-foreground/75 tabular-nums truncate" data-testid="autofill-run-stamp" title="This run is linked to the ticket once you create it — see AI & Routing on the ticket.">
                  {runStamp}
                </span>
              )}
              <span className="hidden sm:block flex-1" />
              <button type="button" onClick={close} className="tp-focus-ring rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted/50">Cancel</button>
              <button
                type="button"
                onClick={apply}
                disabled={!anySelected}
                className="tp-focus-ring inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-subtle hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                <Check className="w-4 h-4" aria-hidden="true" /> Apply to form
              </button>
            </>
          ) : (
            <>
              <p className="text-[11px] text-muted-foreground/75 sm:flex-1">
                Proposals only — nothing is created until you press Create ticket.
              </p>
              <button type="button" onClick={close} className="tp-focus-ring rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted/50">Cancel</button>
              <button
                type="button"
                onClick={extract}
                disabled={stage !== 'compose' || !hasMaterial || overText}
                className="tp-focus-ring inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-subtle hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                <Sparkles className="w-4 h-4" aria-hidden="true" /> Read &amp; propose fields
              </button>
            </>
          )}
        </footer>
      </div>

      {editing && (
        <ImageMarkupModal
          file={editing.file}
          onCancel={() => setEditId(null)}
          onSave={(edited) => {
            stagedRef.current = stagedRef.current.map((s) => (s.id === editing.id ? { ...s, file: edited } : s));
            setStaged(stagedRef.current);
            setEditId(null);
          }}
        />
      )}
    </div>,
    document.body,
  );
}
