import { useEffect, useMemo, useState } from 'react';
import { Activity, AtSign, CheckCircle2, RefreshCw, Save, XCircle } from 'lucide-react';
import { settingsAPI } from '../../services/api';

/**
 * Sender identity card (Phase EB) — sits at the top of the Email Branding
 * tab. Lets admins set the per-workspace From display name ("Ticket Pulse
 * IT") layered over the global default ("Ticket Pulse"), with a live
 * inbox-style preview of how recipients will see it.
 *
 * Honesty note baked into the copy: the name is guaranteed on SendGrid
 * sends; Microsoft 365 mailbox sends show the mailbox's directory name.
 */
export default function SenderIdentityCard() {
  const [identity, setIdentity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [draftName, setDraftName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await settingsAPI.getSenderIdentity();
        if (cancelled) return;
        const data = response.data || null;
        setIdentity(data);
        setDraftName(data?.fromName || '');
        setLoadError(null);
      } catch (error) {
        if (!cancelled) setLoadError(error.message || 'Could not load sender identity');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const globalName = identity?.globalFromName || 'Ticket Pulse';
  const previewName = draftName.trim() || globalName;
  const previewAddress = identity?.fromEmail || identity?.mailboxAddress || 'ticketpulse@example.com';
  const previewInitial = useMemo(() => (previewName.trim()[0] || 'T').toUpperCase(), [previewName]);
  const dirty = (identity?.fromName || '') !== draftName.trim() && !(identity?.fromName == null && draftName.trim() === '');
  // Replies-as-agent toggle (Phase SN2): saved on flip, independent of the
  // display-name Save button. Missing field (older backend) = the default ON.
  const replyUsesAgentName = identity?.replyUsesAgentName !== false;
  const [togglingReplyName, setTogglingReplyName] = useState(false);
  const [toggleError, setToggleError] = useState(null);

  const toggleReplyUsesAgentName = async () => {
    if (togglingReplyName) return;
    setTogglingReplyName(true);
    setToggleError(null);
    try {
      const response = await settingsAPI.updateSenderIdentity({ replyUsesAgentName: !replyUsesAgentName });
      const data = response.data || null;
      if (data) {
        setIdentity(data);
        setDraftName(data.fromName || '');
      }
    } catch (error) {
      setToggleError(error.message || 'Could not update the reply sender setting');
    } finally {
      setTogglingReplyName(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus(null);
    try {
      const response = await settingsAPI.updateSenderIdentity({ fromName: draftName.trim() });
      const data = response.data || null;
      setIdentity(data);
      setDraftName(data?.fromName || '');
      setSaveStatus({ success: true, message: data?.fromName ? `Saved. Emails will show "${data.effectiveFromName}".` : `Saved. This workspace inherits "${data?.effectiveFromName || globalName}".` });
    } catch (error) {
      setSaveStatus({ success: false, message: error.message || 'Could not save sender identity' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
        <Activity className="h-4 w-4 animate-spin" />
        Loading sender identity...
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {loadError}
      </div>
    );
  }

  return (
    <section aria-label="Sender identity" className="mb-4 rounded-md border border-slate-200 bg-slate-50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <AtSign className="h-4 w-4 text-slate-700" />
            <h4 className="text-sm font-semibold text-slate-950">Sender identity</h4>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            How outbound email from this workspace shows up in recipients&apos; inboxes.
            Guaranteed for SendGrid sends; Microsoft 365 mailbox sends display the mailbox&apos;s directory name.
          </p>
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !dirty}
          className="tp-focus-ring inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-3 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save
        </button>
      </div>

      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div className="grid gap-3">
          <label className="block text-xs font-medium uppercase text-gray-500">
            From address
            <input
              value={identity?.fromEmail || '(SendGrid not configured)'}
              readOnly
              aria-label="From address (read-only)"
              className="mt-1 w-full cursor-default rounded-md border border-gray-200 bg-slate-100 px-3 py-2 text-sm normal-case text-gray-600 focus:outline-none"
            />
            <span className="mt-1 block text-[11px] font-normal normal-case text-slate-500">
              Set globally in Settings &rarr; Notification Providers.
              {identity?.mailboxAddress ? ` Mailbox sends use ${identity.mailboxAddress}.` : ''}
            </span>
          </label>

          <label className="block text-xs font-medium uppercase text-gray-500">
            Display name
            <input
              value={draftName}
              onChange={(event) => { setDraftName(event.target.value); setSaveStatus(null); }}
              placeholder={globalName}
              maxLength={80}
              aria-label="From display name for this workspace"
              className="tp-focus-ring mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm normal-case text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
            <span className="mt-1 block text-[11px] font-normal normal-case text-slate-500">
              Leave blank to inherit the global default (&quot;{globalName}&quot;). Example: &quot;Ticket Pulse IT&quot;.
            </span>
          </label>

          {saveStatus && (
            <div
              role="status"
              className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs ${saveStatus.success ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}
            >
              {saveStatus.success ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
              <span>{saveStatus.message}</span>
            </div>
          )}

          <div className="rounded-md border border-slate-200 bg-white px-3 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-700">Replies show the agent&apos;s name</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  Requester replies sent from Ticket Pulse go out as the replying agent
                  (&quot;Susan Xu &lt;{previewAddress}&gt;&quot;), matching FreshService. Off: replies use the
                  display name above. Approvals, workflow and system mails always use the display name.
                  Guaranteed for SendGrid sends; Microsoft 365 mailbox sends are best-effort
                  (Exchange usually shows the mailbox&apos;s directory name).
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={replyUsesAgentName}
                aria-label={`Replies show the agent's name ${replyUsesAgentName ? 'on' : 'off'}`}
                onClick={toggleReplyUsesAgentName}
                disabled={togglingReplyName}
                className={`tp-focus-ring relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-60 ${replyUsesAgentName ? 'bg-blue-600' : 'bg-slate-300'}`}
              >
                <span
                  className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform"
                  style={{ transform: replyUsesAgentName ? 'translateX(16px)' : 'translateX(0)' }}
                  aria-hidden="true"
                />
              </button>
            </div>
            {toggleError && <p className="mt-1.5 text-xs text-red-600" role="alert">{toggleError}</p>}
          </div>
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Inbox preview</div>
          <div data-testid="sender-identity-preview" className="rounded-md border border-gray-200 bg-white p-3 shadow-subtle">
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm font-semibold text-white"
              >
                {previewInitial}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="truncate text-sm font-bold text-slate-900">{previewName}</span>
                  <span className="truncate text-xs text-slate-500">&lt;{previewAddress}&gt;</span>
                </div>
                <div className="truncate text-xs text-slate-700">Your ticket has been updated [TP-1024]</div>
                <div className="truncate text-xs text-slate-400">Hi there — an agent replied to your request...</div>
              </div>
            </div>
            <div
              data-testid="sender-identity-reply-preview"
              className="mt-2 flex items-center gap-3 border-t border-dashed border-slate-200 pt-2"
            >
              <span
                aria-hidden="true"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-sm font-semibold text-white"
              >
                {replyUsesAgentName ? 'S' : previewInitial}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="truncate text-sm font-bold text-slate-900">{replyUsesAgentName ? 'Susan Xu' : previewName}</span>
                  <span className="truncate text-xs text-slate-500">&lt;{previewAddress}&gt;</span>
                </div>
                <div className="truncate text-xs text-slate-700">Re: Laptop will not boot [TP-1024]</div>
                <div className="truncate text-xs text-slate-400">
                  {replyUsesAgentName ? 'Agent reply — sent under the agent\'s own name' : 'Agent reply — sent under the workspace name'}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
