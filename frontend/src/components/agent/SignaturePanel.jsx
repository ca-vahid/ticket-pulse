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
      });
      const data = res.data || {};
      setHtml(data.html || '');
      setText(data.text || '');
      setEnabled(data.enabled !== false);
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
        </div>
        <div className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Preview</label>
          <div className={`rounded-lg border border-dashed border-border bg-muted/30 p-3 ${enabled ? '' : 'opacity-50'}`} data-testid="signature-preview">
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
