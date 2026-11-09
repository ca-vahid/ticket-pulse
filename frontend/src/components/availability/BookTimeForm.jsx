import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Loader2, Pencil, XCircle } from 'lucide-react';
import { availabilityAPI } from '../../services/api';
import {
  BTN_LINK, BTN_PRIMARY, BTN_QUIET, COLOR_DOT, COLOR_FILL, ErrorNote, Field, INPUT, TEXTAREA, Toggle,
  addDaysKey, fmtDay, fmtRange, minuteToTime, nextWorkdayKey, parseDay, timeToMinute, todayKey, trimNum,
} from './availabilityUi';

/**
 * "Book time away" — and, since Nov 2026, "Change your request" for one that
 * is still waiting (Vahid: Gaby booked Thu + Fri, then wanted only Fri, and
 * had to cancel and book again).
 *
 * Top to bottom it reads as the questions people ask themselves:
 *   What?   the leave types as a short list to tick (colour + name)
 *   When?   dates with quick picks (Today, Tomorrow, Next week), the part of
 *           the day, and a strip of the days that shows which ones count
 *   Note
 *   Verdict a dry run on the server, in plain words, before anything is sent
 */

const DAY_PARTS = [
  { value: 'full', label: 'Full day' },
  { value: 'am', label: 'Morning' },
  { value: 'pm', label: 'Afternoon' },
];

const STRIP_MAX = 14;

const emptyForm = (typeId) => ({
  leaveTypeId: typeId ? String(typeId) : '',
  startDate: nextWorkdayKey(),
  endDate: nextWorkdayKey(),
  dayPart: 'full',
  startTime: '09:00',
  endTime: '10:00',
  note: '',
  wantsOutlookEvent: false,
  wantsAutoReply: false,
});

/** The form, filled in from a request being changed. */
export function formFromRequest(r) {
  return {
    leaveTypeId: String(r.leaveTypeId),
    startDate: r.startDate,
    endDate: r.endDate,
    dayPart: r.dayPart === 'hours' ? 'full' : (r.dayPart || 'full'),
    startTime: r.startMinute != null ? minuteToTime(r.startMinute) : '09:00',
    endTime: r.endMinute != null ? minuteToTime(r.endMinute) : '10:00',
    note: r.note || '',
    wantsOutlookEvent: Boolean(r.wantsOutlookEvent),
    wantsAutoReply: Boolean(r.wantsAutoReply),
  };
}

export function buildRequestBody(form, type) {
  const isHours = type?.unit === 'hour';
  const body = {
    leaveTypeId: Number(form.leaveTypeId),
    startDate: form.startDate,
    endDate: isHours ? form.startDate : form.endDate,
    dayPart: isHours ? 'hours' : (type?.allowHalfDays ? form.dayPart : 'full'),
    note: form.note.trim() || undefined,
  };
  if (isHours) {
    body.startMinute = timeToMinute(form.startTime);
    body.endMinute = timeToMinute(form.endTime);
  }
  return body;
}

/** Monday to Friday of next week. */
function nextWeek() {
  const d = parseDay(todayKey());
  const toMonday = ((8 - d.getDay()) % 7) || 7;
  const monday = addDaysKey(todayKey(), toMonday);
  return { startDate: monday, endDate: addDaysKey(monday, 4) };
}

/** The next working day after today (skips the weekend). */
function tomorrowKey() {
  let k = addDaysKey(todayKey(), 1);
  while ([0, 6].includes(parseDay(k).getDay())) k = addDaysKey(k, 1);
  return k;
}

export function Verdict({ preview, unit, editing = false }) {
  if (!preview) return null;
  const { outcome } = preview;
  const look = outcome === 'approved'
    ? { Icon: CheckCircle2, cls: 'text-emerald-700 dark:text-emerald-300', text: editing ? 'The change will be approved automatically' : 'Will be approved automatically' }
    : outcome === 'pending'
      ? { Icon: Clock3, cls: 'text-amber-700 dark:text-amber-300', text: editing ? 'The change goes to your approvers' : 'Goes to your approvers' }
      : { Icon: XCircle, cls: 'text-red-700 dark:text-red-300', text: preview.reason || 'This request cannot be booked' };
  const amount = unit === 'hour'
    ? `${trimNum(preview.hours)} ${Number(preview.hours) === 1 ? 'hour' : 'hours'}`
    : `${trimNum(preview.days)} working ${Number(preview.days) === 1 ? 'day' : 'days'}`;
  const messages = (preview.fired || []).filter((f) => f.message && f.outcome !== 'warn' && f.message !== preview.reason);
  const warnings = preview.warnings || [];
  return (
    <div className="space-y-1.5 border-t border-border pt-3" data-testid="availability-verdict" aria-live="polite">
      <p className={`flex items-start gap-2 text-sm font-medium ${look.cls}`}>
        <look.Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{look.text}</span>
      </p>
      <p className="pl-6 text-xs text-muted-foreground">
        {amount}{unit !== 'hour' && ' (weekends and holidays skipped)'}
        {preview.remaining != null && ` · ${trimNum(preview.remaining)} left after this`}
        {outcome === 'pending' && preview.reason && ` · ${preview.reason}`}
      </p>
      {messages.length > 0 && (
        <ul className="space-y-0.5 pl-6 text-xs text-foreground/85">
          {messages.map((f) => <li key={`r-${f.ruleId}-${f.name}`}>{f.message}</li>)}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="space-y-0.5 pl-6 text-xs text-amber-700 dark:text-amber-300">
          {warnings.map((w) => (
            <li key={`w-${w.ruleId}-${w.name}`} className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />{w.message || w.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The days in the range, one small cell each: counted days filled in the
 * type's colour, weekends and holidays struck through. The server's dry run
 * says which days count; until it answers, weekends are greyed by weekday.
 */
export function DayStrip({ startDate, endDate, counted, color, dayPart }) {
  if (!startDate || !endDate || endDate < startDate) return null;
  const days = [];
  for (let k = startDate; k <= endDate && days.length <= STRIP_MAX; k = addDaysKey(k, 1)) days.push(k);
  const more = days.length > STRIP_MAX;
  const shown = more ? days.slice(0, STRIP_MAX) : days;
  const half = dayPart === 'am' || dayPart === 'pm';
  return (
    <div className="flex flex-wrap items-end gap-1" data-testid="availability-day-strip" aria-hidden="true">
      {shown.map((k) => {
        const d = parseDay(k);
        const weekend = d.getDay() === 0 || d.getDay() === 6;
        const counts = counted ? counted.has(k) : !weekend;
        return (
          <span
            key={k}
            title={counts ? `${fmtDay(k)} counts${half ? ` (${dayPart === 'am' ? 'morning' : 'afternoon'})` : ''}` : `${fmtDay(k)} is not a working day`}
            className={`flex w-8 flex-col items-center rounded-md py-1 text-[10px] leading-tight ${counts ? `${COLOR_FILL[color] || COLOR_FILL.slate} text-foreground` : 'bg-muted/60 text-muted-foreground/75 line-through'}`}
          >
            <span>{d.toLocaleDateString('en-CA', { weekday: 'narrow' })}</span>
            <span className="text-xs font-medium tabular-nums">{d.getDate()}</span>
          </span>
        );
      })}
      {more && <span className="pb-1 text-xs text-muted-foreground">and more…</span>}
    </div>
  );
}

export default function BookTimeForm({ me, onBooked, toast, editing = null, onStopEditing = null }) {
  const types = useMemo(() => (me.leaveTypes || []).filter((t) => t.isActive !== false).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)), [me.leaveTypes]);
  const original = useMemo(() => (editing ? formFromRequest(editing) : null), [editing]);
  const [form, setForm] = useState(() => original || emptyForm(types[0]?.id));
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [submitError, setSubmitError] = useState(null);
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  const type = types.find((t) => String(t.id) === form.leaveTypeId) || null;
  const isHours = type?.unit === 'hour';
  const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setSubmitError(null); };

  const valid = Boolean(type && form.startDate && (isHours || (form.endDate && form.endDate >= form.startDate))
    && (!isHours || (form.startTime && form.endTime && form.endTime > form.startTime)));
  const body = useMemo(() => (type ? buildRequestBody(form, type) : null), [form, type]);
  const bodyKey = JSON.stringify(body);
  const originalKey = useMemo(() => {
    if (!original) return null;
    const t = types.find((x) => String(x.id) === original.leaveTypeId);
    return t ? JSON.stringify(buildRequestBody(original, t)) : null;
  }, [original, types]);
  const unchanged = Boolean(editing && originalKey === bodyKey
    && Boolean(original.wantsOutlookEvent) === Boolean(form.wantsOutlookEvent)
    && Boolean(original.wantsAutoReply) === Boolean(form.wantsAutoReply));

  useEffect(() => {
    if (!valid) { setPreview(null); setPreviewError(null); return undefined; }
    const mine = ++seq.current;
    setPreviewing(true);
    const t = setTimeout(() => {
      availabilityAPI.preview({ ...JSON.parse(bodyKey), ...(editing ? { requestId: editing.id } : {}) })
        .then((res) => { if (mine === seq.current) { setPreview(res?.data || null); setPreviewError(null); } })
        .catch((err) => { if (mine === seq.current) { setPreview(null); setPreviewError(err?.message || 'Could not check this request'); } })
        .finally(() => { if (mine === seq.current) setPreviewing(false); });
    }, 350);
    return () => clearTimeout(t);
  }, [bodyKey, valid, editing]);

  const submit = async (e) => {
    e.preventDefault();
    if (!valid || saving || unchanged) return;
    if (type?.requiresNote && !form.note.trim()) { setSubmitError(`${type.name} needs a note`); return; }
    setSaving(true);
    setSubmitError(null);
    const extras = {
      ...(me.settings?.outlookEventsEnabled ? { wantsOutlookEvent: form.wantsOutlookEvent } : {}),
      ...(me.settings?.autoRepliesEnabled ? { wantsAutoReply: form.wantsAutoReply } : {}),
    };
    try {
      const res = editing
        ? await availabilityAPI.updateRequest(editing.id, { ...body, ...extras })
        : await availabilityAPI.createRequest({ ...body, ...extras });
      const status = res?.data?.status;
      if (editing) toast?.(status === 'approved' ? `${type.name} changed and approved` : 'Your changes went to your approvers');
      else toast?.(status === 'approved' ? `${type.name} booked and approved` : `${type.name} sent to your approvers`);
      if (!editing) setForm(emptyForm(type.id));
      setPreview(null);
      onBooked?.(res?.data);
    } catch (err) {
      setSubmitError(err?.message || (editing ? 'Could not save your changes' : 'Could not book this time'));
    } finally {
      setSaving(false);
    }
  };

  if (!types.length) {
    return <p className="text-sm text-muted-foreground">No leave types are set up yet — ask an Availability admin.</p>;
  }

  const refused = preview?.outcome === 'refused';
  const counted = preview?.dates ? new Set(preview.dates.map((d) => String(d).slice(0, 10))) : null;
  const stays = type?.availability === 'WFH' || type?.availability === 'ONSITE';
  const pickDates = (patch) => set(isHours ? { startDate: patch.startDate, endDate: patch.startDate } : patch);
  const quick = [
    { label: 'Today', run: () => pickDates({ startDate: todayKey(), endDate: todayKey() }) },
    { label: 'Tomorrow', run: () => { const k = tomorrowKey(); pickDates({ startDate: k, endDate: k }); } },
    ...(isHours ? [] : [{ label: 'Next week', run: () => pickDates(nextWeek()) }]),
  ];
  const submitLabel = editing
    ? (preview?.outcome === 'approved' ? 'Save changes' : 'Send changes for approval')
    : (preview?.outcome === 'pending' ? 'Send for approval' : 'Book');
  const waitingOn = (editing?.waitingOn || []).map((p) => p.name || p.email).filter(Boolean);

  return (
    <form onSubmit={submit} className="space-y-4" aria-label={editing ? 'Change your request' : 'Book time away'} data-booking-form="true" data-editing={editing ? 'true' : undefined}>
      {editing ? (
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Pencil className="h-4 w-4 text-primary" aria-hidden="true" />Change your request
          </h2>
          <p className="text-xs text-muted-foreground">
            Now: {types.find((t) => t.id === editing.leaveTypeId)?.name || 'Time away'}, {fmtRange(editing)}
            {waitingOn.length > 0 && ` · waiting for ${waitingOn.join(' or ')}`}.
            {' '}It stays the same request; the rules check it again and your approvers see what changed.
          </p>
        </div>
      ) : (
        <h2 className="text-sm font-semibold text-foreground">Book time away</h2>
      )}

      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-muted-foreground">What</legend>
        <div className="grid grid-cols-2 gap-1.5">
          {types.map((t) => {
            const on = String(t.id) === form.leaveTypeId;
            return (
              <label
                key={t.id}
                className={`flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${on
                  ? 'border-primary bg-primary/5 text-foreground dark:bg-primary/15'
                  : 'border-border text-foreground/85 hover:bg-muted'}`}
              >
                <input type="radio" name="leaveType" value={String(t.id)} checked={on} onChange={() => set({ leaveTypeId: String(t.id) })} className="sr-only" />
                <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${COLOR_DOT[t.color] || COLOR_DOT.slate}`} aria-hidden="true" />
                <span className="min-w-0 leading-tight">{t.name}</span>
              </label>
            );
          })}
        </div>
        {stays && <p className="mt-1.5 text-xs text-muted-foreground">Shows on the team calendar; you stay available.</p>}
      </fieldset>

      <fieldset className="space-y-2" aria-labelledby="av-when-label">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span id="av-when-label" className="text-xs font-medium text-muted-foreground">When</span>
          <span className="-mr-2 flex flex-wrap items-center">
            {quick.map((q) => (
              <button key={q.label} type="button" className={`${BTN_LINK} px-1.5 py-0.5 text-xs`} onClick={q.run}>{q.label}</button>
            ))}
          </span>
        </div>
        {/* QA 10-15 #8: in the narrow drawer the two time boxes could not shrink and "To" sat on top of
            "From". For an hours booking the date and the From/To pair each get the full row. */}
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={isHours ? 'Date' : 'From'} className={isHours ? 'sm:col-span-2' : ''}>
            <input
              type="date"
              className={INPUT}
              value={form.startDate}
              onChange={(e) => set({ startDate: e.target.value, ...(form.endDate < e.target.value ? { endDate: e.target.value } : {}) })}
              aria-label={isHours ? 'Date' : 'Start date'}
            />
          </Field>
          {!isHours ? (
            <Field label="To">
              <input type="date" className={INPUT} min={form.startDate} value={form.endDate} onChange={(e) => set({ endDate: e.target.value })} aria-label="End date" />
            </Field>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:col-span-2">
              <Field label="From">
                <input type="time" className={INPUT} value={form.startTime} onChange={(e) => set({ startTime: e.target.value })} aria-label="Start time" />
              </Field>
              <Field label="To">
                <input type="time" className={INPUT} value={form.endTime} onChange={(e) => set({ endTime: e.target.value })} aria-label="End time" />
              </Field>
            </div>
          )}
        </div>

        {!isHours && type?.allowHalfDays && (
          <div role="radiogroup" aria-label="Part of the day" className="inline-flex rounded-lg border border-input p-0.5">
            {DAY_PARTS.map((p) => {
              const on = form.dayPart === p.value;
              return (
                <label key={p.value} className={`cursor-pointer rounded-md px-3 py-1 text-xs font-medium has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${on ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                  <input type="radio" name="dayPart" value={p.value} checked={on} onChange={() => set({ dayPart: p.value })} className="sr-only" />
                  {p.label}
                </label>
              );
            })}
          </div>
        )}

        {!isHours && <DayStrip startDate={form.startDate} endDate={form.endDate} counted={counted} color={type?.color} dayPart={type?.allowHalfDays ? form.dayPart : 'full'} />}
      </fieldset>

      <Field label={type?.requiresNote ? 'Note (required)' : 'Note (optional)'}>
        <textarea rows={2} className={TEXTAREA} value={form.note} onChange={(e) => set({ note: e.target.value })} aria-label="Note" maxLength={1000} placeholder={type?.requiresNote ? 'Why you need it' : 'Anything your approver should know'} />
      </Field>

      {(me.settings?.outlookEventsEnabled || me.settings?.autoRepliesEnabled) && (
        <div className="space-y-1.5">
          {me.settings.outlookEventsEnabled && (
            <Toggle checked={form.wantsOutlookEvent} onChange={(v) => set({ wantsOutlookEvent: v })} label="Add to my Outlook calendar" />
          )}
          {me.settings.autoRepliesEnabled && !isHours && (
            <Toggle checked={form.wantsAutoReply} onChange={(v) => set({ wantsAutoReply: v })} label="Set my automatic reply" hint="Turned on for the dates away and off when you are back." />
          )}
        </div>
      )}

      {previewing && !preview && (
        <p className="flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Checking…</p>
      )}
      {!unchanged && <Verdict preview={preview} unit={type?.unit} editing={Boolean(editing)} />}
      {previewError && <p className="text-xs text-red-700 dark:text-red-300">{previewError}</p>}
      <ErrorNote>{submitError}</ErrorNote>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {editing && unchanged && <span className="mr-auto text-xs text-muted-foreground">Change the type, dates or note to save.</span>}
        {editing && (
          <button type="button" className={BTN_QUIET} onClick={() => onStopEditing?.()} disabled={saving}>Keep it as it was</button>
        )}
        <button type="submit" className={BTN_PRIMARY} disabled={!valid || saving || refused || unchanged}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
