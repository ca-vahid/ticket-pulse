import { useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import { ticketsAPI } from '../../../services/api';
import { ASSIST_CHOICES, assistLabel, hasRichMarkup, plainToHtml } from '../../../utils/composerAssist';

/**
 * Writing help in the composer (Nov 2026). The person selects some of their
 * own draft (or takes all of it), picks one thing from the menu, and reads the
 * suggestion before anything changes: Replace, Add below, or Discard. Nothing
 * is put into the draft, saved or sent without that click, and after a replace
 * "Put my text back" restores the draft as it was.
 *
 * Returns the two pieces the composer places itself: `menu` (the button in the
 * footer) and `panel` (the suggestion, under the editor).
 */
export default function useComposerAssist({
  ticketId, enabled, mode, editorRef, body, text, onSetBody, disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState(null); // { text, token, rich } | null = whole draft
  const [job, setJob] = useState(null); // { action, status: 'loading'|'done'|'error'|'applied', result, error, source, before }
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const runRef = useRef(0);

  // Another ticket, another mode, or switched off: a suggestion for the old text is gone.
  useEffect(() => { runRef.current += 1; setJob(null); setOpen(false); }, [ticketId, mode, enabled]);
  // A sent or cleared draft takes its suggestion with it.
  useEffect(() => { if (!text.trim()) setJob((j) => (j && j.status !== 'loading' ? null : j)); }, [text]);

  // The suggestion sits under the editor: bring it into view when it starts and when it lands.
  const status = job?.status || null;
  useEffect(() => {
    if (status === 'loading' || status === 'done' || status === 'error') panelRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [status]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey, true); };
  }, [open]);

  if (!enabled || mode === 'forward') return { menu: null, panel: null };

  const openMenu = () => {
    if (open) { setOpen(false); return; }
    let sel = null;
    try { sel = editorRef.current?.getSelection?.() || null; } catch { sel = null; }
    setScope(sel && sel.text && sel.text.trim().length >= 3 ? sel : null);
    setOpen(true);
  };

  const run = (action, source = null) => {
    const src = source || { text: scope ? scope.text : text, token: scope ? scope.token : null, rich: scope ? Boolean(scope.rich) : hasRichMarkup(body), whole: !scope };
    setOpen(false);
    const mine = ++runRef.current;
    setJob({ action, status: 'loading', source: src });
    ticketsAPI.composeAssist(ticketId, { action, text: src.text })
      .then((res) => {
        if (runRef.current !== mine) return;
        const result = String(res?.data?.text || '').trim();
        if (!result) throw new Error('empty');
        setJob({ action, status: 'done', result, source: src });
      })
      .catch((err) => {
        if (runRef.current !== mine) return;
        setJob({ action, status: 'error', source: src, error: err?.response?.data?.message || err?.message?.replace(/^empty$/, '') || 'The AI did not answer. Try again.' });
      });
  };

  const discard = () => { runRef.current += 1; setJob(null); };
  const replace = () => {
    if (!job?.result) return;
    const before = body;
    if (job.source.whole) {
      onSetBody(plainToHtml(job.result), job.result);
    } else {
      let ok = false;
      try { ok = Boolean(editorRef.current?.replaceSelection?.(job.source.token, plainToHtml(job.result, { inline: true }))); } catch { ok = false; }
      if (!ok) { setJob({ ...job, note: 'The text you selected has changed since. Use Add below, or select it again.' }); return; }
    }
    setJob({ ...job, status: 'applied', before });
  };
  const addBelow = () => {
    if (!job?.result) return;
    const before = body;
    onSetBody(`${body || ''}${plainToHtml(job.result)}`, null);
    setJob({ ...job, status: 'applied', before });
  };
  const putBack = () => { if (job?.before !== undefined) onSetBody(job.before, null); setJob(null); };

  const hasText = text.trim().length >= 3;
  const choices = ASSIST_CHOICES.filter((c) => !c.replyOnly || mode === 'reply');
  const btn = 'tp-focus-ring rounded-md px-2 py-1 text-xs font-medium';

  const menu = (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={openMenu}
        disabled={disabled || job?.status === 'loading'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Writing help (AI)"
        title="Writing help (AI): works on the text you select, or on the whole draft"
        className="tp-focus-ring inline-flex items-center gap-1 rounded-lg px-1.5 py-1.5 text-xs font-medium text-muted-foreground/75 hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">AI</span>
      </button>
      {open && (
        <div role="menu" aria-label="Writing help" data-testid="assist-menu" className="absolute bottom-full left-0 z-30 mb-1 w-60 max-w-[calc(100vw-2.5rem)] tp-card rounded-lg p-1 shadow-soft animate-popIn">
          <p className="px-2 pb-1 pt-1.5 text-[11px] text-muted-foreground">
            {!hasText ? 'Write something first, then ask.' : scope ? 'On the text you selected' : 'On the whole draft'}
          </p>
          {choices.map((c) => (
            <button
              key={c.key}
              type="button"
              role="menuitem"
              disabled={!hasText}
              onClick={() => run(c.key)}
              className="tp-focus-ring flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-foreground/85 hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent"
            >
              {c.label}
            </button>
          ))}
          <p className="border-t border-border px-2 pb-1 pt-1.5 mt-1 text-[10px] leading-snug text-muted-foreground/75">
            You see the suggestion before anything changes. Only this text and the ticket subject go to the AI.
          </p>
        </div>
      )}
    </span>
  );

  const panel = job ? (
    <div ref={panelRef} className="mt-2 scroll-mb-16 border-l-2 border-violet-300 dark:border-violet-500/50 pl-3 py-1" role="region" aria-label="AI suggestion" aria-live="polite" data-testid="assist-panel">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Sparkles className="h-3 w-3 text-violet-500 dark:text-violet-300" aria-hidden="true" />
          AI suggestion: {assistLabel(job.action).toLowerCase()}
          <span className="font-normal">({job.source.whole ? 'whole draft' : 'selected text'})</span>
        </p>
        {job.status !== 'applied' && (
          <button type="button" onClick={discard} aria-label="Discard the suggestion" title="Discard" className="tp-focus-ring rounded-md p-1 text-muted-foreground/75 hover:bg-muted hover:text-foreground">
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
      {job.status === 'loading' && (
        <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Writing…</p>
      )}
      {job.status === 'error' && (
        <p className="mt-1 text-sm text-red-700 dark:text-red-300">
          {job.error}
          <button type="button" onClick={() => run(job.action, job.source)} className={`${btn} ml-1.5 text-primary hover:underline`}>Try again</button>
        </p>
      )}
      {job.status === 'done' && (
        <>
          <div className="mt-1 max-h-56 overflow-y-auto settings-scrollbar whitespace-pre-wrap text-sm text-foreground" data-testid="assist-result">{job.result}</div>
          {job.source.rich && (
            <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">Replace puts plain text in: bold, links, pictures, tables and @mentions in the replaced part are not kept.</p>
          )}
          {job.note && <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">{job.note}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={replace} className={`${btn} bg-primary text-primary-foreground hover:opacity-90`}>Replace</button>
            <button type="button" onClick={addBelow} className={`${btn} border border-border bg-card text-foreground/85 hover:bg-muted`}>Add below</button>
            <button type="button" onClick={() => run(job.action, job.source)} className={`${btn} text-muted-foreground hover:bg-muted hover:text-foreground`}>Try again</button>
            <button type="button" onClick={discard} className={`${btn} text-muted-foreground hover:bg-muted hover:text-foreground`}>Discard</button>
          </div>
        </>
      )}
      {job.status === 'applied' && (
        <p className="mt-1 text-xs text-muted-foreground">
          Done. Read it over before you send.
          <button type="button" onClick={putBack} className={`${btn} ml-1.5 text-primary hover:underline`}>Put my text back</button>
          <button type="button" onClick={() => setJob(null)} className={`${btn} text-muted-foreground hover:bg-muted hover:text-foreground`}>Dismiss</button>
        </p>
      )}
    </div>
  ) : null;

  return { menu, panel };
}
