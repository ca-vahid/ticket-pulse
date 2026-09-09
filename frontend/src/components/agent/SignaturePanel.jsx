import { useEffect, useState } from 'react';
import { Loader2, PenLine } from 'lucide-react';
import { agentAPI } from '../../services/api';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import RichTextEditor from '../tickets/RichTextEditor';
import { SafeHtml } from '../tickets/ticketUi';

/**
 * My email signature (QA 08-14 #1 / Mega 08-15 Phase D). Lives on the
 * Notifications page (account menu → Notifications) so agents AND
 * coordinators find it in the same place. Paste your Outlook signature
 * straight in — tables, colors and logos survive (Phase C rich paste).
 *
 * The signature is appended to OUTBOUND reply emails only: never to internal
 * notes or forwards, and never into the composer text (so drafts can't
 * double-append it). The ticket thread stays clean.
 */
export default function SignaturePanel() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [html, setHtml] = useState('');
  const [text, setText] = useState('');
  const [spacing, setSpacing] = useState('tight');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await agentAPI.getMySignature(workspaceId ? { workspaceId } : {});
        if (cancelled) return;
        const data = res.data || {};
        setEnabled(data.exists ? data.enabled !== false : true);
        setHtml(data.html || '');
        setText(data.text || '');
        setSpacing(data.spacing || 'tight');
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.message || err.message || 'Could not load your signature');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await agentAPI.saveMySignature({
        ...(workspaceId ? { workspaceId } : {}),
        enabled,
        html,
        text,
        spacing,
      });
      const data = res.data || {};
      setHtml(data.html || '');
      setText(data.text || '');
      setEnabled(data.enabled !== false);
      setSpacing(data.spacing || 'tight');
      setMessage('Saved');
      setTimeout(() => setMessage(null), 4000);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not save your signature');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[20vh] items-center justify-center rounded-lg border border-border bg-card">
        <Loader2 className="h-5 w-5 animate-spin text-blue-600 dark:text-blue-300" />
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-card shadow-sm" aria-label="Email signature">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300"><PenLine className="h-4 w-4" /></span>
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-foreground">Email signature</h2>
            <p className="text-xs text-muted-foreground">
              Appended to reply emails you send from tickets — never to internal notes.
            </p>
          </div>
          <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-muted-foreground">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              className="h-4 w-4 rounded border-input text-blue-600 dark:text-blue-300"
            />
            Enabled
          </label>
          {message && <span className="rounded bg-emerald-50 dark:bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-200">{message}</span>}
        </div>
        {error && <p className="mt-2 text-sm font-medium text-red-600 dark:text-red-300">{error}</p>}
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-2">
        <div className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Signature</label>
          <RichTextEditor
            value={html}
            onChange={(next) => { setHtml(next.html); setText(next.text); }}
            placeholder="Paste or write your signature — tables, colors and logos are kept…"
            ariaLabel="Signature editor"
            minHeight={140}
          />
          <p className="text-[11px] text-muted-foreground/75">
            Tip: copy your signature from Outlook and paste it here — formatting is preserved.
          </p>

          {/* Line spacing (QA 09-08): mail clients add their own paragraph
              margin to a pasted signature, which is what made these go out
              looser than the same signature from FreshService. */}
          <div className="pt-1">
            <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground" id="sig-spacing-label">
              Line spacing
            </label>
            <div className="mt-1.5 inline-flex rounded-lg border border-input bg-card p-0.5" role="radiogroup" aria-labelledby="sig-spacing-label">
              {[
                ['tight', 'Tight', 'Lines stack directly — matches Outlook and FreshService'],
                ['normal', 'Normal', 'A little breathing room between lines'],
                ['relaxed', 'Relaxed', 'Roomier, for short signatures'],
              ].map(([value, label, hint]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={spacing === value}
                  title={hint}
                  onClick={() => setSpacing(value)}
                  className={`tp-focus-ring rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                    spacing === value
                      ? 'bg-blue-600 text-white'
                      : 'text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground/75">
              Applied when the signature is added to an outgoing email. The preview shows exactly what recipients see.
            </p>
          </div>
        </div>
        <div className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Preview</label>
          <div
            className={`tp-sig-preview tp-sig-${spacing} rounded-lg border border-dashed border-border bg-muted/30 p-3 ${enabled ? '' : 'opacity-50'}`}
            data-testid="signature-preview"
            data-spacing={spacing}
          >
            {String(html || '').trim()
              ? <SafeHtml html={html} />
              : <p className="text-sm text-muted-foreground/75">Nothing yet — your reply emails go out unsigned.</p>}
          </div>
          {!enabled && (
            <p className="text-[11px] font-medium text-amber-600 dark:text-amber-300">
              Disabled — your signature is kept but not appended to emails.
            </p>
          )}
        </div>
      </div>

      <div className="flex justify-end border-t border-border px-4 py-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-wait disabled:opacity-60"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save signature
        </button>
      </div>
    </section>
  );
}
