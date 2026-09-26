import { useEffect, useState } from 'react';
import { Lock, RotateCcw } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import { Switch } from '../ui';
import { inputClass } from './knowledgeUi';

/**
 * Knowledge → Settings (26 Sep 2026: moved out of the strip above the tabs).
 * Workspace switches for Auto-help: shadow mode on/off, and the AI disclosure
 * line (on by default, editable wording with a live preview). People who
 * can't manage Knowledge see the same card read-only.
 */

/** Same substitution the runner makes ({{workspace}} -> the workspace name). */
export function renderDisclosure(template, workspaceName) {
  return String(template || '').replace(/\{\{\s*workspace\s*\}\}/gi, workspaceName || 'support').trim();
}

function Row({ children }) {
  return <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:gap-6">{children}</div>;
}

export default function KnowledgeSettingsPanel({ settings, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [text, setText] = useState(settings?.disclosureText || '');

  useEffect(() => { setText(settings?.disclosureText || ''); }, [settings?.disclosureText]);
  useEffect(() => {
    if (!saved) return undefined;
    const t = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(t);
  }, [saved]);

  if (!settings) return null;
  const canManage = settings.canManage === true;
  const defaultText = settings.defaults?.disclosureText || '';
  const wordingDirty = (text || '') !== (settings.disclosureText || '');
  const preview = renderDisclosure(text || defaultText, settings.workspaceName);

  const save = async (patch) => {
    setBusy(true);
    setError(null);
    try {
      const res = await knowledgeAPI.updateSettings(patch);
      onChange?.({ ...settings, ...(res?.data || patch) });
      setSaved(true);
      return true;
    } catch (err) {
      setError(err?.message || 'Could not save');
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="knowledge-settings">
      {!canManage && (
        <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground" data-testid="knowledge-settings-readonly">
          <Lock className="h-3.5 w-3.5" aria-hidden="true" />
          Auto-help is {settings.enabled ? 'on in shadow mode — answers are drafted and recorded, never sent' : 'off for this workspace'}. Only Knowledge admins can change these settings.
        </p>
      )}

      <section className="tp-card divide-y divide-border overflow-hidden" aria-labelledby="kh-settings-autohelp">
        <div className="px-5 pb-3 pt-4">
          <h2 id="kh-settings-autohelp" className="text-sm font-semibold text-foreground">Auto-help</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Drafts a first answer from Knowledge for new tickets that match a playbook.</p>
        </div>

        <Row>
          <Switch
            id="kh-enabled"
            checked={settings.enabled}
            disabled={busy || !canManage}
            onCheckedChange={(v) => save({ enabled: v })}
            aria-label="Auto-help on for this workspace (shadow)"
          />
          <label htmlFor="kh-enabled" className="min-w-0 flex-1 cursor-pointer">
            <span className="block text-sm font-medium text-foreground">Auto-help on for this workspace</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
              Shadow mode: answers are drafted and recorded on the ticket and in Activity. Nothing is sent to requesters in this phase.
            </span>
          </label>
          <span className={`shrink-0 text-xs font-medium ${settings.enabled ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'}`}>
            {settings.enabled ? 'On · shadow' : 'Off'}
          </span>
        </Row>

        <Row>
          <Switch
            id="kh-disclosure"
            checked={settings.disclosureEnabled}
            disabled={busy || !canManage}
            onCheckedChange={(v) => save({ disclosureEnabled: v })}
            aria-label="Add the automated-answer line"
          />
          <div className="min-w-0 flex-1">
            <label htmlFor="kh-disclosure" className="block cursor-pointer">
              <span className="block text-sm font-medium text-foreground">Say it&rsquo;s an automated answer</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">A short line at the top of every Auto-help answer, so requesters know a person hasn&rsquo;t written it yet.</span>
            </label>

            <form
              className="mt-3 space-y-2"
              onSubmit={async (e) => {
                e.preventDefault();
                await save({ disclosureText: text });
              }}
            >
              <label htmlFor="kh-disclosure-text" className="block text-xs font-medium text-foreground/85">Wording</label>
              <textarea
                id="kh-disclosure-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={500}
                rows={2}
                disabled={!canManage}
                placeholder={defaultText}
                aria-label="Automated-answer wording"
                className={`${inputClass} h-auto resize-y py-2 leading-relaxed`}
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground/75">
                <code className="rounded bg-muted px-1 font-mono text-[10.5px] text-foreground/85">{'{{workspace}}'}</code> becomes the workspace name. Leave it empty for the default wording.
              </p>
              {/* The requester's view: the white e-mail well in both themes (tp-light pins light tokens). */}
              <div className="tp-light rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-muted-foreground" data-testid="disclosure-preview">
                <span className="mr-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/75">Requesters read</span>
                {settings.disclosureEnabled ? preview : <span className="italic">Nothing — the line is switched off.</span>}
              </div>
              {canManage && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button type="submit" disabled={busy || !wordingDirty} className="tp-focus-ring h-9 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">Save wording</button>
                  {wordingDirty && (
                    <button type="button" onClick={() => setText(settings.disclosureText || '')} className="tp-focus-ring h-9 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted">Cancel</button>
                  )}
                  {Boolean(text) && text !== defaultText && (
                    <button type="button" onClick={() => setText('')} className="tp-focus-ring inline-flex h-9 items-center gap-1 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted">
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Use the default
                    </button>
                  )}
                </div>
              )}
            </form>
          </div>
        </Row>
      </section>

      <div className="min-h-[1.25rem] px-1" aria-live="polite">
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
        {!error && saved && <p className="text-xs text-muted-foreground">Saved.</p>}
      </div>
    </div>
  );
}
