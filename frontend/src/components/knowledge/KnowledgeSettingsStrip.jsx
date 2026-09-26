import { useEffect, useState } from 'react';
import { Lock, Pencil } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import { Switch } from '../ui';
import { inputClass } from './knowledgeUi';

/**
 * Workspace switches for Auto-help, shown to people who can manage Knowledge:
 * the shadow-mode on/off and the AI disclosure line (on by default, editable
 * wording). Everyone else sees one quiet line saying whether it is on.
 */
/** Same substitution the runner makes ({{workspace}} -> the workspace name). */
export function renderDisclosure(template, workspaceName) {
  return String(template || '').replace(/\{\{\s*workspace\s*\}\}/gi, workspaceName || 'support').trim();
}

export default function KnowledgeSettingsStrip({ settings, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(settings?.disclosureText || '');

  useEffect(() => { setText(settings?.disclosureText || ''); }, [settings?.disclosureText]);

  if (!settings) return null;
  const canManage = settings.canManage === true;
  const shown = settings.disclosurePreview || renderDisclosure(settings.disclosureText, settings.workspaceName);
  const draftPreview = renderDisclosure(text || settings.defaults?.disclosureText, settings.workspaceName);

  const save = async (patch) => {
    setBusy(true);
    setError(null);
    try {
      const res = await knowledgeAPI.updateSettings(patch);
      onChange?.({ ...settings, ...(res?.data || patch) });
      return true;
    } catch (err) {
      setError(err?.message || 'Could not save');
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!canManage) {
    return (
      <p className="mb-4 flex items-center gap-1.5 px-1 text-xs text-muted-foreground" data-testid="knowledge-settings-readonly">
        <Lock className="h-3.5 w-3.5" aria-hidden="true" />
        Auto-help is {settings.enabled ? 'on in shadow mode — answers are drafted and recorded, never sent' : 'off for this workspace'}.
      </p>
    );
  }

  return (
    <div className="tp-surface mb-4 px-4 py-3" data-testid="knowledge-settings">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-6">
        <div className="flex items-center gap-3">
          <Switch
            id="kh-enabled"
            checked={settings.enabled}
            disabled={busy}
            onCheckedChange={(v) => save({ enabled: v })}
            aria-label="Auto-help on for this workspace (shadow)"
          />
          <label htmlFor="kh-enabled" className="cursor-pointer">
            <span className="block text-sm font-medium text-foreground">Auto-help on for this workspace <span className="font-normal text-muted-foreground">(shadow)</span></span>
            <span className="block text-xs text-muted-foreground">New tickets that match a playbook get a drafted answer. Nothing is sent to requesters in this phase.</span>
          </label>
        </div>

        <div className="hidden h-8 w-px bg-border md:block" aria-hidden="true" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <Switch
              id="kh-disclosure"
              checked={settings.disclosureEnabled}
              disabled={busy}
              onCheckedChange={(v) => save({ disclosureEnabled: v })}
              aria-label="Add the automated-answer line"
            />
            <label htmlFor="kh-disclosure" className="min-w-0 flex-1 cursor-pointer">
              <span className="block text-sm font-medium text-foreground">Say it&rsquo;s an automated answer</span>
              {!editing && (
                <span className="block truncate text-xs text-muted-foreground" title={shown} data-testid="disclosure-preview">&ldquo;{shown}&rdquo;</span>
              )}
            </label>
            {!editing && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="tp-focus-ring inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Wording
              </button>
            )}
          </div>
          {editing && (
            <form
              className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await save({ disclosureText: text })) setEditing(false);
              }}
            >
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={500}
                aria-label="Automated-answer wording"
                className={inputClass}
              />
              <div className="flex gap-2">
                <button type="submit" disabled={busy} className="tp-focus-ring h-9 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">Save</button>
                <button type="button" onClick={() => { setEditing(false); setText(settings.disclosureText); }} className="tp-focus-ring h-9 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted">Cancel</button>
              </div>
            </form>
          )}
          {editing && (
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/75">
              <code className="rounded bg-muted px-1 font-mono text-[10.5px] text-foreground/85">{'{{workspace}}'}</code> becomes the workspace name. Leave empty for the default wording.
              <span className="mt-0.5 block text-muted-foreground" data-testid="disclosure-draft-preview">Requesters read: &ldquo;{draftPreview}&rdquo;</span>
            </p>
          )}
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-700 dark:text-red-300" role="alert">{error}</p>}
    </div>
  );
}
