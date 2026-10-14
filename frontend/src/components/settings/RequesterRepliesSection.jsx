import { useEffect, useState } from 'react';
import { MessageSquareReply } from 'lucide-react';
import { ticketsAPI } from '../../services/api';

/**
 * Settings → Ticket Ops → When a requester replies (13 Oct 2026).
 *
 * Two per-workspace switches for what Ticket Pulse does by itself after a
 * requester reply has been recorded (and the reopen workflow had its turn):
 *  - the owner is away for more than a day → send the ticket back for
 *    assignment, with a private note saying why;
 *  - the reply reopens a ticket resolved more than a day ago and reads like
 *    new work → suggest splitting it into its own ticket (never automatic).
 * On for IT, off elsewhere until an admin saves a choice.
 */
const SWITCHES = [
  {
    key: 'rerouteWhenOwnerAway',
    label: 'Send the ticket back for assignment when its owner is away',
    help: 'When a requester replies and the owner is away for more than one working day, the owner is cleared and the ticket goes through assignment again, with a private note saying why. A single day off, working from home and half days do not count.',
  },
  {
    key: 'suggestNewRequest',
    label: 'Suggest a new ticket when a reply is really a new request',
    help: 'When a reply reopens a ticket that was resolved more than a day ago and asks for something else, the ticket shows a suggestion to split the reply into its own ticket. Nothing is split until a person says so.',
  },
];

function Switch({ checked, disabled, label, onClick }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked === true}
      aria-label={`${label} ${checked ? 'on' : 'off'}`}
      onClick={onClick}
      disabled={disabled}
      className={`tp-focus-ring relative inline-flex h-5 w-9 shrink-0 rounded-full disabled:opacity-60 ${checked ? 'bg-primary' : 'bg-muted-foreground/40'}`}
    >
      <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-card shadow" style={{ transform: checked ? 'translateX(16px)' : 'translateX(0)' }} aria-hidden="true" />
    </button>
  );
}

export default function RequesterRepliesSection() {
  const [rules, setRules] = useState(null); // null = loading
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => ticketsAPI.getRequesterReplySettings())
      .then((res) => { if (!cancelled) setRules((res?.data?.data ?? res?.data) || {}); })
      .catch(() => { if (!cancelled) setRules({}); });
    return () => { cancelled = true; };
  }, []);

  const toggle = async (key) => {
    if (rules === null || busy) return;
    setBusy(key);
    setError(null);
    try {
      const res = await ticketsAPI.updateRequesterReplySettings({ [key]: !(rules[key] === true) });
      setRules((res?.data?.data ?? res?.data) || {});
    } catch (e) {
      setError(e.response?.data?.message || e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="tp-card rounded-xl p-4" aria-label="When a requester replies">
      <div className="flex items-center gap-2 mb-1">
        <MessageSquareReply className="w-4 h-4 text-blue-500" aria-hidden="true" />
        <h3 className="text-sm font-bold text-foreground">When a requester replies</h3>
      </div>
      <p className="text-xs text-muted-foreground/75 mb-3">
        What Ticket Pulse does on its own after a requester replies. Reopening the ticket itself is the &ldquo;Reopen on requester reply&rdquo; mail workflow.
      </p>
      <ul className="divide-y divide-border/60">
        {SWITCHES.map((s) => (
          <li key={s.key} className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground/85">{s.label}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{s.help}</p>
            </div>
            <Switch
              checked={rules?.[s.key] === true}
              disabled={rules === null || busy !== null}
              label={s.label}
              onClick={() => toggle(s.key)}
            />
          </li>
        ))}
      </ul>
      {error && <p className="text-xs text-red-600 dark:text-red-300 mt-2" role="alert">{error}</p>}
    </section>
  );
}
