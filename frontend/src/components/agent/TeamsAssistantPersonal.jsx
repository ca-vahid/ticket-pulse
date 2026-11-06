import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, MessageCircleQuestion } from 'lucide-react';
import { agentAPI } from '../../services/api';
import { SwitchRow } from '../ui/switch';
import { formatPacificWhen, formatPacificFull } from '../../utils/ticketDates';

/**
 * "Ask Ticket Pulse in Teams (advanced)" (plans/TEAMS_BOT_COMMANDS_PLAN.md,
 * product decision 5 Nov 2026): the person's own switch, on by default, and their own
 * questions to the bot from the last 180 days — question, what they were
 * shown, when. Only their own questions appear here; super admins can also
 * review them in Settings → Teams (Latest questions).
 *
 * Renders nothing when the API is not there (older server, tests that mock
 * only the Teams panel).
 */
const SHOWN = 5;

export default function TeamsAssistantPersonal() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);

  const load = useCallback(async () => {
    if (typeof agentAPI.getTeamsAssistant !== 'function') return;
    try {
      const res = await agentAPI.getTeamsAssistant();
      setData(res?.data || res || null);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Could not load');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = async () => {
    if (!data || busy) return;
    setBusy(true);
    setError(null);
    const next = !data.enabled;
    setData({ ...data, enabled: next });
    try {
      const res = await agentAPI.saveTeamsAssistant({ enabled: next });
      setData(res?.data || res);
    } catch (err) {
      setData({ ...data, enabled: !next });
      setError(err?.response?.data?.message || err?.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  if (!data && !error) return null;
  const turns = data?.turns || [];
  const shown = all ? turns : turns.slice(0, SHOWN);

  return (
    <div className="mt-5" data-testid="teams-assistant-personal">
      <div className="text-xs font-semibold text-muted-foreground">Ask in plain words</div>
      {data && (
        <SwitchRow
          label="Ask Ticket Pulse in Teams (advanced)"
          description={data.enabled
            ? 'Ask the bot things like "what approvals are waiting for me?", "my overdue tickets" or "who\'s out today?" and it answers from your own tickets, approvals and time away. Super admins can review the questions people ask. Turn it off and the bot works as it did before: longer messages are offered as new tickets.'
            : 'Off: the bot works as it did before. Longer messages are offered as new tickets, and "my tickets" lists your open tickets.'}
          checked={data.enabled === true}
          onCheckedChange={toggle}
          disabled={busy}
          testId="teams-assistant-switch"
          className="py-2"
        />
      )}
      {error && <div role="alert" className="mt-1 text-xs text-red-700 dark:text-red-200">{error}</div>}

      {data && (
        <section aria-labelledby="my-teams-questions" className="mt-2">
          <div className="flex items-baseline justify-between gap-2">
            <h4 id="my-teams-questions" className="text-xs font-semibold text-muted-foreground">My Teams questions</h4>
            <span className="text-[11px] text-muted-foreground/75">You and super admins can see these · kept {data.retentionDays || 180} days</span>
          </div>
          {turns.length === 0 ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <MessageCircleQuestion className="h-3.5 w-3.5" aria-hidden="true" />
              Nothing yet. Questions you ask the bot in Teams show here.
            </p>
          ) : (
            <ul className="mt-1 divide-y divide-border border-y border-border">
              {shown.map((t) => (
                <li key={t.id} className="grid grid-cols-1 gap-x-4 gap-y-0.5 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-foreground" title={t.question}>{t.question}</div>
                    {t.answer && <div className="truncate text-xs text-muted-foreground" title={t.answer}>{t.answer}</div>}
                  </div>
                  <time dateTime={new Date(t.at).toISOString()} title={formatPacificFull(t.at)} className="whitespace-nowrap text-xs text-muted-foreground sm:text-right">
                    {formatPacificWhen(t.at)}
                  </time>
                </li>
              ))}
            </ul>
          )}
          {turns.length > SHOWN && (
            <button
              type="button"
              onClick={() => setAll((v) => !v)}
              aria-expanded={all}
              className="tp-focus-ring mt-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs font-semibold text-primary hover:bg-muted"
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 motion-off:transition-none ${all ? 'rotate-180' : ''}`} aria-hidden="true" />
              {all ? 'Show fewer' : `Show all ${turns.length}`}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
