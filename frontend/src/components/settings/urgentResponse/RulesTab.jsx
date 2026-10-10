import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { urgentResponseAPI } from '../../../services/api';
import FancySelect from '../../common/FancySelect';
import { Switch } from '../../ui';
import { SectionTitle, StatusDot } from '../../onboarding/onboardingUi';
import { CARD_CLASS, InlineNumber, PeopleChecklist, TechPerson, TextButton, techOptions } from './urgentResponseUi';
import {
  PICK_STEPS, PRIORITY_LABEL, changeFieldLabel, changeValueLabel, diffPatch, fmtWhen, listOf,
  pickRules, previewSentence, togglePriority, validateRules,
} from './urgentResponseFormat';

/**
 * Rules: the ticket's path drawn left to right as three connected steps, then
 * who is told, what happens when nobody is at work, and where a ticket that
 * keeps moving ends up. One Save sends only what changed; every change is
 * recorded server-side and listed at the bottom (who, when, before → after).
 */

function Radio({ name, value, current, onChange, children }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 py-0.5 text-sm text-foreground/85">
      <input type="radio" name={name} value={value} checked={current === value} onChange={() => onChange(value)} className="mt-1 accent-[hsl(var(--primary))]" />
      <span className="min-w-0">{children}</span>
    </label>
  );
}

/** One step of the path: number, title, switch, "Applies to", and its sentence. */
function Step({ n, title, enabled, onEnabled, priorities, onPriorities, children }) {
  return (
    <li className={`min-w-0 flex-1 ${CARD_CLASS}`} aria-label={`Step ${n}: ${title}`}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
          <span aria-hidden="true" className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-primary/40 text-xs font-semibold text-primary">{n}</span>
          <span className="min-w-0">{title}</span>
        </h3>
        <Switch checked={enabled} onCheckedChange={onEnabled} aria-label={`${title}: on or off`} />
      </div>
      <div className={enabled ? '' : 'opacity-50'}>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-foreground/85">
          <span className="text-xs text-muted-foreground">Applies to</span>
          {[4, 3].map((p) => (
            <label key={p} className="inline-flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={priorities.includes(p)}
                onChange={(e) => onPriorities(togglePriority(priorities, p, e.target.checked))}
                aria-label={`${title}: applies to ${PRIORITY_LABEL[p]}`}
                className="accent-[hsl(var(--primary))]"
              />
              {PRIORITY_LABEL[p]}
            </label>
          ))}
        </div>
        <div className="mt-2 text-sm leading-8 text-foreground/85">{children}</div>
      </div>
    </li>
  );
}

/** The line between two steps: across on wide screens, down when they stack. */
function Connector() {
  return (
    <li role="presentation" aria-hidden="true" className="flex shrink-0 items-center pl-7 xl:w-8 xl:pl-0">
      <span className="h-5 w-px bg-border xl:h-px xl:w-full xl:flex-1" />
      <ChevronRight className="-ml-2 hidden h-4 w-4 shrink-0 text-muted-foreground/60 xl:block" />
    </li>
  );
}

export default function RulesTab({
  settings, technicians, techById, teamsEnabled, onCall = null, timezone = null,
  changesKey = 0, previewDelayMs = 600, onSaved, onOpenOnCall = null,
}) {
  const saved = useMemo(() => pickRules(settings), [settings]);
  const [draft, setDraft] = useState(saved);
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState({ state: 'idle', data: null });
  const [changes, setChanges] = useState(null);
  const previewRun = useRef(0);

  const set = (patch) => { setDraft((d) => ({ ...d, ...patch })); setStatus(null); };
  const problems = useMemo(() => validateRules(draft), [draft]);
  const patch = useMemo(() => diffPatch(draft, saved), [draft, saved]);
  const dirty = Object.keys(patch).length > 0;

  const active = useMemo(() => technicians.filter((t) => t.isActive !== false), [technicians]);
  // A person already chosen stays in the list even after being made inactive.
  const personOptions = (currentId, emptyLabel) => [
    { value: '', label: emptyLabel },
    ...techOptions(technicians.filter((t) => t.isActive !== false || t.id === currentId)),
  ];
  const namedPeople = useMemo(
    () => technicians.filter((t) => t.isActive !== false || draft.notifyTechnicianIds.includes(t.id)),
    [technicians, draft.notifyTechnicianIds],
  );

  // The estimate follows the draft, a moment after the last change.
  const draftKey = JSON.stringify(draft);
  useEffect(() => {
    if (problems.length) { setPreview({ state: 'blocked', data: null }); return undefined; }
    const run = ++previewRun.current;
    setPreview((p) => ({ ...p, state: 'loading' }));
    const timer = setTimeout(() => {
      urgentResponseAPI.preview(JSON.parse(draftKey))
        .then((res) => { if (previewRun.current === run) setPreview({ state: 'ok', data: res?.data || null }); })
        .catch(() => { if (previewRun.current === run) setPreview({ state: 'error', data: null }); });
    }, previewDelayMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, previewDelayMs]);

  useEffect(() => {
    let alive = true;
    urgentResponseAPI.getChanges(50)
      .then((res) => { if (alive) setChanges(listOf(res?.data)); })
      .catch(() => { if (alive) setChanges([]); });
    return () => { alive = false; };
  }, [changesKey]);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await urgentResponseAPI.updateSettings(patch);
      const next = res?.data?.settings ? pickRules(res.data.settings) : draft;
      setDraft(next);
      const n = res?.data?.changes?.length || 0;
      setStatus({ ok: true, text: n ? `Saved. ${n} ${n === 1 ? 'change' : 'changes'} recorded below.` : 'Saved.' });
      onSaved?.(res?.data?.settings || patch);
    } catch (err) {
      setStatus({ ok: false, text: err?.message || 'Could not save' });
    } finally {
      setSaving(false);
    }
  };

  const onCallNow = onCall?.current?.technician || null;

  return (
    <div className="space-y-5">
      <section aria-label="The path of an urgent ticket">
        <SectionTitle hint="Read it left to right: each step only acts when the one before it did not settle the ticket.">The path of an urgent ticket</SectionTitle>
        <ol className="flex flex-col xl:flex-row xl:items-stretch">
          <Step
            n={1}
            title="When assigning"
            enabled={draft.assignEnabled}
            onEnabled={(v) => set({ assignEnabled: v })}
            priorities={draft.assignPriorities}
            onPriorities={(v) => set({ assignPriorities: v })}
          >
            Only assign to people who are at work, or who start within
            <InlineNumber value={draft.assignGraceMinutes} onChange={(v) => set({ assignGraceMinutes: v })} label="Minutes before a shift starts that still count as at work" />
            min.
            <p className="text-xs leading-normal text-muted-foreground">If the AI’s pick is away, the best person at work gets the ticket instead. 0 means at work right now.</p>
          </Step>
          <Connector />
          <Step
            n={2}
            title="When it becomes urgent"
            enabled={draft.raiseEnabled}
            onEnabled={(v) => set({ raiseEnabled: v })}
            priorities={draft.raisePriorities}
            onPriorities={(v) => set({ raisePriorities: v })}
          >
            <p>If the owner is away when a ticket reaches this priority, it moves to someone at work right away.</p>
            <fieldset className="mt-1 leading-normal">
              <legend className="text-xs text-muted-foreground">If the owner was chosen by hand</legend>
              <Radio name="raise-manual" value="notify" current={draft.raiseManualAction} onChange={(v) => set({ raiseManualAction: v })}>Leave it with them and tell the people at work</Radio>
              <Radio name="raise-manual" value="move" current={draft.raiseManualAction} onChange={(v) => set({ raiseManualAction: v })}>Move it as well</Radio>
            </fieldset>
          </Step>
          <Connector />
          <Step
            n={3}
            title="If nobody touches it"
            enabled={draft.clockEnabled}
            onEnabled={(v) => set({ clockEnabled: v })}
            priorities={draft.clockPriorities}
            onPriorities={(v) => set({ clockPriorities: v })}
          >
            After
            <InlineNumber value={draft.clockNotifyMinutes} onChange={(v) => set({ clockNotifyMinutes: v })} min={1} label="Minutes before the people at work are told" />
            min, tell the people at work. After
            <InlineNumber value={draft.clockMoveMinutes} onChange={(v) => set({ clockMoveMinutes: v })} min={1} label="Minutes before the ticket moves" />
            min, move it.
            <p className="text-xs leading-normal text-muted-foreground">Only business minutes count. Any reply, note or change by an agent stops the clock; nothing the requester does counts.</p>
          </Step>
        </ol>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className={CARD_CLASS} aria-label="Nobody at work">
          <SectionTitle hint="When there is no one at work to give the ticket to.">Nobody at work</SectionTitle>
          <fieldset>
            <legend className="sr-only">What happens when nobody is at work</legend>
            <Radio name="nobody-mode" value="hold" current={draft.nobodyMode} onChange={(v) => set({ nobodyMode: v })}>
              Leave it with its owner and tell one person. It is checked again every minute until someone is at work.
            </Radio>
            <Radio name="nobody-mode" value="on_call" current={draft.nobodyMode} onChange={(v) => set({ nobodyMode: v })}>
              Give it to the on-call person and text them.
            </Radio>
          </fieldset>
          {draft.nobodyMode === 'on_call' && (
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {onCallNow ? <>On call now: <TechPerson person={onCallNow} techById={techById} size="h-5 w-5" /></> : 'Nobody is on call yet.'}
              {onOpenOnCall && <TextButton onClick={onOpenOnCall} className="!text-xs">Open the On-call tab</TextButton>}
            </p>
          )}
          <div className="mt-3 grid gap-1.5 sm:max-w-sm">
            <span className="text-sm font-medium text-foreground">Person told</span>
            <span className="text-xs text-muted-foreground">
              {draft.nobodyMode === 'on_call' ? 'Also used when the on-call person is on leave with no cover.' : 'They are told; the ticket stays where it is.'}
            </span>
            <FancySelect
              value={draft.nobodyContactTechnicianId ? String(draft.nobodyContactTechnicianId) : ''}
              onChange={(v) => set({ nobodyContactTechnicianId: v ? Number(v) : null })}
              options={personOptions(draft.nobodyContactTechnicianId, 'Nobody')}
              aria-label="Person told when nobody is at work"
            />
          </div>
        </section>

        <section className={CARD_CLASS} aria-label="Who is told">
          <SectionTitle hint="The requester is never told that a ticket moved.">Who is told</SectionTitle>
          <fieldset>
            <legend className="sr-only">Who is told</legend>
            <Radio name="notify-audience" value="on_shift" current={draft.notifyAudience} onChange={(v) => set({ notifyAudience: v })}>Everyone at work</Radio>
            <Radio name="notify-audience" value="group" current={draft.notifyAudience} onChange={(v) => set({ notifyAudience: v })}>The ticket’s group</Radio>
            <Radio name="notify-audience" value="named" current={draft.notifyAudience} onChange={(v) => set({ notifyAudience: v })}>Named people</Radio>
          </fieldset>
          {draft.notifyAudience === 'named' && (
            <div className="mt-2 rounded-lg border border-border p-2">
              <PeopleChecklist people={namedPeople} selectedIds={draft.notifyTechnicianIds} onChange={(ids) => set({ notifyTechnicianIds: ids })} legend="Named people" />
            </div>
          )}
          <fieldset className="mt-3">
            <legend className="text-sm font-medium text-foreground">How</legend>
            <div className="mt-1 flex flex-wrap items-start gap-x-5 gap-y-1 text-sm text-foreground/85">
              <label className={`inline-flex items-center gap-1.5 ${teamsEnabled ? 'cursor-pointer' : 'text-muted-foreground'}`}>
                <input
                  type="checkbox"
                  checked={teamsEnabled && draft.notifyChannels.includes('teams')}
                  disabled={!teamsEnabled}
                  onChange={(e) => set({ notifyChannels: ['teams', 'email'].filter((c) => (c === 'teams' ? e.target.checked : draft.notifyChannels.includes(c))) })}
                  aria-describedby={teamsEnabled ? undefined : 'urgent-teams-off'}
                  className="accent-[hsl(var(--primary))]"
                />
                Teams
              </label>
              <label className="inline-flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={draft.notifyChannels.includes('email')}
                  onChange={(e) => set({ notifyChannels: ['teams', 'email'].filter((c) => (c === 'email' ? e.target.checked : draft.notifyChannels.includes(c))) })}
                  className="accent-[hsl(var(--primary))]"
                />
                E-mail
              </label>
            </div>
            {!teamsEnabled && <p id="urgent-teams-off" className="mt-1 text-xs text-muted-foreground">Teams is not available: it is switched off for this workspace.</p>}
            {!draft.notifyChannels.some((c) => c === 'email' || teamsEnabled) && (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Nothing is ticked that can be sent, so nobody will be told.</p>
            )}
          </fieldset>
        </section>

        <section className={CARD_CLASS} aria-label="If it keeps moving">
          <SectionTitle hint="So a ticket is not passed around for ever.">If it keeps moving</SectionTitle>
          <div className="text-sm leading-8 text-foreground/85">
            After
            <InlineNumber value={draft.maxMoves} onChange={(v) => set({ maxMoves: v })} max={10} label="Most moves before the coordinator" />
            {draft.maxMoves === 1 ? 'move' : 'moves'}, it goes to the coordinator, who is told. Then the clock stops.
          </div>
          <div className="mt-2 grid gap-1.5 sm:max-w-sm">
            <span className="text-sm font-medium text-foreground">Coordinator</span>
            <FancySelect
              value={draft.coordinatorTechnicianId ? String(draft.coordinatorTechnicianId) : ''}
              onChange={(v) => set({ coordinatorTechnicianId: v ? Number(v) : null })}
              options={personOptions(draft.coordinatorTechnicianId, 'Nobody (it stays with its last owner)')}
              aria-label="Coordinator"
            />
          </div>
        </section>

        <section className={CARD_CLASS} aria-label="How the next owner is picked">
          <SectionTitle hint="Always in this order. It cannot be changed.">How the next owner is picked</SectionTitle>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground/85">
            {PICK_STEPS.map((text) => <li key={text}>{text}</li>)}
          </ol>
          <p className="mt-2 text-xs text-muted-foreground">{active.length} {active.length === 1 ? 'person' : 'people'} in this workspace can be picked.</p>
        </section>
      </div>

      <section className={CARD_CLASS} aria-label="Estimate" data-testid="urgent-preview">
        <StatusDot tone="amber" label="Estimate" className="font-medium" />
        <p className="mt-1 text-sm text-foreground/85" aria-live="polite">
          {preview.state === 'blocked' && 'Fix the points below to see what these settings would have done.'}
          {preview.state === 'error' && 'The estimate could not be worked out just now.'}
          {preview.state === 'loading' && !preview.data && 'Working it out…'}
          {(preview.state === 'ok' || (preview.state === 'loading' && preview.data)) && previewSentence(preview.data)}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Replayed from past tickets{preview.data?.inScopeTickets != null && preview.state !== 'blocked' ? ` (${preview.data.inScopeTickets} in scope)` : ''}. It changes as you edit and is not a promise.
        </p>
      </section>

      {problems.length > 0 && (
        <ul role="alert" className="space-y-1 text-sm text-red-700 dark:text-red-300" data-testid="urgent-rule-problems">
          {problems.map((text) => <li key={text}>{text}</li>)}
        </ul>
      )}

      <div className="sticky bottom-20 z-10 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-border bg-card/95 px-4 py-3 shadow-soft backdrop-blur lg:bottom-4">
        {status && (
          <span role="status" className={`mr-auto text-sm ${status.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>{status.text}</span>
        )}
        {!status && dirty && <span className="mr-auto text-sm text-muted-foreground">Unsaved changes</span>}
        <button type="button" disabled={!dirty || saving} onClick={() => { setDraft(saved); setStatus(null); }} className="tp-focus-ring rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted disabled:opacity-40">Discard</button>
        <button type="button" disabled={!dirty || saving || problems.length > 0} onClick={save} className="tp-focus-ring rounded-md bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <section className={CARD_CLASS} aria-label="Changes">
        <SectionTitle hint="Every change to these settings: who, when, before → after.">Changes</SectionTitle>
        {changes === null ? <p className="text-sm text-muted-foreground">Loading…</p> : !changes.length ? (
          <p className="text-sm text-muted-foreground">No changes yet. These are the starting settings.</p>
        ) : (
          <ol className="divide-y divide-border" data-testid="urgent-changes">
            {changes.map((c) => (
              <li key={c.id} className="grid gap-x-3 gap-y-0.5 py-2 text-sm sm:grid-cols-[8.5rem_10rem_minmax(0,1fr)]">
                <span className="text-xs text-muted-foreground">{fmtWhen(c.createdAt, timezone)}</span>
                <span className="truncate text-xs text-foreground/85">{c.changedByName || c.changedBy || 'Unknown'}</span>
                <span className="min-w-0">
                  <span className="text-foreground">{changeFieldLabel(c.field)}</span>
                  <span className="text-muted-foreground">: {changeValueLabel(c.field, c.before, { techById })} → </span>
                  <span className="text-foreground">{changeValueLabel(c.field, c.after, { techById })}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
