import { useCallback, useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { agreementSentence } from '../mailReview/mailReviewText';

/**
 * Settings → Ticket Mailboxes → Mail triage (plans/MAIL_TRIAGE_PLAN.md): the
 * AI that reads held e-mail and suggests what to do with it. A three-way
 * pick-list for the mode (it is not an on/off switch), the workspace guidance
 * that is appended to the prompt, the monthly limit, and the read-only 30-day
 * agreement. Nothing is saved until Save is pressed: switching to On changes
 * what happens to mail, so it should never be a slip of the mouse.
 * Renders nothing when the API is not there (older server, panel tests).
 */
export const MAIL_TRIAGE_MODES = [
  { value: 'off', label: 'Off', help: 'The AI does not read held e-mail. Everything waits for a person, as before.' },
  { value: 'shadow', label: 'Shadow', help: 'The AI reads each held e-mail and suggests what to do. Nothing is applied: Mail review shows the suggestion and people decide.' },
  { value: 'on', label: 'On', help: 'Only suggestions the AI is sure about, and only adding to a ticket or making a new one. It never discards mail.' },
];
export const GUIDANCE_MAX = 2000;
const GUIDANCE_PLACEHOLDER = 'Examples:\nRemittance advice notices need no ticket.\nA reply to an invoice reminder belongs on that invoice’s ticket, even when the subject changed.\nMail from our bank is always a new ticket.';

export default function MailTriageSettings() {
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const modeId = useId();
  const guidanceId = useId();
  const capId = useId();

  const take = (d) => {
    const next = { mode: d?.mode || 'off', guidance: d?.guidance || '', monthlyCapUsd: d?.monthlyCapUsd ?? 25, stats: d?.stats || null };
    setSaved(next);
    setForm({ mode: next.mode, guidance: next.guidance, cap: String(next.monthlyCapUsd) });
  };

  const load = useCallback(async () => {
    if (typeof ticketsAPI.getMailTriageSettings !== 'function') return;
    try {
      const res = await ticketsAPI.getMailTriageSettings();
      if (res?.data || res?.mode) take(res.data || res);
    } catch (err) {
      // An older server has no such route: show nothing rather than an error.
      if (err?.status !== 404) setError(err?.response?.data?.message || err?.message || 'Could not load Mail triage');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!form && !error) return null;

  const capNumber = Number(form?.cap);
  const capValid = form ? form.cap !== '' && Number.isFinite(capNumber) && capNumber >= 0 : false;
  const dirty = Boolean(form && saved) && (form.mode !== saved.mode || form.guidance !== saved.guidance || capNumber !== Number(saved.monthlyCapUsd));
  const mode = MAIL_TRIAGE_MODES.find((m) => m.value === form?.mode) || MAIL_TRIAGE_MODES[0];
  const agreement = agreementSentence(saved?.stats?.last30);
  const judged = saved?.stats?.last30?.judged;

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await ticketsAPI.saveMailTriageSettings({ mode: form.mode, guidance: form.guidance.trim(), monthlyCapUsd: capNumber });
      take({ ...saved, ...(res?.data || res || {}), stats: (res?.data || res)?.stats || saved?.stats });
      setNotice('Saved');
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  const edit = (patch) => { setNotice(null); setForm((f) => ({ ...f, ...patch })); };

  return (
    <section aria-labelledby="mail-triage-heading" className="border-t border-border/60 pt-3" data-testid="mail-triage-settings">
      <h3 id="mail-triage-heading" className="text-sm font-semibold text-foreground">Mail triage (AI review of held e-mail)</h3>
      <p className="mb-3 mt-0.5 max-w-2xl text-xs text-muted-foreground">
        When Ticket Pulse can&apos;t tell which ticket an e-mail belongs to, it holds it. The AI reads each held e-mail and suggests one of three things:
        add it to a ticket, make a new ticket, or say it needs none. People review it under{' '}
        <Link to="/tickets/mail-review" className="tp-focus-ring rounded font-medium text-primary hover:underline">Tickets → Mail review</Link>.
      </p>
      {error && <div role="alert" className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-200">{error}</div>}

      {form && (
        <div className="space-y-4">
          <div>
            <label htmlFor={modeId} className="block text-xs font-semibold text-muted-foreground">Mode</label>
            <select
              id={modeId}
              value={form.mode}
              disabled={busy}
              onChange={(e) => edit({ mode: e.target.value })}
              className="tp-focus-ring mt-1 h-8 rounded-lg border border-input bg-card px-2 text-sm text-foreground"
              data-testid="mail-triage-mode"
            >
              {MAIL_TRIAGE_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground" data-testid="mail-triage-mode-help">
              {mode.value === 'on' && <span className="text-foreground/85">Applied automatically: </span>}
              {mode.help}
            </p>
          </div>

          <div>
            <label htmlFor={guidanceId} className="block text-xs font-semibold text-muted-foreground">Guidance for this workspace</label>
            <p className="mb-1 max-w-2xl text-xs text-muted-foreground">Plain sentences the AI reads with every e-mail. Use it to steer a judgement people keep changing.</p>
            <textarea
              id={guidanceId}
              rows={4}
              maxLength={GUIDANCE_MAX}
              value={form.guidance}
              disabled={busy}
              onChange={(e) => edit({ guidance: e.target.value.slice(0, GUIDANCE_MAX) })}
              placeholder={GUIDANCE_PLACEHOLDER}
              aria-describedby={`${guidanceId}-count`}
              className="tp-focus-ring block w-full max-w-2xl rounded-lg border border-input bg-card px-2.5 py-2 text-sm text-foreground placeholder:text-muted-foreground/75"
              data-testid="mail-triage-guidance"
            />
            <p id={`${guidanceId}-count`} className="mt-0.5 text-xs tabular-nums text-muted-foreground">
              {form.guidance.length.toLocaleString('en-US')} of {GUIDANCE_MAX.toLocaleString('en-US')} characters
            </p>
          </div>

          <div>
            <label htmlFor={capId} className="block text-xs font-semibold text-muted-foreground">Monthly AI limit</label>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-sm text-muted-foreground" aria-hidden="true">$</span>
              <input
                id={capId}
                type="number"
                min="0"
                max="1000"
                step="1"
                inputMode="decimal"
                value={form.cap}
                disabled={busy}
                onChange={(e) => edit({ cap: e.target.value })}
                className="tp-focus-ring h-8 w-24 rounded-lg border border-input bg-card px-2 text-sm tabular-nums text-foreground"
                data-testid="mail-triage-cap"
              />
              <span className="text-xs text-muted-foreground">US dollars a month</span>
            </div>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">At the limit the AI stops reading until the 1st; held e-mail then waits for a person. An e-mail costs well under a cent.</p>
          </div>

          <div>
            <div className="text-xs font-semibold text-muted-foreground">Agreement, last 30 days</div>
            <p className="mt-0.5 text-sm text-foreground/85" data-testid="mail-triage-agreement">
              {agreement ? `${agreement}.` : 'Nothing to measure yet.'}
              {judged !== null && judged !== undefined && <span className="text-muted-foreground"> {Number(judged).toLocaleString('en-US')} e-mails judged.</span>}
            </p>
            <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">Aim for 95% or more across at least 100 decisions before choosing On.</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy || !dirty || !capValid}
              onClick={save}
              className="tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              data-testid="mail-triage-save"
            >
              {busy && <Activity className="h-4 w-4 animate-spin motion-off:animate-none" aria-hidden="true" />}
              Save Mail triage
            </button>
            {notice && !busy && <span className="text-xs text-muted-foreground" role="status">{notice}</span>}
            {dirty && !busy && <span className="text-xs text-muted-foreground">Not saved yet</span>}
          </div>
        </div>
      )}
    </section>
  );
}
