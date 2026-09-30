import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitCompare, RotateCcw, Trash2, Upload } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import { PromptDiffModal } from '../assignment/PromptManager';
import { formatDayTime } from '../tickets/ticketUi';
import { SettingsSection, inputClass } from './knowledgeUi';

const STATUS_WORD = { published: 'Live', draft: 'Draft', archived: 'Earlier' };

/**
 * Knowledge → Settings → Prompts (30 Sep 2026). Auto-help's three prompts,
 * each with one editable block of guidance — voice and style, how picky the
 * playbook choice is, how strict the answer check is — versioned like the
 * assignment prompts: save a draft, publish it, compare any two versions,
 * restore an old one, or go back to the built-in default. The safety and
 * format rules around the guidance are fixed; the full prompt is shown
 * read-only so you can see exactly what the AI gets.
 */
export default function AutoHelpPromptsSettings({ canManage }) {
  const [items, setItems] = useState(null);
  const [key, setKey] = useState('answer');
  const [text, setText] = useState('');
  const [notes, setNotes] = useState('');
  const [full, setFull] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [diff, setDiff] = useState(null); // { left, right }
  const cacheRef = useRef({});

  const load = useCallback(async (keepKey = null) => {
    try {
      const res = await knowledgeAPI.listPrompts();
      const list = res?.data || [];
      setItems(list);
      const current = list.find((p) => p.key === (keepKey || key)) || list[0];
      if (current) {
        setText(current.activeBody || '');
        setFull(current.fullPrompt || '');
      }
    } catch (err) {
      setError(err?.message || 'Could not load the prompts');
      setItems([]);
    }
  }, [key]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const item = useMemo(() => (items || []).find((p) => p.key === key) || null, [items, key]);
  const dirty = item ? text !== (item.activeBody || '') : false;

  // Live full prompt as the guidance is edited.
  useEffect(() => {
    if (!item) return undefined;
    let cancelled = false;
    const t = setTimeout(() => {
      Promise.resolve()
        .then(() => knowledgeAPI.previewPrompt(key, text))
        .then((res) => { if (!cancelled) setFull(res?.data?.fullPrompt || ''); })
        .catch(() => {});
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [key, text, item]);

  const pick = (k) => {
    setKey(k);
    const next = (items || []).find((p) => p.key === k);
    setText(next?.activeBody || '');
    setNotes('');
    setMessage(null);
    setError(null);
  };

  const run = async (fn, done) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
      await load(key);
      if (done) setMessage(done);
    } catch (err) {
      setError(err?.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = (publish) => run(async () => {
    const res = await knowledgeAPI.createPrompt({ key, body: text, notes: notes.trim() || null });
    if (publish && res?.data?.id) await knowledgeAPI.publishPrompt(res.data.id);
    setNotes('');
  }, publish ? 'Published — Auto-help uses it within a minute.' : 'Saved as a draft.');

  const loadVersion = useCallback(async (id) => {
    const k = String(id);
    if (cacheRef.current[k]) return cacheRef.current[k];
    const res = await knowledgeAPI.getPrompt(id);
    const v = res?.data || null;
    if (v) cacheRef.current[k] = v;
    return v;
  }, []);

  if (items === null) return null;
  const versions = item?.versions || [];

  return (
    <SettingsSection id="kh-settings-prompts" title="Prompts" hint="What Auto-help is told. Edit the guidance; the safety and format rules stay fixed.">
      <div className="space-y-3 px-4 py-4 sm:px-5" data-testid="auto-help-prompts">
        <div role="tablist" aria-label="Prompt" className="inline-flex flex-wrap rounded-lg border border-border bg-card p-0.5">
          {(items || []).map((p) => (
            <button
              key={p.key}
              type="button"
              role="tab"
              aria-selected={key === p.key}
              onClick={() => pick(p.key)}
              className={`tp-focus-ring h-8 rounded-md px-3 text-sm font-medium transition-colors ${key === p.key ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {p.title}
            </button>
          ))}
        </div>

        {item && (
          <>
            <p className="text-xs text-muted-foreground">
              {item.hint} {item.published ? <>Live: <span className="font-medium text-foreground/85">v{item.published.version}</span>{item.published.publishedAt ? `, published ${formatDayTime(item.published.publishedAt)}` : ''}.</> : 'Live: the built-in default.'}
            </p>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <label htmlFor="kh-prompt-guidance" className="block text-xs font-medium text-foreground/85">Guidance you can edit</label>
                <textarea
                  id="kh-prompt-guidance"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  disabled={!canManage}
                  rows={8}
                  maxLength={4000}
                  className={`${inputClass} h-auto resize-y py-2 font-mono text-[12.5px] leading-relaxed`}
                />
                <p className="text-[11px] text-muted-foreground/75">One instruction per line. Default: <span className="italic">{item.defaultBody.split('\n')[0]}{item.defaultBody.includes('\n') ? ' …' : ''}</span></p>
                {canManage && (
                  <>
                    <input
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="What changed? (optional)"
                      aria-label="Version note"
                      maxLength={500}
                      className={`${inputClass} h-9`}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" disabled={busy || !dirty || !text.trim()} onClick={() => saveDraft(true)} className="tp-focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                        <Upload className="h-3.5 w-3.5" aria-hidden="true" /> Save and publish
                      </button>
                      <button type="button" disabled={busy || !dirty || !text.trim()} onClick={() => saveDraft(false)} className="tp-focus-ring h-9 rounded-lg border border-border px-3 text-sm font-medium text-foreground/85 hover:bg-muted disabled:opacity-50">
                        Save as draft
                      </button>
                      {dirty && <button type="button" onClick={() => setText(item.activeBody || '')} className="tp-focus-ring h-9 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted">Cancel</button>}
                      {item.published && (
                        <button type="button" disabled={busy} onClick={() => run(() => knowledgeAPI.useDefaultPrompt(key), 'Back to the built-in default.')} className="tp-focus-ring ml-auto inline-flex h-9 items-center gap-1 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted">
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Use the default
                        </button>
                      )}
                    </div>
                  </>
                )}
                {message && <p className="text-xs text-emerald-700 dark:text-emerald-300" role="status">{message}</p>}
                {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
              </div>
              <div className="min-w-0 space-y-2">
                <p className="text-xs font-medium text-foreground/85">The full prompt the AI gets</p>
                <pre className="settings-scrollbar max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-foreground/85" data-testid="full-prompt">{full}</pre>
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-foreground/85">Versions</p>
                {versions.length > 0 && (
                  <button type="button" onClick={() => setDiff({ left: item.published ? `version:${item.published.id}` : `version:${versions[0].id}`, right: 'current' })} className="tp-focus-ring inline-flex items-center gap-1 rounded px-1.5 text-xs font-medium text-primary hover:underline">
                    <GitCompare className="h-3.5 w-3.5" aria-hidden="true" /> Compare
                  </button>
                )}
              </div>
              {versions.length === 0 ? (
                <p className="text-xs text-muted-foreground">No versions yet — Auto-help uses the built-in default.</p>
              ) : (
                <ul className="divide-y divide-border/60 rounded-lg border border-border/70" data-testid="prompt-versions">
                  {versions.map((v) => (
                    <li key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
                      <span className="font-mono font-semibold text-foreground">v{v.version}</span>
                      <span className={v.status === 'published' ? 'font-medium text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'}>{STATUS_WORD[v.status] || v.status}</span>
                      <span className="text-muted-foreground">{formatDayTime(v.createdAt)}{v.createdBy ? ` · ${v.createdBy}` : ''}</span>
                      {v.notes && <span className="min-w-0 flex-1 truncate text-foreground/80">{v.notes}</span>}
                      <span className="ml-auto flex items-center gap-1">
                        <button type="button" onClick={() => setText(v.body)} className="tp-focus-ring rounded px-1.5 py-0.5 text-primary hover:underline">Open</button>
                        <button type="button" onClick={() => setDiff({ left: `version:${v.id}`, right: 'current' })} className="tp-focus-ring rounded px-1.5 py-0.5 text-primary hover:underline">Compare</button>
                        {canManage && v.status !== 'published' && (
                          <button type="button" disabled={busy} onClick={() => run(() => knowledgeAPI.publishPrompt(v.id), `v${v.version} published.`)} className="tp-focus-ring rounded px-1.5 py-0.5 text-primary hover:underline">Publish</button>
                        )}
                        {canManage && v.status === 'archived' && (
                          <button type="button" disabled={busy} onClick={() => run(() => knowledgeAPI.restorePrompt(v.id), `v${v.version} copied into a new draft.`)} className="tp-focus-ring rounded px-1.5 py-0.5 text-primary hover:underline">Restore</button>
                        )}
                        {canManage && v.status !== 'published' && (
                          <button type="button" disabled={busy} onClick={() => run(() => knowledgeAPI.deletePrompt(v.id), `v${v.version} deleted.`)} aria-label={`Delete v${v.version}`} className="tp-focus-ring rounded p-0.5 text-muted-foreground hover:text-red-600">
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
      {diff && item && (
        <PromptDiffModal
          isOpen
          onClose={() => setDiff(null)}
          versions={versions}
          published={item.published}
          editText={text}
          initialLeftKey={diff.left}
          initialRightKey={diff.right}
          loadPromptVersion={loadVersion}
          onApplyPrompt={canManage ? (body) => { setText(body); setDiff(null); } : undefined}
        />
      )}
    </SettingsSection>
  );
}
