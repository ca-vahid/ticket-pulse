import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Loader2, XCircle } from 'lucide-react';
import FancySelect from '../common/FancySelect';
import { availabilityAPI } from '../../services/api';
import {
  BTN_PRIMARY, COLOR_DOT, ErrorNote, Field, INPUT, SectionTitle, TEXTAREA, Toggle,
  timeToMinute, nextWorkdayKey, trimNum,
} from './availabilityUi';

/**
 * "Book time away": type, dates, day part (or hours), note, and — only when the
 * admin has switched them on — the Outlook calendar / automatic reply opt-ins.
 * Every change asks the server for a dry run (/requests/preview, debounced) so
 * the verdict reads in plain words before anything is submitted.
 */

const DAY_PARTS = [
  { value: 'full', label: 'Full day' },
  { value: 'am', label: 'Morning' },
  { value: 'pm', label: 'Afternoon' },
];

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

export function Verdict({ preview, unit }) {
  if (!preview) return null;
  const { outcome } = preview;
  const look = outcome === 'approved'
    ? { Icon: CheckCircle2, cls: 'text-emerald-700 dark:text-emerald-300', text: 'Will be approved automatically' }
    : outcome === 'pending'
      ? { Icon: Clock3, cls: 'text-amber-700 dark:text-amber-300', text: 'Goes to your approvers' }
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

export default function BookTimeForm({ me, onBooked, toast }) {
  const types = useMemo(() => (me.leaveTypes || []).filter((t) => t.isActive !== false).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)), [me.leaveTypes]);
  const [form, setForm] = useState(() => emptyForm(types[0]?.id));
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

  useEffect(() => {
    if (!valid) { setPreview(null); setPreviewError(null); return undefined; }
    const mine = ++seq.current;
    setPreviewing(true);
    const t = setTimeout(() => {
      availabilityAPI.preview(JSON.parse(bodyKey))
        .then((res) => { if (mine === seq.current) { setPreview(res?.data || null); setPreviewError(null); } })
        .catch((err) => { if (mine === seq.current) { setPreview(null); setPreviewError(err?.message || 'Could not check this request'); } })
        .finally(() => { if (mine === seq.current) setPreviewing(false); });
    }, 350);
    return () => clearTimeout(t);
  }, [bodyKey, valid]);

  const submit = async (e) => {
    e.preventDefault();
    if (!valid || saving) return;
    if (type?.requiresNote && !form.note.trim()) { setSubmitError(`${type.name} needs a note`); return; }
    setSaving(true);
    setSubmitError(null);
    try {
      const res = await availabilityAPI.createRequest({
        ...body,
        ...(me.settings?.outlookEventsEnabled ? { wantsOutlookEvent: form.wantsOutlookEvent } : {}),
        ...(me.settings?.autoRepliesEnabled ? { wantsAutoReply: form.wantsAutoReply } : {}),
      });
      const status = res?.data?.status;
      toast?.(status === 'approved' ? `${type.name} booked and approved` : `${type.name} sent to your approvers`);
      setForm(emptyForm(type.id));
      setPreview(null);
      onBooked?.(res?.data);
    } catch (err) {
      setSubmitError(err?.message || 'Could not book this time');
    } finally {
      setSaving(false);
    }
  };

  if (!types.length) {
    return <p className="text-sm text-muted-foreground">No leave types are set up yet — ask an Availability admin.</p>;
  }

  const options = types.map((t) => ({ value: String(t.id), label: t.name, dot: COLOR_DOT[t.color] || COLOR_DOT.slate }));
  const refused = preview?.outcome === 'refused';

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Book time away">
      <SectionTitle hint={type?.availability === 'WFH' || type?.availability === 'ONSITE' ? 'Shows on the team calendar; you stay available.' : null}>Book time away</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type" className="sm:col-span-2">
          <FancySelect value={form.leaveTypeId} onChange={(v) => set({ leaveTypeId: v })} options={options} aria-label="Leave type" />
        </Field>
        <Field label={isHours ? 'Date' : 'From'}>
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
          <div className="grid grid-cols-2 gap-2">
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
        <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <legend className="sr-only">Day part</legend>
          {DAY_PARTS.map((p) => (
            <label key={p.value} className="inline-flex items-center gap-1.5 text-sm text-foreground">
              <input type="radio" name="dayPart" value={p.value} checked={form.dayPart === p.value} onChange={() => set({ dayPart: p.value })} className="accent-[hsl(var(--primary))]" />
              {p.label}
            </label>
          ))}
        </fieldset>
      )}

      <Field label={type?.requiresNote ? 'Note (required)' : 'Note'}>
        <textarea rows={2} className={TEXTAREA} value={form.note} onChange={(e) => set({ note: e.target.value })} aria-label="Note" maxLength={1000} />
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
      <Verdict preview={preview} unit={type?.unit} />
      {previewError && <p className="text-xs text-red-700 dark:text-red-300">{previewError}</p>}
      <ErrorNote>{submitError}</ErrorNote>

      <div className="flex items-center justify-end gap-2">
        <button type="submit" className={BTN_PRIMARY} disabled={!valid || saving || refused}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {preview?.outcome === 'pending' ? 'Send for approval' : 'Book'}
        </button>
      </div>
    </form>
  );
}

