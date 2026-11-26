import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, Check, CircleCheck, History, OctagonX, Power, TriangleAlert, Unplug,
} from 'lucide-react';
import {
  BACK_ON_LIMITS, FS_MODE_META, OFF_STEPS, PREFLIGHT_LINKS, PREFLIGHT_STATE, adoptCount, backOnQuestion, modeMeta,
  outcomeSentence, pacificWhen, shadowRows, shadowSentence, stepStates,
} from './freshserviceSwitchCopy';

/**
 * Settings → Workspaces → a workspace → FreshService (25 Nov 2026).
 *
 * Presentational only: everything arrives as props and every action goes out
 * through a callback, so it renders the same in tests and screenshot harnesses.
 * FreshServiceSwitchPanel is the container that loads and polls.
 *
 * Props: data = GET /workspaces/:id/freshservice ({ workspace, mode, record,
 * shadow, preflight, job, canWrite }), busy, error, onSetMode(mode),
 * onStartOff(confirmName), now (tests).
 */

const who = (email) => (email ? String(email).split('@')[0] : 'someone');

function ModeDot({ mode, className = '' }) {
  return <span aria-hidden="true" className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${modeMeta(mode).dot} ${className}`} />;
}

/** "FreshService: ● Shadow" — quiet coloured text for a workspace row. */
export function FreshServiceModeText({ mode }) {
  const meta = modeMeta(mode);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" data-testid="fs-mode-text" data-mode={mode}>
      <span className="text-muted-foreground">FreshService:</span>{' '}
      <ModeDot mode={mode} />
      <span className={`font-medium ${meta.text}`}>{meta.label}</span>
    </span>
  );
}

function SectionTitle({ children, id }) {
  return <h4 id={id} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h4>;
}

function PreflightList({ items }) {
  if (!items?.length) return null;
  return (
    <ul className="space-y-2" data-testid="fs-preflight">
      {items.map((item) => {
        const st = PREFLIGHT_STATE[item.state] || PREFLIGHT_STATE.warn;
        const Icon = item.state === 'ok' ? CircleCheck : item.state === 'block' ? OctagonX : TriangleAlert;
        const link = item.link ? PREFLIGHT_LINKS[item.link] : null;
        return (
          <li key={item.key} className="flex items-start gap-2 text-sm" data-state={item.state}>
            <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${st.text}`} aria-hidden="true" />
            <p className="min-w-0 text-foreground/85">
              <span className={`mr-1 font-semibold ${st.text}`}>{st.word}</span>{' '}
              {item.text}
              {/* What to do: with a link, the sentence ends on the link ("Set up the same in Mail Workflows."). */}
              {item.state !== 'ok' && item.todo && (
                <>
                  {' '}
                  {item.todo}
                  {link && (
                    <>
                      {' '}
                      <Link to={link.href} className="tp-focus-ring rounded font-medium text-primary hover:underline" title="Opens Settings for the workspace you have selected">
                        {link.label}
                      </Link>
                      .
                    </>
                  )}
                </>
              )}
              {item.state !== 'ok' && !item.todo && link && (
                <>
                  {' '}
                  <Link to={link.href} className="tp-focus-ring rounded font-medium text-primary hover:underline" title="Opens Settings for the workspace you have selected">
                    {link.label}
                  </Link>
                </>
              )}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function OffProgress({ job, workspaceName }) {
  const states = stepStates(job);
  const total = Number(job?.total) || 0;
  const labels = {
    check: 'Check',
    adopt: `Adopt ${total.toLocaleString('en-US')} ticket${total === 1 ? '' : 's'}`,
    switch: 'Switch off',
    done: 'Done',
  };
  const outcome = outcomeSentence(job, workspaceName);
  return (
    <div role="status" aria-live="polite" className="space-y-2" data-testid="fs-off-progress" data-state={job?.state}>
      <ol className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        {OFF_STEPS.map((step, i) => {
          const s = states[i];
          return (
            <li key={step} className="flex items-center gap-1.5" data-step={step} data-step-state={s}>
              {s === 'done' && <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-300" aria-hidden="true" />}
              {s === 'current' && <Activity className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />}
              {s === 'failed' && <OctagonX className="h-4 w-4 text-red-600 dark:text-red-300" aria-hidden="true" />}
              {s === 'todo' && <span className="inline-flex h-4 w-4 items-center justify-center text-[11px] font-semibold tabular-nums text-muted-foreground/75" aria-hidden="true">{i + 1}</span>}
              <span className={s === 'todo' ? 'text-muted-foreground' : 'font-medium text-foreground'}>{labels[step]}</span>
              <span className="sr-only">{s === 'done' ? '(done)' : s === 'current' ? '(in progress)' : s === 'failed' ? '(failed)' : ''}</span>
            </li>
          );
        })}
      </ol>
      {job?.state === 'running' && job.step === 'adopt' && (
        <p className="text-xs tabular-nums text-muted-foreground" data-testid="fs-off-count">Adopted {adoptCount(job)}</p>
      )}
      {outcome && (
        <p className={`text-sm ${job.state === 'failed' ? 'text-red-700 dark:text-red-300' : 'text-foreground'}`} data-testid="fs-off-outcome">{outcome}</p>
      )}
      {job?.state === 'done' && job.note && (
        <p className="text-sm text-amber-700 dark:text-amber-300" data-testid="fs-off-note-late">{job.note}</p>
      )}
      {job?.state === 'failed' && Array.isArray(job.failed) && job.failed.length > 5 && (
        <details className="text-xs text-muted-foreground">
          <summary className="tp-focus-ring cursor-pointer rounded">All {job.failed.length} tickets that could not be adopted</summary>
          <p className="mt-1 break-words">{job.failed.map((f) => f.ref).filter(Boolean).join(', ')}</p>
        </details>
      )}
    </div>
  );
}

export default function FreshServiceSwitchView({ data, busy = false, error = null, onSetMode, onStartOff, now = new Date() }) {
  const [offOpen, setOffOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [backOn, setBackOn] = useState(null); // 'connected' | 'shadow' while asking "turn it back on?"
  if (!data) return null;
  const { workspace = {}, mode, record, shadow, preflight, job, canWrite } = data;
  const name = workspace.name || 'this workspace';

  if (mode === 'never_connected') {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="fs-never-connected">
        <Unplug className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
        Never connected to FreshService — nothing to switch.
      </p>
    );
  }

  const running = job?.state === 'running';
  const showOffFlow = mode !== 'off' && (offOpen || running || job?.state === 'failed');
  const showProgress = job && (running || job.state === 'failed' || (job.state === 'done' && mode === 'off'));
  const blockers = preflight?.blockers || [];
  const nameMatches = typed.trim().toLowerCase() === String(workspace.name || '').trim().toLowerCase() && typed.trim() !== '';
  const radioDisabled = !canWrite || busy || running;
  const since = pacificWhen(record?.changedAt, now);
  const rows = shadowRows(shadow);
  const showShadow = mode === 'shadow' || rows.length > 0;
  const openFsBorn = Number(preflight?.openFsBorn) || 0;

  // Off never flips straight away: it opens the guided flow below.
  const pick = (next) => {
    if (radioDisabled) return;
    if (next === 'off') { setBackOn(null); if (mode !== 'off') setOffOpen(true); return; }
    setOffOpen(false);
    setTyped('');
    if (next === mode) return;
    // Back on from Off asks once, and says what it will not do.
    if (mode === 'off') { setBackOn(next); return; }
    onSetMode?.(next);
  };
  const selected = backOn || (offOpen && mode !== 'off' ? 'off' : mode);

  return (
    <section className="space-y-5" aria-label={`FreshService for ${name}`} data-testid="fs-switch" data-mode={mode}>
      {/* Where it stands */}
      <div className="space-y-0.5">
        <p className="flex flex-wrap items-center gap-x-2 text-sm">
          <FreshServiceModeText mode={mode} />
          {since && <span className="text-xs text-muted-foreground">since {since}{record?.changedBy ? ` by ${record.changedByName || who(record.changedBy)}` : ''}</span>}
        </p>
        {mode === 'off' && (
          <p className="text-xs text-muted-foreground" data-testid="fs-off-note">
            {record?.adoptedCount != null ? `${Number(record.adoptedCount).toLocaleString('en-US')} open ticket${Number(record.adoptedCount) === 1 ? ' was' : 's were'} adopted. ` : ''}
            Imported FreshService history is read-only. Switching back on restarts sync and waiting copies. {BACK_ON_LIMITS}
          </p>
        )}
      </div>

      {/* The picker */}
      <fieldset disabled={radioDisabled} className="space-y-2" aria-describedby={!canWrite ? 'fs-picker-note' : undefined}>
        <legend className="sr-only">FreshService mode</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {['connected', 'shadow', 'off'].map((m) => {
            const meta = FS_MODE_META[m];
            const id = `fs-mode-${workspace.id}-${m}`;
            return (
              <label key={m} htmlFor={id} className={`flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 transition-colors ${selected === m ? 'bg-muted' : 'hover:bg-muted/50'} ${radioDisabled ? 'cursor-default opacity-80' : ''}`}>
                <input
                  id={id}
                  type="radio"
                  name={`fs-mode-${workspace.id}`}
                  value={m}
                  checked={selected === m}
                  onChange={() => pick(m)}
                  className="tp-focus-ring mt-1 accent-[hsl(var(--primary))]"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-foreground"><ModeDot mode={m} />{meta.label}</span>
                  <span className="block text-xs text-muted-foreground">{meta.help}</span>
                </span>
              </label>
            );
          })}
        </div>
        {!canWrite && <p id="fs-picker-note" className="text-xs text-muted-foreground">Only super admins change this.</p>}
      </fieldset>

      {backOn && mode === 'off' && (
        <div className="space-y-2 border-l-2 border-primary/60 pl-4" role="group" aria-label="Turn FreshService back on" data-testid="fs-back-on-confirm">
          <p className="text-sm text-foreground">{backOnQuestion(name)}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => { const next = backOn; setBackOn(null); onSetMode?.(next); }}
              className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <Power className="h-4 w-4" aria-hidden="true" />
              Turn it back on ({modeMeta(backOn).label})
            </button>
            <button type="button" onClick={() => setBackOn(null)} className="tp-focus-ring rounded-lg px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

      {/* Shadow counts */}
      {showShadow && (
        <div className="space-y-2" aria-labelledby={`fs-shadow-${workspace.id}`}>
          <SectionTitle id={`fs-shadow-${workspace.id}`}>What Off would stop</SectionTitle>
          <p className="text-sm text-foreground" data-testid="fs-shadow-sentence">{shadowSentence(shadow, now)}</p>
          {rows.length > 0 && (
            <ul className="divide-y divide-border/60 text-sm" data-testid="fs-shadow-rows">
              {rows.map((r) => (
                <li key={r.purpose} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
                  <span className="min-w-0 flex-1 text-foreground/85">{r.label}</span>
                  <span className="font-semibold tabular-nums text-foreground">{r.n.toLocaleString('en-US')}</span>
                  <span className="basis-full text-xs text-muted-foreground sm:basis-auto">
                    first {pacificWhen(r.first, now) || '—'} · last {pacificWhen(r.last, now) || '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Preflight */}
      {preflight && mode !== 'off' && (
        <div className="space-y-2" aria-labelledby={`fs-preflight-${workspace.id}`}>
          <SectionTitle id={`fs-preflight-${workspace.id}`}>Before FreshService goes off</SectionTitle>
          <PreflightList items={preflight.items} />
        </div>
      )}

      {/* Progress (running, failed, or the outcome once Off) */}
      {showProgress && <OffProgress job={job} workspaceName={name} />}

      {/* The Off flow */}
      {showOffFlow && canWrite && !running && (
        <div className="space-y-3 border-l-2 border-red-300 pl-4 dark:border-red-500/40" data-testid="fs-off-flow">
          <SectionTitle>Switch FreshService off</SectionTitle>
          <ul className="space-y-1 text-sm text-foreground/85">
            <li>Sync, copies and write-backs to FreshService stop for {name}.</li>
            <li>
              {openFsBorn > 0
                ? `${openFsBorn.toLocaleString('en-US')} open FreshService ticket${openFsBorn === 1 ? ' is' : 's are'} adopted first: each becomes a Ticket Pulse ticket with a TP number, fully editable here.`
                : 'There are no open FreshService tickets to adopt.'}
            </li>
            <li>Closed FreshService tickets stay as imported history, read-only. Agents and admins can adopt one to edit it.</li>
            <li>You can switch FreshService back on while the account lasts. {BACK_ON_LIMITS}</li>
          </ul>
          {blockers.length > 0 && (
            <p className="flex items-start gap-2 text-sm text-red-700 dark:text-red-300" data-testid="fs-off-blocked">
              <OctagonX className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
              {blockers[0]}
            </p>
          )}
          <form
            className="space-y-2"
            onSubmit={(e) => { e.preventDefault(); if (nameMatches && !blockers.length && !busy) onStartOff?.(typed.trim()); }}
          >
            <label htmlFor={`fs-confirm-${workspace.id}`} className="block text-xs font-medium text-muted-foreground">
              Type <span className="font-semibold text-foreground">{workspace.name}</span> to confirm
            </label>
            <input
              id={`fs-confirm-${workspace.id}`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="tp-focus-ring block w-full max-w-sm rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="submit"
                disabled={!nameMatches || blockers.length > 0 || busy}
                className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-2 text-sm font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Power className="h-4 w-4" aria-hidden="true" />
                {job?.state === 'failed' ? `Try again: turn FreshService off for ${name}` : `Turn FreshService off for ${name}`}
              </button>
              {offOpen && !job && (
                <button type="button" onClick={() => { setOffOpen(false); setTyped(''); }} className="tp-focus-ring rounded-lg px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
                  Cancel
                </button>
              )}
            </div>
          </form>
        </div>
      )}

      {/* History */}
      {Array.isArray(record?.history) && record.history.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="tp-focus-ring inline-flex cursor-pointer items-center gap-1.5 rounded font-medium hover:text-foreground">
            <History className="h-3.5 w-3.5" aria-hidden="true" /> Changes ({record.history.length})
          </summary>
          <ol className="mt-2 space-y-1">
            {[...record.history].reverse().map((h, i) => (
              <li key={`${h.at}-${i}`} className="flex flex-wrap gap-x-2">
                <span className="text-foreground/85">{modeMeta(h.from).label} → {modeMeta(h.to).label}</span>
                <span>by {h.byName || who(h.by)}</span>
                <span className="tabular-nums">{pacificWhen(h.at, now)}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
