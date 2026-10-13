import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarClock, CalendarDays, Download, Hand, List, PhoneCall, Settings2 } from 'lucide-react';
import AppHeader from '../components/AppHeader';
import MobileTabBar from '../components/nav/MobileTabBar';
import { urgentResponseAPI } from '../services/api';
import { EmptyState } from '../components/knowledge/knowledgeUi';
import { Button } from '../components/ui';
import { COVER_CHANGED_EVENT, TakeCoverDialog, answerCoverRequest } from '../components/onCall/coverRequests';
import OnCallHero from '../components/onCall/OnCallHero';
import OnCallRibbon from '../components/onCall/OnCallRibbon';
import OnCallWeekList from '../components/onCall/OnCallWeekList';
import OnCallCalendar from '../components/onCall/OnCallCalendar';
import OnCallRotation from '../components/onCall/OnCallRotation';
import { Face, SectionHeading } from '../components/onCall/onCallUi';
import {
  coverCommitment, formatOnCallMoment, handoverDayName, handoverTimeLabel,
} from '../utils/onCallFormat';
import { buildIcs, hueMap, localDateOf, sameId } from '../utils/onCallSchedule';

/**
 * On-call (plans/URGENT_RESPONSE_PLAN.md) — open to every signed-in member,
 * agents included. Read-only: who has the phone now and until when, who is
 * next, your own turn, the weeks ahead (a strip, a list in words, or month
 * grids), the rotation order, and the cover requests waiting for the
 * signed-in person. Admins change the rotation in Settings; this page is where
 * everybody else looks it up.
 *
 *   /on-call?request=<id>   scrolls to that cover request and marks it
 *
 * "Now" is the server's clock carried forward, so the countdown and the line
 * on the strip do not depend on the viewer's own clock being right.
 */

const VIEW_KEY = 'tp_on_call_view';
const TICK_MS = 30 * 1000;
const REFRESH_MS = 5 * 60 * 1000;

function readView() {
  try { return window.localStorage.getItem(VIEW_KEY) === 'calendar' ? 'calendar' : 'weeks'; } catch { return 'weeks'; }
}

/** The server's "now", carried forward by the time that has passed since it was read. */
function useServerNow(serverNow) {
  const base = useMemo(() => {
    const server = serverNow ? new Date(serverNow).getTime() : NaN;
    return { server: Number.isNaN(server) ? Date.now() : server, readAt: Date.now() };
  }, [serverNow]);
  // Only the device time that has PASSED is kept in state. The value is worked out on every render,
  // so the render in which the schedule arrives already uses the server's clock. It used to keep
  // the device clock for that one render, and the hand-over check below then read the schedule a
  // second time on any device whose clock was past the current holder's end (13 Oct 2026: this is
  // also why the page's tests began to fail once the real date passed the date in their fixture).
  const [device, setDevice] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setDevice(Date.now());
    tick();
    const id = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(id);
  }, [base]);
  return base.server + Math.max(0, device - base.readAt);
}

function saveFile(text, filename) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

function CoverRequestRow({ request, person, timeZone, highlighted, busy, onTake, onDecline, rowRef }) {
  const who = request.original?.name || 'A colleague';
  return (
    <li
      ref={rowRef}
      data-testid={`cover-request-${request.id}`}
      data-highlighted={highlighted ? 'true' : undefined}
      className={`rounded-xl border bg-card p-4 transition-shadow ${highlighted ? 'border-primary ring-2 ring-primary/30' : 'border-border'}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="relative">
            <Face person={person || { name: who }} size="h-10 w-10" textSize="text-xs" />
            <span className="absolute -bottom-1 -right-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-card text-amber-600 ring-1 ring-border dark:text-amber-300" aria-hidden="true">
              <Hand className="h-3 w-3" />
            </span>
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">{who}</p>
            <p className="text-xs text-muted-foreground">needs on-call cover</p>
            <p className="mt-2 text-sm text-foreground">
              {formatOnCallMoment(request.startsAt, timeZone)} to {formatOnCallMoment(request.endsAt, timeZone)}
            </p>
            {request.message && <p className="mt-1 whitespace-pre-line break-words text-sm leading-relaxed text-muted-foreground">{request.message}</p>}
            {request.createdBy && <p className="mt-1 text-xs text-muted-foreground">Asked by {request.createdBy}</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={onTake} className="tp-focus-ring" aria-label={`Take it: cover for ${who}`}>Take it</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onDecline} className="tp-focus-ring" aria-label={`Not this time: cover for ${who}`}>Not this time</Button>
        </div>
      </div>
    </li>
  );
}

function ViewSwitch({ view, onChange }) {
  const option = (id, label, Icon) => (
    <button
      type="button"
      role="radio"
      aria-checked={view === id}
      onClick={() => onChange(id)}
      className={`tp-focus-ring inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${view === id ? 'bg-card text-foreground shadow-subtle' : 'text-muted-foreground hover:text-foreground'}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </button>
  );
  return (
    <div role="radiogroup" aria-label="How to show the schedule" className="inline-flex rounded-lg bg-muted p-0.5">
      {option('weeks', 'Weeks', List)}
      {option('calendar', 'Calendar', CalendarDays)}
    </div>
  );
}

function Skeleton() {
  const block = 'animate-pulse rounded-xl bg-muted';
  return (
    <div role="status" aria-label="Loading on-call…" data-testid="on-call-loading">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className={`${block} h-44`} />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
          <div className={`${block} h-20`} />
          <div className={`${block} h-20`} />
        </div>
      </div>
      <div className={`${block} mt-8 h-16`} />
      <div className={`${block} mt-4 h-64`} />
    </div>
  );
}

const HOW = [
  [PhoneCall, 'One person at a time', 'Whoever is on call takes the urgent tickets that arrive after hours.'],
  [CalendarClock, 'It changes hands once a week', null],
  [Hand, 'Away on your week?', 'Tell your admin early. They set a cover or ask the rotation, and the first person to accept takes it. Nobody is skipped without agreeing.'],
];

export default function OnCall() {
  const [searchParams] = useSearchParams();
  const wantedId = searchParams.get('request');
  const [data, setData] = useState(null);
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [note, setNote] = useState(null); // { tone: 'ok' | 'info' | 'error', text }
  const [view, setView] = useState(readView);
  const [picked, setPicked] = useState({ index: null, at: 0 });
  const [fileNote, setFileNote] = useState(null);
  const wantedRef = useRef(null);
  const scrolledFor = useRef(null);
  const loadedAt = useRef(0);

  const loadSchedule = useCallback(() => {
    urgentResponseAPI.getOnCall()
      .then((res) => { loadedAt.current = Date.now(); setData(res?.data || {}); setError(null); })
      .catch((err) => setError(err?.message || 'Could not load the on-call schedule.'));
  }, []);

  const loadRequests = useCallback(() => {
    urgentResponseAPI.myCoverRequests()
      .then((res) => setRequests(Array.isArray(res?.data) ? res.data : []))
      .catch(() => setRequests((prev) => prev || []));
  }, []);

  useEffect(() => { loadSchedule(); loadRequests(); }, [loadSchedule, loadRequests]);

  // The app-wide prompt can answer a request too: follow it.
  useEffect(() => {
    const onChange = () => { loadSchedule(); loadRequests(); };
    window.addEventListener(COVER_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(COVER_CHANGED_EVENT, onChange);
  }, [loadSchedule, loadRequests]);

  // A page left open all week stays right: read again when the tab comes back, once it is stale.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !loadedAt.current || Date.now() - loadedAt.current < REFRESH_MS) return;
      loadSchedule();
      loadRequests();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadSchedule, loadRequests]);

  // ?request=<id>: bring that request into view once it is on the page.
  const wantedPresent = Boolean(wantedId && (requests || []).some((r) => sameId(r.id, wantedId)));
  useEffect(() => {
    if (!wantedPresent || scrolledFor.current === wantedId) return;
    scrolledFor.current = wantedId;
    const el = wantedRef.current;
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
  }, [wantedPresent, wantedId]);

  const now = useServerNow(data?.now);
  const timeZone = data?.timezone || undefined;
  const myId = data?.me?.technicianId ?? null;

  // The hand-over itself: once the current holder's time is up, read the schedule again.
  const untilMs = data?.current?.until ? new Date(data.current.until).getTime() : null;
  const reloadedFor = useRef(null);
  useEffect(() => {
    if (!untilMs || now < untilMs || reloadedFor.current === untilMs) return;
    reloadedFor.current = untilMs;
    loadSchedule();
  }, [now, untilMs, loadSchedule]);

  const weeks = useMemo(() => (Array.isArray(data?.weeks) ? data.weeks : []), [data]);
  const days = useMemo(() => (Array.isArray(data?.days) ? data.days : []), [data]);
  const order = useMemo(() => (Array.isArray(data?.order) ? data.order : []), [data]);
  const holidays = useMemo(() => (Array.isArray(data?.holidays) ? data.holidays : []), [data]);
  // Faces by id; a name from the schedule stands in when the API sent no face (older API, or a failed photo read).
  const people = useMemo(() => {
    const map = { ...(data?.people || {}) };
    const add = (p) => { if (p?.id != null && !map[p.id]) map[p.id] = { id: p.id, name: p.name }; };
    add(data?.current?.technician);
    add(data?.current?.scheduled);
    for (const week of weeks) {
      add(week.scheduled);
      for (const cover of week.covers || []) add(cover.technician);
    }
    return map;
  }, [data, weeks]);
  const hues = useMemo(() => hueMap(order, [
    ...weeks.map((w) => w.scheduled?.id),
    ...weeks.flatMap((w) => (w.segments || []).map((s) => s.technicianId)),
    ...weeks.flatMap((w) => (w.covers || []).map((c) => c.technician?.id)),
    data?.current?.technician?.id,
  ]), [order, weeks, data]);

  const answer = async (request, choice) => {
    setBusyId(request.id);
    const result = await answerCoverRequest(request, choice);
    setBusyId(null);
    setConfirming(null);
    if (result.outcome === 'error') { setNote({ tone: 'error', text: result.message }); return; }
    setRequests((list) => (list || []).filter((r) => r.id !== request.id));
    if (result.outcome === 'accepted') setNote({ tone: 'ok', text: `Thank you. ${coverCommitment(request, timeZone)}` });
    else if (result.outcome === 'taken') setNote({ tone: 'info', text: 'Someone else already took it. Nothing more for you to do.' });
    else setNote({ tone: 'info', text: 'Noted. You will not be asked again for this one.' });
  };

  const changeView = (next) => {
    setView(next);
    try { window.localStorage.setItem(VIEW_KEY, next); } catch { /* a private window: the choice lasts for this visit */ }
  };

  const download = (onlyMine) => {
    const file = buildIcs({ weeks, people, onlyTechnicianId: onlyMine ? myId : null, now: new Date(now), host: window.location.hostname || 'ticketpulse' });
    if (!file.count) { setFileNote('There is nothing to put in a calendar yet.'); return; }
    const saved = saveFile(file.text, onlyMine ? 'my-on-call.ics' : 'on-call-schedule.ics');
    setFileNote(saved
      ? `Downloaded ${file.count} ${file.count === 1 ? 'entry' : 'entries'}. Open the file to add ${file.count === 1 ? 'it' : 'them'} to your calendar. It is a copy: download it again after a cover changes.`
      : 'Your browser did not let the file download.');
  };

  const today = localDateOf(now, timeZone);
  const current = data?.current || null;
  const hasRotation = Boolean(current?.technician || current?.scheduled || weeks.length);
  const openRequests = requests || [];
  const noteDot = note?.tone === 'ok' ? 'bg-emerald-500 dark:bg-emerald-400' : note?.tone === 'error' ? 'bg-red-500 dark:bg-red-400' : 'bg-muted-foreground/50';
  const handover = data ? `${handoverDayName(data.handoverDay)} at ${handoverTimeLabel(data.handoverTime)}` : '';

  let body;
  if (!data && error) {
    body = (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-foreground">
        <span className="h-2 w-2 shrink-0 rounded-full bg-red-500 dark:bg-red-400" aria-hidden="true" />
        <span>{error}</span>
        <button type="button" onClick={loadSchedule} className="tp-focus-ring rounded px-1 text-sm font-semibold text-primary hover:underline">Try again</button>
      </div>
    );
  } else if (!data) {
    body = <Skeleton />;
  } else {
    body = (
      <div className="space-y-9">
        {(openRequests.length > 0 || note || (wantedId && requests && !wantedPresent)) && (
          <section aria-labelledby="on-call-requests">
            <SectionHeading id="on-call-requests">Cover requests for you</SectionHeading>
            {note && (
              <p role={note.tone === 'error' ? 'alert' : 'status'} className="mb-3 flex items-start gap-2 text-sm text-foreground" data-testid="cover-note">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${noteDot}`} aria-hidden="true" />
                <span>{note.text}</span>
              </p>
            )}
            {!note && wantedId && requests && !wantedPresent && (
              <p role="status" className="mb-3 text-sm text-muted-foreground" data-testid="cover-request-gone">
                That request is no longer open. Somebody may have taken it already.
              </p>
            )}
            {openRequests.length > 0 && (
              <ul className="space-y-3">
                {openRequests.map((request) => {
                  const highlighted = sameId(request.id, wantedId);
                  return (
                    <CoverRequestRow
                      key={request.id}
                      request={request}
                      person={request.original?.id != null ? people[request.original.id] : null}
                      timeZone={timeZone}
                      highlighted={highlighted}
                      rowRef={highlighted ? wantedRef : undefined}
                      busy={busyId === request.id}
                      onTake={() => { setNote(null); setConfirming(request); }}
                      onDecline={() => answer(request, 'decline')}
                    />
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {!hasRotation ? (
          <EmptyState
            icon={CalendarClock}
            title="No on-call rotation yet"
            action={data.me?.canManage ? <Link to="/settings#urgent-response" className="tp-focus-ring rounded text-sm font-semibold text-primary hover:underline">Set up the rotation</Link> : null}
          >
            When a workspace admin sets one up, the schedule shows here.
          </EmptyState>
        ) : (
          <>
            <OnCallHero data={data} people={people} hues={hues} now={now} timeZone={timeZone} myId={myId} today={today} onDownloadMine={() => download(true)} />
            {fileNote && <p role="status" className="-mt-5 text-xs text-muted-foreground" data-testid="on-call-file-note">{fileNote}</p>}

            <section aria-labelledby="on-call-weeks">
              <SectionHeading
                id="on-call-weeks"
                hint={view === 'calendar' ? 'Each day takes the colour of whoever has the phone that night.' : 'Pick a week on the strip to find it in the list.'}
                action={(
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" onClick={() => download(false)} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      Calendar file
                    </button>
                    <ViewSwitch view={view} onChange={changeView} />
                  </div>
                )}
              >
                Next {weeks.length || 12} weeks
              </SectionHeading>
              {weeks.length > 0 && (
                <div className="mb-4">
                  <OnCallRibbon
                    weeks={weeks}
                    people={people}
                    hues={hues}
                    now={now}
                    timeZone={timeZone}
                    myId={myId}
                    selectedIndex={view === 'weeks' ? picked.index : null}
                    onSelect={(index) => { if (view !== 'weeks') changeView('weeks'); setPicked({ index, at: Date.now() }); }}
                  />
                </div>
              )}
              {view === 'calendar' && days.length > 0 ? (
                <OnCallCalendar days={days} people={people} hues={hues} myId={myId} today={today} handoverTime={data.handoverTime} />
              ) : (
                <OnCallWeekList weeks={weeks} holidays={holidays} people={people} hues={hues} timeZone={timeZone} myId={myId} selectedIndex={picked.index} selectedAt={picked.at} />
              )}
            </section>

            {order.length > 0 && (
              <section aria-labelledby="on-call-rotation">
                <SectionHeading id="on-call-rotation" hint={`${order.length} ${order.length === 1 ? 'person' : 'people'}, one week each, in this order.`}>
                  The rotation
                </SectionHeading>
                <OnCallRotation order={order} weeks={weeks} people={people} hues={hues} timeZone={timeZone} myId={myId} scheduledNowId={current?.scheduled?.id ?? null} />
              </section>
            )}

            <section aria-labelledby="on-call-how">
              <SectionHeading id="on-call-how">How it works</SectionHeading>
              <ul className="grid gap-x-8 gap-y-4 sm:grid-cols-3">
                {HOW.map(([Icon, title, text]) => (
                  <li key={title} className="flex items-start gap-3">
                    <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <span>
                      <span className="block text-sm font-medium text-foreground">{title}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                        {text || `Every ${handover}${timeZone ? `, ${timeZone.replace(/_/g, ' ').split('/').pop()} time` : ''}. A cover can take part of a week without changing the order.`}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="tp-tickets-backdrop min-h-screen md:pl-[var(--tp-rail-w,58px)]">
      <AppHeader activePage="oncall" />
      <main className="mx-auto max-w-5xl px-4 py-6 pb-24 animate-fadeIn sm:px-6 lg:pb-8">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div>
            <h1 className="text-lg font-semibold text-foreground">On-call</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              One person covers after-hours urgent tickets each week.
              {data ? ` Handover is ${handover}${timeZone ? ` (${timeZone.replace(/_/g, ' ')})` : ''}.` : ''}
            </p>
          </div>
          {data?.me?.canManage && hasRotation && (
            <Link to="/settings#urgent-response" className="tp-focus-ring inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted">
              <Settings2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              Change the rotation
            </Link>
          )}
        </div>
        {body}
      </main>
      <TakeCoverDialog
        request={confirming}
        timeZone={timeZone}
        onConfirm={() => { if (confirming && busyId == null) answer(confirming, 'accept'); }}
        onCancel={() => { if (busyId == null) setConfirming(null); }}
      />
      <MobileTabBar />
    </div>
  );
}
