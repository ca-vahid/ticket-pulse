import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Activity, ChevronDown, Search, UserPlus, X } from 'lucide-react';
import { teamsAdminAPI } from '../../services/api';
import { SwitchRow, SwitchCue } from '../ui/switch';
import { formatPacificWhen, formatPacificFull } from '../../utils/ticketDates';

/**
 * Settings → Teams → Ask Ticket Pulse in Teams (plans/TEAMS_BOT_COMMANDS_PLAN.md).
 * A pick-list for the mode, a people picker for the pilot, the monthly AI
 * limit and the sensitive switch — settings in the UI, never typed JSON
 * (product decision). Super admins also see the latest questions (the Shadow log).
 * Renders nothing when the API is not there (older server, panel tests).
 */
const MODES = [
  { value: 'off', label: 'Off', help: 'No AI. Questions still get an answer card from keywords (approvals, time away, tickets, who is out) instead of the help card.' },
  { value: 'shadow', label: 'Shadow', help: 'Everyone gets the keyword answer. The AI answers the same question in the background and only the log sees what it would have said.' },
  { value: 'pilot', label: 'Pilot', help: 'The people below get real AI answers. Everyone else stays in Shadow.' },
  { value: 'on', label: 'On', help: 'Everyone connected in this workspace gets AI answers.' },
];

const money = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : `$${Number(n).toFixed(2)}`);
const OUTCOME_WORD = { answered: 'answered', fallback: 'AI failed — keywords', timeout: 'AI too slow — keywords', error: 'AI error', capped: 'over the limit', rate_limited: 'rate limited' };

function PeoplePicker({ people, value, onChange, disabled }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef(null);
  const byEmail = useMemo(() => new Map(people.map((p) => [p.email, p])), [people]);
  const matches = useMemo(() => {
    const chosen = new Set(value);
    const t = q.trim().toLowerCase();
    return people.filter((p) => !chosen.has(p.email) && (!t || p.name.toLowerCase().includes(t) || p.email.includes(t))).slice(0, 8);
  }, [people, q, value]);

  const add = (p) => {
    if (!p) return;
    onChange([...value, p.email]);
    setQ('');
    setActive(0);
    inputRef.current?.focus();
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((i) => Math.min(i + 1, matches.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && open && matches[active]) { e.preventDefault(); add(matches[active]); }
    else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div>
      {value.length > 0 ? (
        <ul className="divide-y divide-border border-y border-border" aria-label="Pilot people">
          {value.map((email) => {
            const p = byEmail.get(email);
            return (
              <li key={email} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                <span className="min-w-0 truncate">
                  <span className="text-foreground">{p?.name || email}</span>
                  {p?.name && p.name !== email && <span className="ml-2 text-xs text-muted-foreground">{email}</span>}
                </span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(value.filter((x) => x !== email))}
                  className="tp-focus-ring inline-flex flex-shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                  aria-label={`Remove ${p?.name || email} from the pilot`}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" /> Remove
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">Nobody yet.</p>
      )}
      <div className="relative mt-2 max-w-md">
        <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open && matches.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
          aria-label="Add a person to the pilot"
          placeholder="Add a person — type a name"
          value={q}
          disabled={disabled}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKey}
          className="tp-focus-ring h-8 w-full rounded-lg border border-input bg-card pl-8 pr-2.5 text-sm text-foreground placeholder:text-muted-foreground/75"
        />
        {open && matches.length > 0 && (
          <ul id={listId} role="listbox" className="settings-scrollbar absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-border bg-card py-1 shadow-soft">
            {matches.map((p, i) => (
              <li
                key={p.email}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => { e.preventDefault(); add(p); }}
                onMouseEnter={() => setActive(i)}
                className={`flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm ${i === active ? 'bg-muted' : ''}`}
              >
                <UserPlus className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 truncate text-foreground">{p.name}</span>
                <span className="ml-auto truncate text-xs text-muted-foreground">{p.email}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function TeamsAssistantSettings() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [cap, setCap] = useState('');
  const [turns, setTurns] = useState(null);
  const [showLog, setShowLog] = useState(false);
  const modeId = useId();
  const capId = useId();

  const load = useCallback(async () => {
    if (typeof teamsAdminAPI.getAssistant !== 'function') return;
    try {
      const res = await teamsAdminAPI.getAssistant();
      const d = res?.data || res;
      setData(d);
      setCap(String(d?.settings?.monthlyCapUsd ?? 25));
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Could not load');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (patch, label) => {
    setBusy(true);
    setError(null);
    try {
      const res = await teamsAdminAPI.saveAssistant(patch);
      const settings = res?.data || res;
      setData((d) => ({ ...d, settings }));
      setCap(String(settings.monthlyCapUsd));
      setNotice(label);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const openLog = async () => {
    const next = !showLog;
    setShowLog(next);
    if (next && turns === null) {
      try {
        const res = await teamsAdminAPI.assistantTurns({ take: 25 });
        setTurns(res?.data || res || []);
      } catch (err) {
        setTurns([]);
        setError(err?.response?.data?.message || err?.message || 'Could not load the activity');
      }
    }
  };

  if (!data && !error) return null;
  const s = data?.settings;
  const mode = MODES.find((m) => m.value === s?.mode) || MODES[0];
  const spend = data?.spend || {};

  return (
    <section aria-labelledby="teams-assistant-heading" data-testid="teams-assistant-settings">
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <h3 id="teams-assistant-heading" className="text-sm font-semibold text-foreground">Ask Ticket Pulse in Teams</h3>
        <SwitchCue>Early access</SwitchCue>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        People ask the bot in plain words — &ldquo;what approvals are waiting for me?&rdquo;, &ldquo;my overdue tickets&rdquo;, &ldquo;who&apos;s out today?&rdquo; — and get a card built from their own tickets, approvals and time away. The AI only reads; approving stays on the approval card with its confirm step. Each person can switch it off for themselves under Mail &amp; alerts.
      </p>
      {error && <div role="alert" className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-200">{error}</div>}

      {s && (
        <div className="space-y-4">
          <div>
            <label htmlFor={modeId} className="block text-xs font-semibold text-muted-foreground">Mode</label>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <select
                id={modeId}
                value={s.mode}
                disabled={busy}
                onChange={(e) => save({ mode: e.target.value }, `Mode: ${MODES.find((m) => m.value === e.target.value)?.label}`)}
                className="tp-focus-ring h-8 rounded-lg border border-input bg-card px-2 text-sm text-foreground"
                data-testid="teams-assistant-mode"
              >
                {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              {busy && <Activity className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
              {notice && !busy && <span className="text-xs text-muted-foreground" role="status">{notice} · saved</span>}
            </div>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{mode.help}</p>
          </div>

          <div>
            <div className="text-xs font-semibold text-muted-foreground">Pilot people</div>
            <p className="mb-1.5 text-xs text-muted-foreground">
              {s.mode === 'pilot' ? 'They get real AI answers now.' : 'Used when the mode is Pilot. Until then they are treated like everyone else.'}
            </p>
            <PeoplePicker
              people={data.people || []}
              value={s.pilotEmails || []}
              disabled={busy}
              onChange={(pilotEmails) => save({ pilotEmails }, 'Pilot people')}
            />
          </div>

          <div>
            <label htmlFor={capId} className="block text-xs font-semibold text-muted-foreground">Monthly AI limit</label>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground" aria-hidden="true">$</span>
              <input
                id={capId}
                type="number"
                min="1"
                max="1000"
                step="1"
                inputMode="decimal"
                value={cap}
                disabled={busy}
                onChange={(e) => setCap(e.target.value)}
                className="tp-focus-ring h-8 w-24 rounded-lg border border-input bg-card px-2 text-sm tabular-nums text-foreground"
              />
              <button
                type="button"
                disabled={busy || Number(cap) === Number(s.monthlyCapUsd)}
                onClick={() => save({ monthlyCapUsd: Number(cap) }, 'Monthly limit')}
                className="tp-focus-ring h-8 rounded-lg border border-input bg-card px-3 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
              >
                Save limit
              </button>
              <span className="text-xs text-muted-foreground tabular-nums" data-testid="teams-assistant-spend">
                This month: {spend.unknown ? 'could not be read' : `${money(spend.spentUsd)} of ${money(s.monthlyCapUsd)}`}
              </span>
            </div>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">At the limit the AI stops until the 1st and people get the keyword answers. The super admins get one e-mail when it is reached.</p>
          </div>

          <div className="max-w-2xl rounded-lg border border-border bg-card px-3">
            <SwitchRow
              label="Keep ticket subjects away from the AI"
              description="For workspaces where subjects name people (HR, onboarding). The AI sees ids and statuses only; the card still shows the subject to the person asking."
              checked={s.sensitive === true}
              disabled={busy}
              onCheckedChange={(v) => save({ sensitive: v }, v ? 'Subjects stay away from the AI' : 'Subjects may go to the AI')}
              className="py-2.5"
            />
          </div>

          {data.canSeeActivity && (
            <div>
              <button type="button" onClick={openLog} aria-expanded={showLog} className="tp-focus-ring inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs font-semibold text-primary hover:bg-muted">
                <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 motion-off:transition-none ${showLog ? 'rotate-180' : ''}`} aria-hidden="true" />
                Latest questions (super admins)
              </button>
              {showLog && (
                turns === null ? (
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><Activity className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Loading…</div>
                ) : turns.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">No questions yet.</p>
                ) : (
                  <ul className="settings-scrollbar mt-2 max-h-96 divide-y divide-border overflow-y-auto border-y border-border">
                    {turns.map((t) => (
                      <li key={t.id} className="py-2 text-xs">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                          <span className="min-w-0 truncate text-sm font-medium text-foreground" title={t.question}>{t.question}</span>
                          <time title={formatPacificFull(t.createdAt)} className="whitespace-nowrap text-muted-foreground">{formatPacificWhen(t.createdAt)}</time>
                        </div>
                        <div className="text-muted-foreground">
                          {t.email} · {t.mode}{t.outcome ? ` · ${OUTCOME_WORD[t.outcome] || t.outcome}` : ''}{t.tools?.length ? ` · ${[...new Set(t.tools)].join(', ')}` : ''}{t.latencyMs ? ` · ${(t.latencyMs / 1000).toFixed(1)} s` : ''}{t.feedback ? ` · marked ${t.feedback === 'useful' ? 'useful' : 'not right'}` : ''}
                        </div>
                        {t.lead && <div className="mt-0.5 text-foreground/85"><span className="text-muted-foreground">{t.mode === 'shadow' ? 'AI would have said: ' : 'AI said: '}</span>{t.lead}</div>}
                        {t.replySummary && <div className="text-muted-foreground">Shown: {t.replySummary}</div>}
                      </li>
                    ))}
                  </ul>
                )
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
