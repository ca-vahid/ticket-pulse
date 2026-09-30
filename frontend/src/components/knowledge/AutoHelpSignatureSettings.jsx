import { useEffect, useState } from 'react';
import RichTextEditor from '../tickets/RichTextEditor';
import { SafeHtml } from '../tickets/ticketUi';
import { Switch } from '../ui';
import { applySignatureSpacing } from '../../utils/signatureSpacing';
import { SettingsRow as Row, SettingsSection } from './knowledgeUi';

const SPACINGS = [
  ['tight', 'Tight', 'Lines stack directly — matches Outlook and FreshService'],
  ['normal', 'Normal', 'A little breathing room between lines'],
  ['relaxed', 'Relaxed', 'Roomier, for short signatures'],
];
const WITH = [
  ['replace', 'Use this signature instead of theirs', 'The answer goes out with the Auto-help signature only.'],
  ['both', 'Add their own signature after this one', 'The Auto-help signature, then the sending agent’s own.'],
];

/**
 * Knowledge → Settings → E-mail signature (30 Sep 2026): the signature at the
 * end of every Auto-help answer. Paste it like your own signature (Profile →
 * Signature) — tables, colours and logos are kept. When an agent sends a
 * suggested answer, this decides what happens to their own signature.
 */
export default function AutoHelpSignatureSettings({ settings, canManage, busy, save }) {
  const [html, setHtml] = useState(settings?.signatureHtml || '');
  const [text, setText] = useState(settings?.signatureText || '');
  const [spacing, setSpacing] = useState(settings?.signatureSpacing || 'tight');
  const [withMode, setWithMode] = useState(settings?.signatureWith || 'replace');

  useEffect(() => {
    setHtml(settings?.signatureHtml || '');
    setText(settings?.signatureText || '');
    setSpacing(settings?.signatureSpacing || 'tight');
    setWithMode(settings?.signatureWith || 'replace');
  }, [settings?.signatureHtml, settings?.signatureText, settings?.signatureSpacing, settings?.signatureWith]);

  const dirty = (html || '') !== (settings?.signatureHtml || '')
    || spacing !== (settings?.signatureSpacing || 'tight')
    || withMode !== (settings?.signatureWith || 'replace');
  const enabled = settings?.signatureEnabled === true;

  return (
    <SettingsSection id="kh-settings-signature" title="E-mail signature" hint="Added at the end of every Auto-help answer.">
      <Row>
        <Switch
          id="kh-signature"
          checked={enabled}
          disabled={busy || !canManage}
          onCheckedChange={(v) => save({ signatureEnabled: v })}
          aria-label="Add a signature to Auto-help answers"
        />
        <div className="min-w-0 flex-1 space-y-3">
          <label htmlFor="kh-signature" className="block cursor-pointer">
            <span className="block text-sm font-medium text-foreground">Sign Auto-help answers</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
              Off: an answer an agent sends carries that agent&rsquo;s own signature, as today.
            </span>
          </label>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs font-medium text-foreground/85">Signature</p>
              {canManage ? (
                <RichTextEditor
                  value={html}
                  onChange={(next) => { setHtml(next.html); setText(next.text); }}
                  placeholder="Paste or write the signature — tables, colours and logos are kept…"
                  ariaLabel="Auto-help signature editor"
                  minHeight={120}
                />
              ) : null}
              <p className="text-[11px] text-muted-foreground/75">Tip: copy a signature from Outlook and paste it here — the formatting is kept.</p>

              <p className="pt-1 text-xs font-medium text-foreground/85" id="kh-sig-spacing">Line spacing</p>
              <div className="inline-flex rounded-lg border border-input bg-card p-0.5" role="radiogroup" aria-labelledby="kh-sig-spacing">
                {SPACINGS.map(([value, label, hint]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={spacing === value}
                    title={hint}
                    disabled={!canManage}
                    onClick={() => setSpacing(value)}
                    className={`tp-focus-ring rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${spacing === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <p className="pt-1 text-xs font-medium text-foreground/85" id="kh-sig-with">When an agent sends the answer</p>
              <div className="space-y-1.5" role="radiogroup" aria-labelledby="kh-sig-with">
                {WITH.map(([value, label, hint]) => (
                  <label key={value} className="flex cursor-pointer items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name="kh-sig-with"
                      value={value}
                      checked={withMode === value}
                      disabled={!canManage}
                      onChange={() => setWithMode(value)}
                      className="tp-focus-ring mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]"
                    />
                    <span>
                      <span className="block text-foreground/85">{label}</span>
                      <span className="block text-xs text-muted-foreground">{hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-foreground/85">Requesters see</p>
              <div className={`tp-light rounded-lg border border-border bg-card p-3 text-sm text-card-foreground ${enabled ? '' : 'opacity-60'}`} data-testid="auto-help-signature-preview">
                <p className="text-muted-foreground">…the answer and the follow-up line, then:</p>
                <div className="mt-2">
                  {String(html || '').trim()
                    ? <SafeHtml html={applySignatureSpacing(html, spacing)} isDark={false} />
                    : <p className="text-muted-foreground/75">Nothing yet — paste a signature on the left.</p>}
                </div>
                {withMode === 'both' && <p className="mt-2 text-xs text-muted-foreground">…then the sending agent&rsquo;s own signature.</p>}
              </div>
              {!enabled && <p className="text-[11px] text-muted-foreground/75">Switched off — nothing above is added until you switch it on.</p>}
            </div>
          </div>

          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy || !dirty}
                onClick={() => save({ signatureHtml: html, signatureText: text, signatureSpacing: spacing, signatureWith: withMode })}
                className="tp-focus-ring h-9 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                Save signature
              </button>
              {dirty && (
                <button
                  type="button"
                  onClick={() => { setHtml(settings?.signatureHtml || ''); setText(settings?.signatureText || ''); setSpacing(settings?.signatureSpacing || 'tight'); setWithMode(settings?.signatureWith || 'replace'); }}
                  className="tp-focus-ring h-9 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted"
                >
                  Cancel
                </button>
              )}
            </div>
          )}
        </div>
      </Row>
    </SettingsSection>
  );
}
