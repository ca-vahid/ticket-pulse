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
  ['exact', 'As pasted', 'Nothing is adjusted: for a designed signature that carries its own spacing'],
];
/** The signature as requesters get it: "As pasted" leaves every margin alone. */
const spaced = (html, spacing) => (spacing === 'exact' ? html : applySignatureSpacing(html, spacing));
/** Plain text of an HTML signature (the text part of the e-mail). */
const NL = String.fromCharCode(10);
const NBSP = String.fromCharCode(160);
function plainOf(html) {
  const el = document.createElement('div');
  el.innerHTML = String(html || '');
  el.querySelectorAll('br').forEach((node) => node.replaceWith(NL));
  el.querySelectorAll('p,div,tr,li').forEach((node) => node.append(NL));
  return (el.textContent || '')
    .split(NL)
    .map((line) => line.split(NBSP).join(' ').split(' ').filter(Boolean).join(' '))
    .filter(Boolean)
    .join(NL);
}
/** A table or picture signature is edited as HTML: the rich editor would flatten it. */
const needsSource = (html) => /<table|<img/i.test(String(html || ''));
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
  const [source, setSource] = useState(() => needsSource(settings?.signatureHtml));

  useEffect(() => {
    setHtml(settings?.signatureHtml || '');
    setText(settings?.signatureText || '');
    setSpacing(settings?.signatureSpacing || 'tight');
    setWithMode(settings?.signatureWith || 'replace');
    if (needsSource(settings?.signatureHtml)) setSource(true);
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
              <div className="flex items-center gap-3">
                <p className="text-xs font-medium text-foreground/85">Signature</p>
                {canManage && (
                  <button
                    type="button"
                    aria-pressed={source}
                    onClick={() => setSource((v) => !v)}
                    disabled={source && needsSource(html)}
                    title={source && needsSource(html) ? 'A signature with a table or a picture is edited as HTML so its layout is kept' : undefined}
                    className="tp-focus-ring ml-auto rounded px-1.5 text-xs font-medium text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
                    data-testid="signature-source-toggle"
                  >
                    {source ? 'Editing the HTML' : 'Edit the HTML'}
                  </button>
                )}
              </div>
              {canManage && source ? (
                <textarea
                  value={html}
                  onChange={(e) => { setHtml(e.target.value); setText(plainOf(e.target.value)); }}
                  spellCheck={false}
                  rows={12}
                  aria-label="Auto-help signature HTML"
                  placeholder="Paste the signature’s HTML here: tables, colours and the logo are kept exactly."
                  className="tp-focus-ring settings-scrollbar w-full rounded-lg border border-input bg-card px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground placeholder:text-muted-foreground/75"
                  data-testid="signature-source"
                />
              ) : canManage ? (
                <RichTextEditor
                  value={html}
                  onChange={(next) => { setHtml(next.html); setText(next.text); }}
                  placeholder="Paste or write the signature — tables, colours and logos are kept…"
                  ariaLabel="Auto-help signature editor"
                  minHeight={120}
                />
              ) : null}
              <p className="text-[11px] text-muted-foreground/75">
                {source
                  ? 'Paste the HTML of a designed signature (a table with a logo). Choose “As pasted” below so its own spacing is kept.'
                  : 'Tip: copy a signature from Outlook and paste it here. For a table with a logo, use “Edit the HTML”.'}
              </p>

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
                    ? <SafeHtml html={spaced(html, spacing)} isDark={false} />
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
