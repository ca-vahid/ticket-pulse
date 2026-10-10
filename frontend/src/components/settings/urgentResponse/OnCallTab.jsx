import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { urgentResponseAPI } from '../../../services/api';
import FancySelect from '../../common/FancySelect';
import { ConfirmDialog } from '../../knowledge/knowledgeUi';
import { SectionTitle } from '../../onboarding/onboardingUi';
import { StatusBanner } from '../SettingsLayoutPrimitives';
import { CARD_CLASS, Field, FormDialog, INPUT_CLASS, PeopleChecklist, TechPerson, TextButton, techOptions } from './urgentResponseUi';
import { WEEKDAYS, defaultCoverWindow, diffPatch, fmtLeaveDays, fmtRange, fmtUntil, fromZonedInput, toZonedInput } from './urgentResponseFormat';

/**
 * On-call: who is on call now, the weekly handover, the long-term order, and
 * the next 8 weeks with their covers. A week whose person is on leave is
 * never skipped by itself: it says "Needs cover" and an admin either sets the
 * cover or asks the others in the rotation. Covering never changes the order.
 */

const pickOnCall = (s = {}, { suggested = false } = {}) => ({
  // A suggested order (taken from the old escalation settings) is not saved yet.
  onCallOrder: suggested ? [] : (s.onCallOrder || []).map(Number),
  onCallHandoverDay: Number(s.onCallHandoverDay ?? 1),
  onCallHandoverTime: s.onCallHandoverTime || '17:00',
});

const iconButton = 'tp-focus-ring rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30';

/** Set cover: who, from, to (the whole week or the leave days to start with), note. */
function CoverDialog({ week, timezone, rotationPeople, activePeople, onDone, onCancel }) {
  const window0 = useMemo(() => defaultCoverWindow(week, timezone), [week, timezone]);
  const [who, setWho] = useState('');
  const [anyone, setAnyone] = useState(rotationPeople.length === 0);
  const [from, setFrom] = useState(() => toZonedInput(window0.startsAt, timezone));
  const [to, setTo] = useState(() => toZonedInput(window0.endsAt, timezone));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const people = (anyone ? activePeople : rotationPeople).filter((p) => p.id !== week.scheduled?.id);

  const submit = async () => {
    const startsAt = fromZonedInput(from, timezone);
    const endsAt = fromZonedInput(to, timezone);
    if (!who) { setError('Choose who covers.'); return; }
    if (!startsAt || !endsAt || endsAt <= startsAt) { setError('“To” must be after “From”.'); return; }
    setBusy(true);
    setError(null);
    try {
      await urgentResponseAPI.createCover({ originalTechnicianId: week.scheduled.id, coverTechnicianId: Number(who), startsAt, endsAt, note: note.trim() });
      onDone(`Cover set for ${week.scheduled.name}.`);
    } catch (err) {
      setError(err?.message || 'Could not set the cover');
      setBusy(false);
    }
  };

  return (
    <FormDialog open title={`Set cover for ${week.scheduled?.name || 'this week'}`} submitLabel="Set cover" onSubmit={submit} onCancel={onCancel} busy={busy} error={error} testId="cover-dialog">
      <div>
        <span className="text-sm font-medium text-foreground">Who covers</span>
        <div className="mt-1">
          <FancySelect value={who} onChange={setWho} options={[{ value: '', label: 'Choose a person' }, ...techOptions(people)]} aria-label="Who covers" />
        </div>
        <label className="mt-1.5 inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={anyone} onChange={(e) => { setAnyone(e.target.checked); setWho(''); }} className="accent-[hsl(var(--primary))]" />
          Show everyone, not only the people in the rotation
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From"><input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className={INPUT_CLASS} /></Field>
        <Field label="To"><input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className={INPUT_CLASS} /></Field>
      </div>
      <Field label="Note" hint="Optional. Shown with the cover.">
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className={INPUT_CLASS} />
      </Field>
      <p className="text-xs text-muted-foreground">Times are in the workspace time zone{timezone ? ` (${timezone})` : ''}. The long-term order does not change.</p>
    </FormDialog>
  );
}

/** Ask for cover: a message and who is asked (everyone else in the order to start with). */
function AskDialog({ week, timezone, rotationPeople, onDone, onCancel }) {
  const others = rotationPeople.filter((p) => p.id !== week.scheduled?.id);
  const window0 = useMemo(() => defaultCoverWindow(week, timezone), [week, timezone]);
  const [asked, setAsked] = useState(() => others.map((p) => p.id));
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    if (!asked.length) { setError('Tick at least one person to ask.'); return; }
    setBusy(true);
    setError(null);
    try {
      await urgentResponseAPI.createCoverRequest({
        originalTechnicianId: week.scheduled.id, startsAt: window0.startsAt, endsAt: window0.endsAt, message: message.trim(), askTechnicianIds: others.map((p) => p.id).filter((id) => asked.includes(id)),
      });
      onDone(`Asked ${asked.length} ${asked.length === 1 ? 'person' : 'people'} to cover for ${week.scheduled.name}.`);
    } catch (err) {
      setError(err?.message || 'Could not send the request');
      setBusy(false);
    }
  };

  return (
    <FormDialog open title={`Ask for cover for ${week.scheduled?.name || 'this week'}`} submitLabel="Send request" onSubmit={submit} onCancel={onCancel} busy={busy} error={error} testId="ask-dialog">
      <p className="text-sm text-foreground/85">
        Cover is needed {fmtRange(window0.startsAt, window0.endsAt, timezone)}. The people you tick get a Teams message, an e-mail and a prompt in the app. The first to accept takes it.
      </p>
      <Field label="Message" hint="Optional.">
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} maxLength={1000} className={`${INPUT_CLASS} h-auto py-2`} />
      </Field>
      <div>
        <span className="text-sm font-medium text-foreground">Who is asked</span>
        {others.length ? (
          <div className="mt-1 rounded-lg border border-border p-2">
            <PeopleChecklist people={others} selectedIds={asked} onChange={setAsked} legend="Who is asked" />
          </div>
        ) : <p className="mt-1 text-sm text-muted-foreground">Nobody else is in the rotation yet. Add people to the order first.</p>}
      </div>
    </FormDialog>
  );
}

export default function OnCallTab({ settings, orderSuggested = false, technicians, techById, onCall, onCallError = null, timezone: timezoneProp = null, reloadOnCall, onSaved }) {
  const saved = useMemo(() => pickOnCall(settings, { suggested: orderSuggested }), [settings, orderSuggested]);
  const [draft, setDraft] = useState(() => pickOnCall(settings));
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState(null); // { kind: 'cover' | 'ask', week }
  const [confirm, setConfirm] = useState(null); // { kind: 'cover' | 'request', id, text }
  const [weekPick, setWeekPick] = useState(null); // "On call this week", once the admin chose

  const timezone = timezoneProp || onCall?.timezone || null;
  const set = (next) => { setDraft((d) => ({ ...d, ...next })); setStatus(null); };

  const order = draft.onCallOrder;
  // Who the rotation counts from: the admin's choice, else the person the
  // server has scheduled this week, else the first in the order.
  const scheduledId = onCall?.current?.scheduled?.id ?? null;
  const firstSave = saved.onCallOrder.length === 0;
  const weekPerson = weekPick != null && order.includes(weekPick) ? weekPick
    : scheduledId != null && order.includes(scheduledId) ? scheduledId
      : order[0] ?? null;
  const patch = useMemo(() => {
    const next = diffPatch(draft, saved);
    const orderChanged = 'onCallOrder' in next;
    // The server keeps the rotation going by itself; it is told who is on call
    // this week only when that is new: a first order, a choice made here, or
    // an order the scheduled person is no longer in. The start date is its own.
    const tell = weekPerson != null && (
      (firstSave && orderChanged)
      || (weekPick != null && weekPerson !== scheduledId)
      || (orderChanged && scheduledId != null && !order.includes(scheduledId))
    );
    return tell ? { ...next, onCallCurrentTechnicianId: weekPerson } : next;
  }, [draft, saved, weekPerson, weekPick, scheduledId, firstSave, order]);
  const dirty = Object.keys(patch).length > 0;
  const person = (id) => techById.get(id) || { id, name: `Person ${id}` };
  const activePeople = useMemo(() => technicians.filter((t) => t.isActive !== false), [technicians]);
  const addable = activePeople.filter((t) => !order.includes(t.id));
  // Covers and requests work on the order the server has, not on an unsaved draft.
  const rotationPeople = useMemo(
    () => saved.onCallOrder.map((id) => techById.get(id)).filter(Boolean),
    [saved.onCallOrder, techById],
  );

  const move = (i, d) => {
    const next = [...order];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    set({ onCallOrder: next });
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await urgentResponseAPI.updateSettings(patch);
      const next = res?.data?.settings || patch;
      if (res?.data?.settings) setDraft(pickOnCall(res.data.settings));
      setWeekPick(null);
      onSaved?.(next, { orderSaved: 'onCallOrder' in patch });
      setStatus({ ok: true, text: 'Saved. The schedule below is up to date.' });
      await reloadOnCall?.();
    } catch (err) {
      setStatus({ ok: false, text: err?.message || 'Could not save' });
    } finally {
      setSaving(false);
    }
  };

  const done = async (text) => {
    setDialog(null);
    setStatus({ ok: true, text });
    await reloadOnCall?.();
  };
  const runConfirm = async () => {
    const { kind, id } = confirm;
    setConfirm(null);
    try {
      if (kind === 'cover') await urgentResponseAPI.cancelCover(id);
      else await urgentResponseAPI.cancelCoverRequest(id);
      setStatus({ ok: true, text: kind === 'cover' ? 'Cover cancelled.' : 'Request cancelled.' });
      await reloadOnCall?.();
    } catch (err) {
      setStatus({ ok: false, text: err?.message || 'Could not cancel' });
    }
  };

  const current = onCall?.current || null;
  const weeks = onCall?.weeks || [];
  const now = Date.now();

  return (
    <div className="space-y-5">
      {onCallError && <StatusBanner type="error">{onCallError}</StatusBanner>}

      <section className={CARD_CLASS} aria-label="On call now">
        <SectionTitle>On call now</SectionTitle>
        {current?.technician ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-foreground/85" data-testid="on-call-now">
            <TechPerson person={current.technician} techById={techById} size="h-8 w-8" />
            <span>
              until {fmtUntil(current.until, timezone)}
              {current.scheduled && current.scheduled.id !== current.technician.id ? `, covering for ${current.scheduled.name}` : ''}
            </span>
          </p>
        ) : <p className="text-sm text-muted-foreground">Nobody is on call. Add people to the order below and save.</p>}
        <p className="mt-2 text-xs text-muted-foreground">When someone covers, the long-term order below never changes.</p>
        <p className="text-xs text-muted-foreground">A week says it needs cover only when its person is on leave for a full day.</p>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className={CARD_CLASS} aria-label="Handover">
          <SectionTitle hint={`One person a week. Times are in the workspace time zone${timezone ? ` (${timezone})` : ''}.`}>Handover</SectionTitle>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-44">
              <span className="text-sm font-medium text-foreground">Day</span>
              <div className="mt-1">
                <FancySelect
                  value={String(draft.onCallHandoverDay)}
                  onChange={(v) => set({ onCallHandoverDay: Number(v) })}
                  options={WEEKDAYS.map((label, i) => ({ value: String(i), label }))}
                  aria-label="Handover day"
                />
              </div>
            </div>
            <label className="block">
              <span className="text-sm font-medium text-foreground">Time</span>
              <input type="time" value={draft.onCallHandoverTime} onChange={(e) => set({ onCallHandoverTime: e.target.value })} aria-label="Handover time" className={`${INPUT_CLASS} mt-1 w-32`} />
            </label>
          </div>
        </section>

        <section className={CARD_CLASS} aria-label="Order">
          <SectionTitle hint="Top to bottom, one week each, then round again.">Order</SectionTitle>
          {orderSuggested && dirty && (
            <p className="mb-2 text-sm text-amber-700 dark:text-amber-300" data-testid="order-suggested">
              This order was taken from the old escalation settings. It is saved when you press Save.
            </p>
          )}
          {!order.length && <p className="text-sm text-muted-foreground">Nobody yet.</p>}
          <ol className="divide-y divide-border">
            {order.map((id, i) => {
              const p = person(id);
              return (
                <li key={id} className="flex items-center gap-2 py-1.5">
                  <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                  <TechPerson person={p} techById={techById} sub={p.isActive === false ? 'Inactive' : null} className="flex-1" />
                  <span className="flex shrink-0 items-center gap-0.5">
                    <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${p.name} up`} className={iconButton}><ArrowUp className="h-4 w-4" aria-hidden="true" /></button>
                    <button type="button" disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${p.name} down`} className={iconButton}><ArrowDown className="h-4 w-4" aria-hidden="true" /></button>
                    <button type="button" onClick={() => set({ onCallOrder: order.filter((x) => x !== id) })} aria-label={`Remove ${p.name}`} className={`${iconButton} hover:text-red-600 dark:hover:text-red-300`}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
                  </span>
                </li>
              );
            })}
          </ol>
          {addable.length > 0 && (
            <div className="mt-2 sm:max-w-xs">
              <FancySelect value="" onChange={(v) => { if (v) set({ onCallOrder: [...order, Number(v)] }); }} options={techOptions(addable)} placeholder="Add a person" aria-label="Add a person to the order" />
            </div>
          )}
          {order.length > 0 && (
            <div className="mt-4 grid gap-1.5 border-t border-border pt-3 sm:max-w-xs">
              <span className="text-sm font-medium text-foreground">On call this week</span>
              <FancySelect
                value={weekPerson != null ? String(weekPerson) : ''}
                onChange={(v) => { setWeekPick(Number(v)); setStatus(null); }}
                options={techOptions(order.map(person))}
                aria-label="On call this week"
              />
              <span className="text-xs text-muted-foreground">The order repeats every week from this person. Covers never change it.</span>
            </div>
          )}
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-subtle">
        {status && (
          <span role="status" className={`mr-auto text-sm ${status.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>{status.text}</span>
        )}
        {!status && dirty && <span className="mr-auto text-sm text-muted-foreground">Unsaved changes</span>}
        <button type="button" disabled={!dirty || saving} onClick={() => { setDraft(pickOnCall(settings)); setWeekPick(null); setStatus(null); }} className="tp-focus-ring rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted disabled:opacity-40">Discard</button>
        <button type="button" disabled={!dirty || saving || !draft.onCallHandoverTime} onClick={save} className="tp-focus-ring rounded-md bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <section className={CARD_CLASS} aria-label="Next 8 weeks">
        <SectionTitle hint={dirty ? 'This shows the saved order. Save to see your changes here.' : 'Someone on leave is never skipped: the week says it needs cover.'}>Next 8 weeks</SectionTitle>
        {!onCall && !onCallError && <p className="text-sm text-muted-foreground">Loading…</p>}
        {onCall && !weeks.length && <p className="text-sm text-muted-foreground">No schedule yet. Add people to the order and save.</p>}
        <ol className="divide-y divide-border" data-testid="on-call-weeks">
          {weeks.map((week) => {
            const isNow = new Date(week.startsAt).getTime() <= now && now < new Date(week.endsAt).getTime();
            const request = week.openRequest;
            return (
              <li key={week.index ?? week.startsAt} className="grid gap-x-4 gap-y-1 py-3 sm:grid-cols-[11rem_minmax(0,14rem)_minmax(0,1fr)]" data-testid="on-call-week">
                <span className="text-sm text-foreground">
                  {fmtRange(week.startsAt, week.endsAt, timezone)}
                  {isNow && <span className="block text-xs text-muted-foreground">This week</span>}
                </span>
                <TechPerson person={week.scheduled} techById={techById} />
                <div className="min-w-0 space-y-1 text-sm text-foreground/85">
                  {(week.covers || []).map((cover) => (
                    <p key={cover.id} className="flex flex-wrap items-center gap-x-2">
                      <span title={`${fmtUntil(cover.startsAt, timezone)} to ${fmtUntil(cover.endsAt, timezone)}`}>
                        {cover.technician?.name} covers {fmtRange(cover.startsAt, cover.endsAt, timezone)}
                        {cover.note ? ` (${cover.note})` : ''}
                      </span>
                      <TextButton tone="muted" onClick={() => setConfirm({ kind: 'cover', id: cover.id, text: `${cover.technician?.name} will no longer cover ${fmtRange(cover.startsAt, cover.endsAt, timezone)}. ${week.scheduled?.name} is on call again for that time.` })}>
                        Cancel cover
                      </TextButton>
                    </p>
                  ))}
                  {(week.leaveDays || []).length > 0 && <p className="text-muted-foreground">On leave {fmtLeaveDays(week.leaveDays)}</p>}
                  {request && (
                    <p className="flex flex-wrap items-center gap-x-2">
                      <span>
                        Asked {request.askedCount} {request.askedCount === 1 ? 'person' : 'people'}
                        {request.declinedCount > 0 ? ` · ${request.declinedCount} declined` : ''}
                      </span>
                      <TextButton tone="muted" onClick={() => setConfirm({ kind: 'request', id: request.id, text: `The request to cover for ${week.scheduled?.name} is withdrawn. The week still needs cover.` })}>Cancel request</TextButton>
                    </p>
                  )}
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {week.needsCover && (
                      <span className="inline-flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-300">
                        <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400" aria-hidden="true" />
                        Needs cover
                      </span>
                    )}
                    <TextButton tone={week.needsCover ? 'primary' : 'muted'} onClick={() => setDialog({ kind: 'cover', week })} aria-label={`Set cover for ${week.scheduled?.name}, ${fmtRange(week.startsAt, week.endsAt, timezone)}`}>Set cover</TextButton>
                    {week.needsCover && !request && (
                      <TextButton onClick={() => setDialog({ kind: 'ask', week })} aria-label={`Ask for cover for ${week.scheduled?.name}, ${fmtRange(week.startsAt, week.endsAt, timezone)}`}>Ask for cover</TextButton>
                    )}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {dialog?.kind === 'cover' && (
        <CoverDialog week={dialog.week} timezone={timezone} rotationPeople={rotationPeople} activePeople={activePeople} onDone={done} onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === 'ask' && (
        <AskDialog week={dialog.week} timezone={timezone} rotationPeople={rotationPeople} onDone={done} onCancel={() => setDialog(null)} />
      )}
      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.kind === 'cover' ? 'Cancel this cover?' : 'Cancel this request?'}
        confirmLabel={confirm?.kind === 'cover' ? 'Cancel cover' : 'Cancel request'}
        cancelLabel="Keep it"
        destructive
        onConfirm={runConfirm}
        onCancel={() => setConfirm(null)}
      >
        {confirm?.text}
      </ConfirmDialog>
    </div>
  );
}
