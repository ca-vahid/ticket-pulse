import { useEffect, useState } from 'react';
import { Hand, Lock, RotateCcw } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import { Switch } from '../ui';
import { usd } from './autoHelpWords';
import { SettingsRow as Row, SettingsSection, inputClass } from './knowledgeUi';
import { KnowledgeSources } from './KnowledgeSourcesSettings';
import { StayQuietList } from './StayQuietEditor';
import AutoHelpSignatureSettings from './AutoHelpSignatureSettings';
import AutoHelpPromptsSettings from './AutoHelpPromptsSettings';

/**
 * Knowledge → Settings (26 Sep 2026: moved out of the strip above the tabs).
 * Every workspace-level Knowledge switch lives here, one card per topic:
 *   Auto-help               on/off, approve mode, the thank-you, the monthly
 *                           cost cap (with this month's spend); auto sending is
 *                           locked by the build
 *   Always stay quiet when  the workspace's hard stops for every playbook
 *                           (26 Sep 2026; seeded with three defaults)
 *   Automated-answer line   the AI disclosure switch + wording + live preview
 *   E-mail signature        pasted signature for every answer (30 Sep 2026)
 *   Prompts                 versioned guidance for the three prompts (30 Sep 2026)
 *   Knowledge sources       FreshService solution import (KnowledgeSourcesSettings)
 *   Reviews                 the Monday review e-mail (KnowledgeSourcesSettings)
 * People who can't manage Knowledge see the same cards read-only.
 */

/** Same substitution the runner makes ({{workspace}} -> the workspace name). */
export function renderDisclosure(template, workspaceName) {
  return String(template || '').replace(/\{\{\s*workspace\s*\}\}/gi, workspaceName || 'support').trim();
}

function modeWords(settings) {
  if (!settings.enabled) return 'off for this workspace';
  return settings.approveModeEnabled
    ? 'on — playbooks in approve mode suggest answers on tickets; an agent sends them'
    : 'on in shadow mode — answers are drafted and recorded, never sent';
}

export default function KnowledgeSettingsPanel({ settings, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [text, setText] = useState(settings?.disclosureText || '');
  const [cap, setCap] = useState(settings?.monthlyCostCapUsd ?? '');
  const [quiet, setQuiet] = useState(settings?.alwaysStayQuietWhen || []);

  useEffect(() => { setText(settings?.disclosureText || ''); }, [settings?.disclosureText]);
  useEffect(() => { setCap(settings?.monthlyCostCapUsd ?? ''); }, [settings?.monthlyCostCapUsd]);
  useEffect(() => { setQuiet(settings?.alwaysStayQuietWhen || []); }, [settings?.alwaysStayQuietWhen]);
  useEffect(() => {
    if (!saved) return undefined;
    const t = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(t);
  }, [saved]);

  if (!settings) return null;
  const canManage = settings.canManage === true;
  const approveOn = settings.approveModeEnabled === true;
  const defaultText = settings.defaults?.disclosureText || '';
  const wordingDirty = (text || '') !== (settings.disclosureText || '');
  const preview = renderDisclosure(text || defaultText, settings.workspaceName);
  const capValue = () => (String(cap).trim() === '' ? null : Number(cap));
  const capDirty = String(cap) !== String(settings.monthlyCostCapUsd ?? '');
  const savedQuiet = settings.alwaysStayQuietWhen || [];
  const defaultQuiet = settings.defaults?.alwaysStayQuietWhen || [];
  const quietDirty = JSON.stringify(quiet) !== JSON.stringify(savedQuiet);
  const quietIsDefault = JSON.stringify(quiet) === JSON.stringify(defaultQuiet);

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
          <Lock className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          <span>Auto-help is {modeWords(settings)}. Only Knowledge admins can change these settings.</span>
        </p>
      )}

      <SettingsSection id="kh-settings-autohelp" title="Auto-help" hint="Drafts a first answer from Knowledge for new tickets that match a playbook.">
        <Row>
          <Switch
            id="kh-enabled"
            checked={settings.enabled}
            disabled={busy || !canManage}
            onCheckedChange={(v) => save({ enabled: v })}
            aria-label={`Auto-help on for this workspace (${approveOn ? 'approve mode allowed — an agent sends each answer' : 'shadow — answers are drafted, never sent'})`}
          />
          <label htmlFor="kh-enabled" className="min-w-0 flex-1 cursor-pointer">
            <span className="block text-sm font-medium text-foreground">Auto-help on for this workspace</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
              New tickets that match a playbook get a drafted answer, recorded on the ticket and in Activity. Nothing reaches a requester unless a playbook is in approve mode and an agent sends it.
            </span>
          </label>
          <span className={`hidden shrink-0 text-xs font-medium sm:block ${settings.enabled ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'}`} data-testid="autohelp-state">
            {!settings.enabled ? 'Off' : approveOn ? 'On · approve allowed' : 'On · shadow'}
          </span>
        </Row>

        <Row>
          <Switch
            id="kh-approve"
            checked={approveOn}
            disabled={busy || !canManage}
            onCheckedChange={(v) => save({ approveModeEnabled: v })}
            aria-label="Approve mode for this workspace"
          />
          <label htmlFor="kh-approve" className="min-w-0 flex-1 cursor-pointer">
            <span className="block text-sm font-medium text-foreground">Approve mode</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
              Playbooks set to Approve put &ldquo;Auto-help suggests&rdquo; on the ticket; an agent reads it and sends it, edits it, or dismisses it.
            </span>
          </label>
        </Row>

        <Row>
          <Switch
            id="kh-thanks"
            checked={settings.thankOnConfirm === true}
            disabled={busy || !canManage}
            onCheckedChange={(v) => save({ thankOnConfirm: v })}
            aria-label="Thank the requester when they confirm it worked"
          />
          <label htmlFor="kh-thanks" className="min-w-0 flex-1 cursor-pointer">
            <span className="block text-sm font-medium text-foreground">Thank them when they confirm it worked</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">When a requester replies that the answer sorted it, the ticket closes either way; with this on they also get a short thank-you.</span>
          </label>
        </Row>

        <Row>
          <Switch
            id="kh-first-response"
            checked={settings.countsAsFirstResponse === true}
            disabled={busy || !canManage}
            onCheckedChange={(v) => save({ countsAsFirstResponse: v })}
            aria-label="Count an automated answer as the first response"
          />
          <label htmlFor="kh-first-response" className="min-w-0 flex-1 cursor-pointer" data-testid="first-response-setting">
            <span className="block text-sm font-medium text-foreground">Count an automated answer as the first response</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
              Off: an answer an agent sends counts as usual; answers sent without an agent (auto mode, not in this build) only record an &lsquo;automated first answer&rsquo; time.
            </span>
            <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground/80">
              <Lock className="h-3 w-3" aria-hidden="true" /> Only matters for auto mode (not in this build).
            </span>
          </label>
        </Row>

        <Row>
          <div className="min-w-0 flex-1">
            <label htmlFor="kh-cap" className="block text-sm font-medium text-foreground">Monthly cost cap</label>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">Auto-help stops calling the model for the rest of the month once its spend (drafts and reply checks) reaches the cap. Empty means no cap.</span>
            <form
              className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2"
              onSubmit={async (e) => {
                e.preventDefault();
                await save({ monthlyCostCapUsd: capValue() });
              }}
            >
              <span className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-xs text-muted-foreground">US$</span>
                <input
                  id="kh-cap"
                  type="number"
                  min="0"
                  step="1"
                  inputMode="decimal"
                  value={cap}
                  disabled={!canManage}
                  onChange={(e) => setCap(e.target.value)}
                  onBlur={() => { if (canManage && capDirty) save({ monthlyCostCapUsd: capValue() }); }}
                  placeholder="none"
                  aria-describedby="kh-cap-hint"
                  className={`${inputClass} w-32 pl-10 disabled:opacity-70`}
                />
              </span>
              <span id="kh-cap-hint" className="text-xs text-muted-foreground" data-testid="cost-spent">
                {usd(settings.budget?.spentUsd ?? 0)} spent this month{settings.budget?.exhausted ? ' — cap reached, runs are paused' : ''}
              </span>
            </form>
          </div>
        </Row>

        {settings.autoModeAllowed !== true && (
          <div className="flex items-center gap-1.5 bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground sm:px-5" data-testid="auto-locked">
            <Lock className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            <span>{settings.autoModeLockedMessage || 'Auto sending is switched off in this build'}{/[.!?]$/.test(settings.autoModeLockedMessage || '') ? '' : '.'} Playbooks can be Shadow or Approve.</span>
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        id="kh-settings-stay-quiet"
        title="Always stay quiet when"
        hint="Hard stops for every playbook in this workspace. If any applies, Auto-help does not answer and a person picks the ticket up. Each playbook can add its own."
        testId="settings-stay-quiet"
      >
        <Row>
          <span className="hidden h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50 text-primary ring-1 ring-blue-100 dark:bg-blue-500/15 dark:text-blue-200 dark:ring-blue-400/20 sm:inline-flex" aria-hidden="true">
            <Hand className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <StayQuietList
              values={quiet}
              onChange={setQuiet}
              readOnly={!canManage}
              label="Always stay quiet when (workspace)"
              placeholder="e.g. The request is about a purchase or a quote"
              emptyText="No workspace-wide conditions — only each playbook's own."
              testId="workspace-stay-quiet"
            />
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/75">
              One condition per line, in plain words. They are given to the AI as numbered rules; Activity shows &ldquo;Stayed quiet&rdquo; with the one that applied.
            </p>
            {canManage && (quietDirty || !quietIsDefault) && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {quietDirty && (
                  <>
                    <button type="button" disabled={busy} onClick={() => save({ alwaysStayQuietWhen: quiet })} className="tp-focus-ring h-9 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">Save list</button>
                    <button type="button" onClick={() => setQuiet(savedQuiet)} className="tp-focus-ring h-9 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted">Cancel</button>
                  </>
                )}
                {!quietIsDefault && defaultQuiet.length > 0 && (
                  <button type="button" onClick={() => setQuiet(defaultQuiet)} className="tp-focus-ring inline-flex h-9 items-center gap-1 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted">
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Restore the defaults
                  </button>
                )}
              </div>
            )}
          </div>
        </Row>
      </SettingsSection>

      <SettingsSection id="kh-settings-disclosure" title="Automated-answer line" hint="What requesters read above every Auto-help answer.">
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
      </SettingsSection>

      <AutoHelpSignatureSettings settings={settings} canManage={canManage} busy={busy} save={save} />

      <AutoHelpPromptsSettings canManage={canManage} />

      {/* Announced without reserving a blank gap between the cards. */}
      <p className="sr-only" aria-live="polite">{!error && saved ? 'Saved.' : ''}</p>
      {error && <p className="px-1 text-xs text-destructive" role="alert">{error}</p>}
      {!error && saved && <p className="px-1 text-xs text-muted-foreground" aria-hidden="true">Saved.</p>}

      <KnowledgeSources canManage={canManage} />
    </div>
  );
}
