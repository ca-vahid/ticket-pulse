import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Clock3, Info, Loader2, Pencil, XCircle } from 'lucide-react';
import { availabilityAPI } from '../../services/api';
import {
  BTN_LINK, BTN_PRIMARY, BTN_QUIET, COLOR_FILL, ColorSwatch, ErrorNote, Field, INPUT, Pictogram, TEXTAREA, Toggle,
  addDaysKey, fmtDay, fmtMinute, fmtRange, isSiteVisitType, leaveLabel, minuteToTime, parseDay, pictogramFor, sitePlace, timeToMinute, todayKey, trimNum,
} from './availabilityUi';
import MonthPicker from './MonthPicker';
import {
  bookedByDay, countWorkingDays, mostUsedTypes, nextWeekRange, pickDay, rangeWords, tomorrowKey,
} from './bookingModel';

/**
 * "Book time away" — and, since Nov 2026, "Change your request" for one that
 * is still waiting (Vahid: Gaby booked Thu + Fri, then wanted only Fri, and
 * had to cancel and book again).
 *
 * Redesigned for QA 11-25 #1 (the QA mockup, refined) as three numbered steps:
 *   1. What   the person's four most-used types as quiet tiles (pictogram and
 *             colour as on the Overview); "More types (N)" opens the rest in
 *             place. A site visit asks "Which office?" (4.4.18).
 *   2. When   an inline month calendar: tap a day, tap a second day for a
 *             range, tap again to start over. Today / Tomorrow / Next week.
 *             A single day offers Full day / Morning / Afternoon (or the hours
 *             for an hours type). A plain summary of the pick.
 *   3. Note   optional, or required where the type says so.
 * Footer: the server's dry run in one line ("5 working days · Vacation · Goes
 * to your approvers"), rule messages and warnings, and Send request. It stays
 * reachable on a phone (sticky above the tab bar).
 *
 * Props in (`me`, `requests`, `holidays`); the only calls are the dry run and
 * the send, so it renders in a harness with the API mocked.
 */

const DAY_PARTS = [
  { value: 'full', label: 'Full day' },
  { value: 'am', label: 'Morning' },
  { value: 'pm', label: 'Afternoon' },
];

const STRIP_MAX = 14;
const OTHER_SITE = 'other';
const SITE_LOCATION_MAX = 160;
const VISIBLE_TYPES = 4;

const emptyForm = (typeId) => ({
  leaveTypeId: typeId ? String(typeId) : '',
  startDate: '',
  endDate: '',
  open: false,
  dayPart: 'full',
  startTime: '09:00',
  endTime: '10:00',
  note: '',
  siteOfficeId: '',
  siteLocation: '',
  wantsOutlookEvent: false,
  wantsAutoReply: false,
});

/** The form, filled in from a request being changed. */
export function formFromRequest(r) {
  return {
    leaveTypeId: String(r.leaveTypeId),
    startDate: r.startDate,
    endDate: r.endDate,
    open: false,
    dayPart: r.dayPart === 'hours' ? 'full' : (r.dayPart || 'full'),
    startTime: r.startMinute != null ? minuteToTime(r.startMinute) : '09:00',
    endTime: r.endMinute != null ? minuteToTime(r.endMinute) : '10:00',
    note: r.note || '',
    siteOfficeId: r.siteOfficeId ? String(r.siteOfficeId) : (r.siteLocation ? OTHER_SITE : ''),
    siteLocation: r.siteLocation || '',
    wantsOutlookEvent: Boolean(r.wantsOutlookEvent),
    wantsAutoReply: Boolean(r.wantsAutoReply),
  };
}

/** The "Which office?" answer as the API takes it: { siteOfficeId } or { siteLocation }, or nothing. */
export function siteBody(form, type) {
  if (!isSiteVisitType(type)) return {};
  if (form.siteOfficeId === OTHER_SITE) {
    const text = String(form.siteLocation || '').trim();
    return text ? { siteLocation: text } : {};
  }
  return form.siteOfficeId ? { siteOfficeId: Number(form.siteOfficeId) } : {};
}

/** Is the site visit's place answered? */
export const siteAnswered = (form) => (form.siteOfficeId === OTHER_SITE ? Boolean(String(form.siteLocation || '').trim()) : Boolean(form.siteOfficeId));

export function buildRequestBody(form, type) {
  const isHours = type?.unit === 'hour';
  const body = {
    leaveTypeId: Number(form.leaveTypeId),
    startDate: form.startDate,
    endDate: isHours ? form.startDate : form.endDate,
    dayPart: isHours ? 'hours' : (type?.allowHalfDays ? form.dayPart : 'full'),
    note: form.note.trim() || undefined,
    ...siteBody(form, type),
  };
  if (isHours) {
    body.startMinute = timeToMinute(form.startTime);
    body.endMinute = timeToMinute(form.endTime);
  }
  return body;
}

/**
 * "Which office?" (25 Nov 2026) for a site visit: a plain select of the active
 * offices by name, then "Other site…", which opens a short text box with its
 * own visible label. `error` is shown under the control it is about (the text
 * box when "Other site…" is picked, else the select), which is marked
 * aria-invalid and described by it. Props in, so it renders on its own.
 */
export function SiteOfficeField({ offices = [], value = '', location = '', onChange, required = true, keepOfficeId = null, error = null }) {
  const uid = useId().replace(/:/g, '');
  const ids = { select: `av-site-office-${uid}`, hint: `av-site-office-${uid}-hint`, site: `av-site-text-${uid}`, error: `av-site-${uid}-error` };
  const choices = (offices || [])
    .filter((o) => o.isActive !== false || String(o.id) === String(keepOfficeId))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const other = value === OTHER_SITE;
  const officeInvalid = Boolean(error) && !other;
  const siteInvalid = Boolean(error) && other;
  const errorNote = error ? <p id={ids.error} role="alert" className="text-xs text-red-700 dark:text-red-300">{error}</p> : null;
  return (
    <div className="space-y-1.5" data-testid="site-office-field">
      <div className="grid min-w-0 gap-1 text-sm">
        <label htmlFor={ids.select} className="text-xs font-medium text-muted-foreground">{required ? 'Which office? (required)' : 'Which office?'}</label>
        <select
          id={ids.select}
          className={`${INPUT}${officeInvalid ? ' border-destructive' : ''}`}
          value={value}
          onChange={(e) => onChange?.({ siteOfficeId: e.target.value, ...(e.target.value === OTHER_SITE ? {} : { siteLocation: '' }) })}
          aria-required={required}
          aria-invalid={officeInvalid || undefined}
          aria-describedby={officeInvalid ? `${ids.hint} ${ids.error}` : ids.hint}
        >
          <option value="">Pick an office…</option>
          {choices.map((o) => <option key={o.id} value={String(o.id)}>{o.name}</option>)}
          <option value={OTHER_SITE}>Other site…</option>
        </select>
        <span id={ids.hint} className="text-xs text-muted-foreground">So the team and the assigner know where you are that day.</span>
        {officeInvalid && errorNote}
      </div>
      {other && (
        <div className="grid min-w-0 gap-1 text-sm">
          <label htmlFor={ids.site} className="text-xs font-medium text-muted-foreground">{required ? 'Which site? (required)' : 'Which site?'}</label>
          <input
            id={ids.site}
            type="text"
            className={`${INPUT}${siteInvalid ? ' border-destructive' : ''}`}
            value={location}
            onChange={(e) => onChange?.({ siteOfficeId: OTHER_SITE, siteLocation: e.target.value })}
            placeholder="Client site, city or address"
            maxLength={SITE_LOCATION_MAX}
            aria-required={required}
            aria-invalid={siteInvalid || undefined}
            aria-describedby={siteInvalid ? ids.error : undefined}
          />
          {siteInvalid && errorNote}
        </div>
      )}
    </div>
  );
}

/** What the dry run says, in the words the form has always used. */
function verdictLook(preview, editing) {
  const { outcome } = preview;
  if (outcome === 'approved') return { Icon: CheckCircle2, cls: 'text-emerald-700 dark:text-emerald-300', text: editing ? 'The change will be approved automatically' : 'Will be approved automatically' };
  if (outcome === 'pending') return { Icon: Clock3, cls: 'text-amber-700 dark:text-amber-300', text: editing ? 'The change goes to your approvers' : 'Goes to your approvers' };
  return { Icon: XCircle, cls: 'text-red-700 dark:text-red-300', text: preview.reason || 'This request cannot be booked' };
}

function verdictAmount(preview, unit) {
  return unit === 'hour'
    ? `${trimNum(preview.hours)} ${Number(preview.hours) === 1 ? 'hour' : 'hours'}`
    : `${trimNum(preview.days)} working ${Number(preview.days) === 1 ? 'day' : 'days'}`;
}

/** The dry run as a block (kept for other callers; the booking card uses RequestCheck). */
export function Verdict({ preview, unit, editing = false }) {
  if (!preview) return null;
  const look = verdictLook(preview, editing);
  const messages = (preview.fired || []).filter((f) => f.message && f.outcome !== 'warn' && f.message !== preview.reason);
  const warnings = preview.warnings || [];
  return (
    <div className="space-y-1.5 border-t border-border pt-3" data-testid="availability-verdict" aria-live="polite">
      <p className={`flex items-start gap-2 text-sm font-medium ${look.cls}`}>
        <look.Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{look.text}</span>
      </p>
      <p className="pl-6 text-xs text-muted-foreground">
        {verdictAmount(preview, unit)}{unit !== 'hour' && ' (weekends and holidays skipped)'}
        {preview.remaining != null && ` · ${trimNum(preview.remaining)} left after this`}
        {preview.outcome === 'pending' && preview.reason && ` · ${preview.reason}`}
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
 * The footer's request check in one line: "5 working days · Vacation · Goes
 * to your approvers", then what is left after it, the rules' messages and
 * warnings underneath in small type.
 */
export function RequestCheck({ preview, unit, typeName, editing = false }) {
  if (!preview) return null;
  const look = verdictLook(preview, editing);
  const messages = (preview.fired || []).filter((f) => f.message && f.outcome !== 'warn' && f.message !== preview.reason);
  const warnings = preview.warnings || [];
  const extra = [
    preview.remaining != null ? `${trimNum(preview.remaining)} left after this` : null,
    preview.outcome === 'pending' && preview.reason ? preview.reason : null,
  ].filter(Boolean).join(' · ');
  return (
    <div className="min-w-0 space-y-1" data-testid="availability-verdict">
      <p className="flex items-start gap-1.5 text-sm">
        <look.Icon className={`mt-0.5 h-4 w-4 shrink-0 ${look.cls}`} aria-hidden="true" />
        <span className="min-w-0">
          {preview.outcome !== 'refused' && <span className="text-foreground" data-testid="request-check-amount">{verdictAmount(preview, unit)} · {typeName} · </span>}
          <span className={`font-medium ${look.cls}`}>{look.text}</span>
        </span>
      </p>
      {extra && <p className="pl-[1.375rem] text-xs text-muted-foreground">{extra}</p>}
      {messages.length > 0 && (
        <ul className="space-y-0.5 pl-[1.375rem] text-xs text-foreground/85">
          {messages.map((f) => <li key={`r-${f.ruleId}-${f.name}`}>{f.message}</li>)}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="space-y-0.5 pl-[1.375rem] text-xs text-amber-700 dark:text-amber-300">
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
 * type's colour, weekends and holidays struck through. (The booking card now
 * shows the range on its calendar; this stays for other callers.)
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

const STEP = 'text-xs font-semibold text-foreground';
// Stable defaults, so the memos below do not recompute on every render.
const NO_REQUESTS = [];
const NO_HOLIDAYS = {};

export default function BookTimeForm({
  me,
  onBooked,
  toast,
  editing = null,
  onStopEditing = null,
  presetTypeId = null,
  requests = NO_REQUESTS,
  holidays = NO_HOLIDAYS,
  today = todayKey(),
  notice = null,
}) {
  const uid = useId().replace(/:/g, '');
  const ids = {
    what: `bt-${uid}-what`, when: `bt-${uid}-when`, more: `bt-${uid}-more`, note: `bt-${uid}-note`, noteError: `bt-${uid}-note-error`, radio: `leaveType-${uid}`,
  };
  const types = useMemo(() => (me.leaveTypes || []).filter((t) => t.isActive !== false).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)), [me.leaveTypes]);
  const typeById = useMemo(() => new Map((me.leaveTypes || []).map((t) => [t.id, t])), [me.leaveTypes]);
  const holidaySet = useMemo(() => new Set(Object.keys(holidays || {})), [holidays]);
  const ranked = useMemo(() => mostUsedTypes(types, requests, VISIBLE_TYPES), [types, requests]);
  const original = useMemo(() => (editing ? formFromRequest(editing) : null), [editing]);
  const preset = presetTypeId && types.some((t) => t.id === presetTypeId) ? presetTypeId : null;
  const [form, setForm] = useState(() => original || emptyForm(preset || ranked[0]?.id || types[0]?.id));
  // Until the person picks a type, the first tile follows their most-used type (their requests load after the form).
  const typeTouched = useRef(Boolean(original || preset));
  const [moreOpen, setMoreOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [submitError, setSubmitError] = useState(null);
  const [siteError, setSiteError] = useState(null);
  const [noteError, setNoteError] = useState(null);
  const [sent, setSent] = useState(null);
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);
  const formRef = useRef(null);

  useEffect(() => {
    if (typeTouched.current || !ranked[0]) return;
    setForm((f) => (f.leaveTypeId === String(ranked[0].id) ? f : { ...f, leaveTypeId: String(ranked[0].id) }));
  }, [ranked]);

  const type = types.find((t) => String(t.id) === form.leaveTypeId) || null;
  const isHours = type?.unit === 'hour';
  const minKey = type?.allowPastDated ? null : today;
  const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setSubmitError(null); setSiteError(null); setNoteError(null); setSent(null); };

  const picked = Boolean(form.startDate);
  const single = picked && (isHours || form.startDate === form.endDate);
  // A waiting request that has already started keeps its dates while other things change.
  const pastOk = !minKey || !form.startDate || form.startDate >= minKey || Boolean(original && original.startDate === form.startDate);
  const valid = Boolean(type && picked && pastOk && (isHours || (form.endDate && form.endDate >= form.startDate))
    && (!isHours || (form.startTime && form.endTime && form.endTime > form.startTime)));
  // "Which office?" (25 Nov 2026): required for a site visit when booking, and
  // when a change touches the type or the dates (an older booking without one
  // can still have its note changed).
  const onSite = isSiteVisitType(type);
  const siteRequired = onSite && (!original || original.leaveTypeId !== form.leaveTypeId
    || original.startDate !== form.startDate || original.endDate !== form.endDate);
  const siteOk = !siteRequired || siteAnswered(form);
  const body = useMemo(() => (type && picked ? buildRequestBody(form, type) : null), [form, type, picked]);
  const bodyKey = JSON.stringify(body);
  // The dry run does not depend on the place, so typing a site does not re-ask it.
  const previewKey = useMemo(() => {
    if (!body) return 'null';
    return JSON.stringify(Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'siteOfficeId' && k !== 'siteLocation')));
  }, [body]);
  const originalKey = useMemo(() => {
    if (!original) return null;
    const t = types.find((x) => String(x.id) === original.leaveTypeId);
    return t ? JSON.stringify(buildRequestBody(original, t)) : null;
  }, [original, types]);
  const unchanged = Boolean(editing && originalKey === bodyKey
    && Boolean(original.wantsOutlookEvent) === Boolean(form.wantsOutlookEvent)
    && Boolean(original.wantsAutoReply) === Boolean(form.wantsAutoReply));

  useEffect(() => {
    if (!valid) { setPreview(null); setPreviewError(null); setPreviewing(false); return undefined; }
    const mine = ++seq.current;
    setPreviewing(true);
    const t = setTimeout(() => {
      availabilityAPI.preview({ ...JSON.parse(previewKey), ...(editing ? { requestId: editing.id } : {}) })
        .then((res) => { if (mine === seq.current) { setPreview(res?.data || null); setPreviewError(null); } })
        .catch((err) => { if (mine === seq.current) { setPreview(null); setPreviewError(err?.message || 'Could not check this request'); } })
        .finally(() => { if (mine === seq.current) setPreviewing(false); });
    }, 350);
    return () => clearTimeout(t);
  }, [previewKey, valid, editing]);

  const booked = useMemo(
    () => bookedByDay(requests, typeById, { excludeId: editing?.id ?? null, holidaySet }),
    [requests, typeById, editing, holidaySet],
  );

  if (!types.length) {
    return <p className="text-sm text-muted-foreground">No leave types are set up yet — ask a Vacation Pulse admin.</p>;
  }

  // ---- 1. What
  const visible = !type || ranked.some((t) => t.id === type.id) ? ranked : [...ranked.slice(0, VISIBLE_TYPES - 1), type];
  const rest = types.filter((t) => !visible.some((v) => v.id === t.id));
  const chooseType = (t, { fromMore = false } = {}) => {
    typeTouched.current = true;
    const hours = t.unit === 'hour';
    const patch = { leaveTypeId: String(t.id) };
    // A pick the new type cannot take is reset: hours are one day, and past days need a type that allows them.
    if (form.startDate && !t.allowPastDated && form.startDate < today) Object.assign(patch, { startDate: '', endDate: '', open: false });
    else if (hours && form.startDate && form.endDate !== form.startDate) Object.assign(patch, { endDate: form.startDate, open: false });
    if (!t.allowHalfDays) patch.dayPart = 'full';
    set(patch);
    if (fromMore) {
      setMoreOpen(false);
      // The picked type now sits in the fourth tile: keep the focus on it.
      setTimeout(() => formRef.current?.querySelector(`input[name="${ids.radio}"][value="${t.id}"]`)?.focus(), 0);
    }
  };

  const tile = (t, fromMore = false) => {
    const on = String(t.id) === form.leaveTypeId;
    const hintId = t.description ? `bt-${uid}-type-${t.id}-hint` : undefined;
    return (
      <label
        key={t.id}
        className={`flex min-h-[2.75rem] min-w-0 cursor-pointer items-center gap-2.5 rounded-md border px-2.5 py-2 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${on
          ? 'border-primary bg-primary/5 text-foreground dark:bg-primary/15'
          : 'border-border text-foreground/85 hover:bg-muted'}`}
      >
        <input
          type="radio"
          name={ids.radio}
          value={String(t.id)}
          checked={on}
          onChange={() => chooseType(t, { fromMore })}
          aria-label={t.name}
          aria-describedby={hintId}
          className="sr-only"
        />
        <Pictogram name={pictogramFor(t)} className="h-6 w-6" />
        <span className="min-w-0 flex-1 leading-tight">
          <span className={on ? 'font-medium' : ''}>{t.name}</span>
          {t.description && <span id={hintId} className="mt-0.5 block text-xs text-muted-foreground">{t.description}</span>}
        </span>
        <ColorSwatch color={t.color} />
      </label>
    );
  };

  // ---- 2. When
  const sel = { start: form.startDate || null, end: form.endDate || null, open: form.open };
  const applyPick = (p) => set({ startDate: p.start, endDate: p.end, open: p.open, ...(p.start !== p.end ? { dayPart: 'full' } : {}) });
  const onPick = (key) => applyPick(pickDay(sel, key, { single: isHours }));
  const quick = [
    { label: 'Today', run: () => applyPick({ start: today, end: today, open: !isHours }) },
    { label: 'Tomorrow', run: () => { const k = tomorrowKey(today, holidaySet); applyPick({ start: k, end: k, open: !isHours }); } },
    ...(isHours ? [] : [{ label: 'Next week', run: () => { const r = nextWeekRange(today); applyPick({ start: r.start, end: r.end, open: false }); } }]),
  ];
  const showDayPart = picked && !isHours && type?.allowHalfDays && (single || form.dayPart !== 'full');
  const workingDays = picked && !isHours ? countWorkingDays(form.startDate, form.endDate, holidaySet) : 0;
  const amountWords = !picked ? '' : isHours
    ? (form.startTime && form.endTime && form.endTime > form.startTime ? `${fmtMinute(timeToMinute(form.startTime))}–${fmtMinute(timeToMinute(form.endTime))}` : 'pick the hours')
    : single && form.dayPart === 'am' ? 'morning'
      : single && form.dayPart === 'pm' ? 'afternoon'
        : workingDays === 0 ? 'no working days' : `${workingDays} working ${workingDays === 1 ? 'day' : 'days'}`;
  const extendHint = picked && form.open && single && !isHours ? 'tap another day for a range' : null;
  const summary = picked ? [rangeWords(form.startDate, isHours ? form.startDate : form.endDate, { today }), amountWords, extendHint].filter(Boolean).join(' · ') : '';
  const spoken = picked ? [rangeWords(form.startDate, isHours ? form.startDate : form.endDate, { today, joiner: ' to ' }), amountWords, extendHint].filter(Boolean).join(', ') : '';

  // ---- Footer
  const refused = preview?.outcome === 'refused';
  const stays = type?.availability === 'WFH' || type?.availability === 'ONSITE';
  const submitLabel = editing
    ? (preview?.outcome === 'approved' ? 'Save changes' : 'Send changes for approval')
    : 'Send request';
  const waitingOn = (editing?.waitingOn || []).map((p) => p.name || p.email).filter(Boolean);

  const submit = async (e) => {
    e.preventDefault();
    if (!valid || saving || unchanged) return;
    if (!siteOk) { setSiteError(form.siteOfficeId === OTHER_SITE ? 'Say which site you are visiting' : 'Pick which office the site visit is at'); return; }
    if (type?.requiresNote && !form.note.trim()) {
      setNoteError(`${type.name} needs a note`);
      document.getElementById(ids.note)?.focus?.();
      return;
    }
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
      if (!editing) {
        const what = `${leaveLabel(type.name, sitePlace(siteBody(form, type), me.offices))}, ${rangeWords(form.startDate, body.endDate, { today })}`;
        setForm(emptyForm(type.id));
        setSent({ text: status === 'approved' ? `${what}: booked and approved.` : `${what}: sent to your approvers.` });
      }
      setPreview(null);
      onBooked?.(res?.data);
    } catch (err) {
      setSubmitError(err?.message || (editing ? 'Could not save your changes' : 'Could not book this time'));
    } finally {
      setSaving(false);
    }
  };

  let status;
  if (editing && unchanged) status = <span className="text-sm text-muted-foreground">Change the type, dates, place or note to save.</span>;
  else if (!picked) {
    status = sent
      ? <span role="status" className="flex items-start gap-1.5 text-sm text-foreground" data-testid="booking-sent"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-300" aria-hidden="true" />{sent.text}</span>
      : <span className="text-sm text-muted-foreground" data-testid="booking-pick-first">Pick a day to continue</span>;
  } else if (!valid && isHours) status = <span className="text-sm text-muted-foreground">Pick a start and an end time</span>;
  else if (!valid) status = <span className="text-sm text-muted-foreground">Pick a day you can book</span>;
  else if (previewing && !preview) status = <span className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Checking…</span>;
  else if (preview) status = <RequestCheck preview={preview} unit={type?.unit} typeName={leaveLabel(type?.name, onSite ? sitePlace(siteBody(form, type), me.offices) : null)} editing={Boolean(editing)} />;

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      noValidate
      className="space-y-5"
      aria-label={editing ? 'Change your request' : 'Book time away'}
      data-booking-form="true"
      data-editing={editing ? 'true' : undefined}
    >
      {editing ? (
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Pencil className="h-4 w-4 text-primary" aria-hidden="true" />Change your request
          </h2>
          <p className="text-xs text-muted-foreground">
            Now: {leaveLabel(types.find((t) => t.id === editing.leaveTypeId)?.name, sitePlace(editing, me.offices))}, {fmtRange(editing)}
            {waitingOn.length > 0 && ` · waiting for ${waitingOn.join(' or ')}`}.
            {' '}It stays the same request; the rules check it again and your approvers see what changed.
          </p>
        </div>
      ) : (
        <h2 className="text-base font-semibold text-foreground">Book time away</h2>
      )}

      {/* 1. What */}
      <fieldset className="min-w-0 space-y-2">
        <legend id={ids.what} className={`${STEP} mb-2`}>1. What</legend>
        <div className="grid grid-cols-2 gap-2" data-testid="type-tiles">
          {visible.map((t) => tile(t))}
        </div>
        {rest.length > 0 && (
          <button
            type="button"
            className={`${BTN_LINK} -ml-2 text-xs`}
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-controls={moreOpen ? ids.more : undefined}
          >
            {moreOpen ? 'Fewer types' : `More types (${rest.length})`}
            <ChevronDown className={`h-3.5 w-3.5 ${moreOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
        )}
        {moreOpen && rest.length > 0 && (
          <div id={ids.more} role="group" aria-label="More types" className="grid grid-cols-2 gap-2 animate-fadeIn" data-testid="more-types">
            {rest.map((t) => tile(t, true))}
          </div>
        )}
        {stays && <p className="text-xs text-muted-foreground">Shows on the team calendar; you stay available.</p>}
      </fieldset>

      {onSite && (
        <SiteOfficeField
          offices={me.offices || []}
          value={form.siteOfficeId}
          location={form.siteLocation}
          onChange={set}
          required={siteRequired}
          keepOfficeId={editing?.siteOfficeId ?? null}
          error={siteError}
        />
      )}

      {/* 2. When */}
      <fieldset className="min-w-0 space-y-3" aria-labelledby={ids.when}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-xs text-muted-foreground">
            <span id={ids.when} className={STEP}>2. When</span>
            <span> — {isHours ? 'tap a day' : 'tap a day, or tap two days for a range'}</span>
          </p>
          <span className="-mr-2 flex flex-wrap items-center">
            {quick.map((q) => (
              <button key={q.label} type="button" className={`${BTN_LINK} px-1.5 py-0.5 text-xs`} onClick={q.run}>{q.label}</button>
            ))}
          </span>
        </div>

        <div className="rounded-lg border border-border/70 p-2 sm:p-3">
          <MonthPicker
            start={sel.start}
            end={isHours ? sel.start : sel.end}
            onPick={onPick}
            today={today}
            minKey={minKey}
            holidays={holidays || {}}
            booked={booked}
            labelledBy={ids.when}
          />
        </div>

        {showDayPart && (
          <div role="radiogroup" aria-label="Part of the day" className="inline-flex rounded-md border border-input p-0.5">
            {DAY_PARTS.map((p) => {
              const on = form.dayPart === p.value;
              return (
                <label key={p.value} className={`cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${on ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                  <input type="radio" name={`dayPart-${uid}`} value={p.value} checked={on} onChange={() => set({ dayPart: p.value })} className="sr-only" />
                  {p.label}
                </label>
              );
            })}
          </div>
        )}

        {isHours && picked && (
          <div className="grid max-w-xs grid-cols-2 gap-2">
            <Field label="From">
              <input type="time" className={INPUT} value={form.startTime} onChange={(e) => set({ startTime: e.target.value })} aria-label="Start time" />
            </Field>
            <Field label="To">
              <input type="time" className={INPUT} value={form.endTime} onChange={(e) => set({ endTime: e.target.value })} aria-label="End time" />
            </Field>
          </div>
        )}

        {picked && (
          <>
            <p className="text-sm font-medium text-foreground" aria-hidden="true" data-testid="pick-summary">{summary}</p>
            <p className="sr-only" aria-live="polite" data-testid="pick-spoken">{spoken}</p>
          </>
        )}
      </fieldset>

      {/* 3. Note */}
      <div className="grid min-w-0 gap-1.5 text-sm">
        <label htmlFor={ids.note} className="text-xs text-muted-foreground">
          <span className={STEP}>3. Note</span> {type?.requiresNote ? '(required)' : '(optional)'}
        </label>
        <textarea
          id={ids.note}
          rows={2}
          className={`${TEXTAREA}${noteError ? ' border-destructive' : ''}`}
          value={form.note}
          onChange={(e) => set({ note: e.target.value })}
          maxLength={1000}
          placeholder={type?.requiresNote ? 'Why you need it' : 'Anything your approver should know'}
          aria-required={type?.requiresNote || undefined}
          aria-invalid={noteError ? true : undefined}
          aria-describedby={noteError ? ids.noteError : undefined}
        />
        {noteError && <p id={ids.noteError} role="alert" className="text-xs text-red-700 dark:text-red-300">{noteError}</p>}
      </div>

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

      {notice && (
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{notice}
        </p>
      )}
      {previewError && <p className="text-xs text-red-700 dark:text-red-300">{previewError}</p>}
      <ErrorNote>{submitError}</ErrorNote>

      {/* The footer stays reachable on a phone: sticky above the tab bar and the safe area. */}
      <div
        className="sticky bottom-[calc(3.25rem_+_env(safe-area-inset-bottom))] z-10 -mx-4 -mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-b-xl border-t border-border bg-card px-4 py-3 md:bottom-0"
        data-testid="booking-footer"
      >
        <div className="min-w-0 flex-1 basis-56" aria-live="polite">{status}</div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {editing && (
            <button type="button" className={BTN_QUIET} onClick={() => onStopEditing?.()} disabled={saving}>Keep it as it was</button>
          )}
          <button type="submit" className={`${BTN_PRIMARY} h-10 px-4`} disabled={!valid || saving || refused || unchanged}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}

/** The booking card, by the name the redesign uses. */
export { BookTimeForm as BookTimeCard };
