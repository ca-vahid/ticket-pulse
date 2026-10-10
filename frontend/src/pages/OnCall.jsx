import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import AppHeader from '../components/AppHeader';
import MobileTabBar from '../components/nav/MobileTabBar';
import { urgentResponseAPI } from '../services/api';
import { EmptyState, Loading } from '../components/knowledge/knowledgeUi';
import { Person } from '../components/onboarding/onboardingUi';
import { Button } from '../components/ui';
import { COVER_CHANGED_EVENT, TakeCoverDialog, answerCoverRequest } from '../components/onCall/coverRequests';
import {
  coverCommitment, formatOnCallMoment, formatOnCallRange, handoverDayName, handoverTimeLabel,
} from '../utils/onCallFormat';

/**
 * On-call (plans/URGENT_RESPONSE_PLAN.md) — open to every signed-in member,
 * agents included. Read-only: who is on call now, the next eight weeks, and
 * the cover requests waiting for the signed-in person. Admins change the
 * rotation in Settings; this page is where everybody else looks it up.
 *
 *   /on-call?request=<id>   scrolls to that cover request and marks it
 */

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

function SectionHeading({ id, children }) {
  return <h2 id={id} className="mb-2 text-[13px] font-semibold text-foreground">{children}</h2>;
}

function AmberWord({ children }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-amber-700 dark:text-amber-300">
      <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400" aria-hidden="true" />
      {children}
    </span>
  );
}

function CoverRequestRow({ request, timeZone, highlighted, busy, onTake, onDecline, rowRef }) {
  const who = request.original?.name || 'A colleague';
  return (
    <li
      ref={rowRef}
      data-testid={`cover-request-${request.id}`}
      data-highlighted={highlighted ? 'true' : undefined}
      className={`rounded-lg border bg-card p-4 transition-shadow ${highlighted ? 'border-primary ring-2 ring-primary/30' : 'border-border'}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <Person name={who} size="h-8 w-8" sub="needs on-call cover" />
          <p className="mt-2 text-sm text-foreground">
            {formatOnCallMoment(request.startsAt, timeZone)} to {formatOnCallMoment(request.endsAt, timeZone)}
          </p>
          {request.message && <p className="mt-1 whitespace-pre-line break-words text-sm leading-relaxed text-muted-foreground">{request.message}</p>}
          {request.createdBy && <p className="mt-1 text-xs text-muted-foreground">Asked by {request.createdBy}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={onTake} className="tp-focus-ring" aria-label={`Take it: cover for ${who}`}>Take it</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onDecline} className="tp-focus-ring" aria-label={`Not this time: cover for ${who}`}>Not this time</Button>
        </div>
      </div>
    </li>
  );
}

function WeekRow({ week, timeZone, myId }) {
  const mine = sameId(week.scheduled?.id, myId);
  const covers = Array.isArray(week.covers) ? week.covers : [];
  const open = week.openRequest && week.openRequest.status === 'open' ? week.openRequest : null;
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-1.5 py-3" data-testid={`on-call-week-${week.index}`}>
      <span className="w-full text-sm tabular-nums text-muted-foreground sm:w-48 sm:flex-none sm:pt-0.5">
        {formatOnCallRange(week.startsAt, week.endsAt, timeZone)}
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <Person name={week.scheduled?.name || 'Nobody yet'} />
        {covers.map((cover) => (
          <p key={cover.id} className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {sameId(cover.technician?.id, myId) ? 'You cover' : `${cover.technician?.name || 'Someone'} covers`}
            {' '}{formatOnCallMoment(cover.startsAt, timeZone)} to {formatOnCallMoment(cover.endsAt, timeZone)}
            {cover.note ? ` · ${cover.note}` : ''}
          </p>
        ))}
      </div>
      <div className="flex flex-col items-start gap-1 sm:items-end">
        {mine && <span className="text-xs font-semibold text-foreground">Your week</span>}
        {week.needsCover && <AmberWord>Needs cover</AmberWord>}
        {week.needsCover && open && (
          <span className="text-xs text-muted-foreground">
            Asked {open.askedCount} {open.askedCount === 1 ? 'person' : 'people'}{open.declinedCount ? ` · ${open.declinedCount} declined` : ''}
          </span>
        )}
      </div>
    </li>
  );
}

export default function OnCall() {
  const [searchParams] = useSearchParams();
  const wantedId = searchParams.get('request');
  const [data, setData] = useState(null);
  const [requests, setRequests] = useState(null);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [note, setNote] = useState(null); // { tone: 'ok' | 'info' | 'error', text }
  const wantedRef = useRef(null);
  const scrolledFor = useRef(null);

  const loadSchedule = useCallback(() => {
    urgentResponseAPI.getOnCall()
      .then((res) => { setData(res?.data || {}); setError(null); })
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

  // ?request=<id>: bring that request into view once it is on the page.
  const wantedPresent = Boolean(wantedId && (requests || []).some((r) => sameId(r.id, wantedId)));
  useEffect(() => {
    if (!wantedPresent || scrolledFor.current === wantedId) return;
    scrolledFor.current = wantedId;
    const el = wantedRef.current;
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
  }, [wantedPresent, wantedId]);

  const timeZone = data?.timezone || undefined;
  const myId = data?.me?.technicianId ?? null;

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

  const weeks = Array.isArray(data?.weeks) ? data.weeks : [];
  const current = data?.current || null;
  const onCallNow = current?.technician || null;
  const hasRotation = Boolean(onCallNow || current?.scheduled || weeks.length);
  const covering = current?.cover && current?.scheduled && !sameId(current.scheduled.id, onCallNow?.id) ? current.scheduled : null;
  const openRequests = requests || [];
  const noteDot = note?.tone === 'ok' ? 'bg-emerald-500 dark:bg-emerald-400' : note?.tone === 'error' ? 'bg-red-500 dark:bg-red-400' : 'bg-muted-foreground/50';

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
    body = <Loading label="Loading on-call…" />;
  } else {
    body = (
      <div className="space-y-8">
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
          <EmptyState icon={CalendarClock} title="No on-call rotation yet">
            When a workspace admin sets one up, the schedule shows here.
          </EmptyState>
        ) : (
          <>
            <section aria-labelledby="on-call-now">
              <SectionHeading id="on-call-now">On call now</SectionHeading>
              {onCallNow ? (
                <div data-testid="on-call-now">
                  <Person
                    name={onCallNow.name}
                    size="h-9 w-9"
                    sub={[
                      sameId(onCallNow.id, myId) ? 'That is you' : null,
                      current?.until ? `until ${formatOnCallMoment(current.until, timeZone)}` : null,
                    ].filter(Boolean).join(' · ') || null}
                  />
                  {covering && <p className="mt-1.5 text-sm text-muted-foreground">Covering for {covering.name}</p>}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Nobody is on call right now.
                  {current?.onLeaveNoCover && current?.scheduled?.name ? ` ${current.scheduled.name} is away and has no cover yet.` : ''}
                </p>
              )}
            </section>

            <section aria-labelledby="on-call-weeks">
              <SectionHeading id="on-call-weeks">Next {weeks.length || 8} weeks</SectionHeading>
              {weeks.length ? (
                <ul className="divide-y divide-border border-y border-border">
                  {weeks.map((week) => <WeekRow key={week.index ?? week.startsAt} week={week} timeZone={timeZone} myId={myId} />)}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No weeks are scheduled yet.</p>
              )}
            </section>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="tp-tickets-backdrop min-h-screen md:pl-[var(--tp-rail-w,58px)]">
      <AppHeader activePage="oncall" />
      <main className="mx-auto max-w-3xl px-4 py-6 pb-24 animate-fadeIn sm:px-6 lg:pb-6">
        <h1 className="text-lg font-semibold text-foreground">On-call</h1>
        <p className="mb-6 mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          One person covers after-hours urgent tickets each week.
          {data ? ` Handover is ${handoverDayName(data.handoverDay)} at ${handoverTimeLabel(data.handoverTime)}${timeZone ? ` (${timeZone.replace(/_/g, ' ')})` : ''}.` : ''}
        </p>
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
