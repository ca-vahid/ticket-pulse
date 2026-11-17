import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Activity, Bell, Check, Clock3, Loader2 } from 'lucide-react';
import { publicTicketEscalationAPI } from '../services/api';

/*
 * After-hours "urgent help" page (/ticket-escalation/:token), opened from the
 * after-hours acknowledgement e-mail. QA 11-16 redesign "E": a night banner, one
 * white panel asking "Is this high priority?", and the support hours as a plain
 * table. Public page: light only (.tp-light), self-contained, and it names nobody.
 */

const SKYLINE = '/brand/urgent/night-skyline.jpg';
const ICON_TONIGHT = '/brand/urgent/icon-tonight-256.png';
const ICON_CAN_WAIT = '/brand/urgent/icon-can-wait-256.png';

const DEFAULT_EXPECT = {
  businessHours: 'We answer tickets as they come in.',
  afterHours: 'For high-priority issues. We reply within about 2 hours.',
  lateNight: "We'll still try, but it can take longer than 2 hours.",
};

const HOURS_ROWS = [
  { key: 'business', field: 'businessHours', label: 'In the office' },
  { key: 'after_hours', field: 'afterHours', label: 'After-hours support' },
  { key: 'late_night', field: 'lateNight', label: 'Late night' },
];

function unwrap(response) {
  return response?.data ?? response ?? null;
}

function greetingFor(hour) {
  if (!Number.isFinite(hour)) return 'Hello';
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  return 'Good evening';
}

// ── Hours table: built from the policy's response table (Settings drives it) ──

const TIME_TOKEN = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/gi;

function isEmptyCell(text) {
  const value = String(text || '').trim();
  return !value || /^n\/?a$/i.test(value);
}

/** "5pm - 10pm PT" → "5 PM – 10 PM" (the page already says all times are Pacific). */
function tidyTimes(text) {
  return String(text || '')
    .replace(/\s*\b(?:PT|PST|PDT)\b\.?/gi, '')
    .replace(TIME_TOKEN, (_m, h, mm, period) => {
      const p = period.toLowerCase().startsWith('a') ? 'AM' : 'PM';
      return `${Number(h)}${mm && mm !== '00' ? `:${mm}` : ''} ${p}`;
    })
    .replace(/\s+(?:-|–|—|to)\s+/gi, ' – ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function firstTime(text) {
  const match = new RegExp(TIME_TOKEN.source, 'i').exec(String(text || ''));
  return match ? tidyTimes(match[0]) : null;
}

/** One table cell. "After 10pm" late night reads as "10 PM – 5 AM" (until we open). */
function cellText(row, field) {
  const raw = row?.[field];
  if (isEmptyCell(raw)) return field === 'businessHours' ? 'Closed' : '—';
  if (field === 'lateNight') {
    const after = /^\s*after\s+(.+)$/i.exec(String(raw));
    const until = firstTime(isEmptyCell(row.businessHours) ? row.afterHours : row.businessHours);
    if (after && until) return `${tidyTimes(after[1])} – ${until}`;
  }
  return tidyTimes(raw);
}

function joinLabels(labels) {
  const lower = (text, index) => (index === 0 ? text : text.charAt(0).toLowerCase() + text.slice(1));
  const parts = labels.map(lower);
  if (parts.length < 2) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Day groups (columns): rows with the same hours merge, "Weekends" + "Holidays". */
function dayGroups(responseTable) {
  const groups = [];
  for (const row of responseTable?.rows || []) {
    const key = HOURS_ROWS.map(({ field }) => String(row?.[field] || '').trim().toLowerCase()).join('|');
    const existing = groups.find((group) => group.key === key);
    if (existing) existing.labels.push(row.label);
    else groups.push({ key, labels: [row.label], row });
  }
  return groups.map((group) => ({ ...group, label: joinLabels(group.labels) }));
}

function shortDayLabel(label, index) {
  const text = /^monday to friday$/i.test(label) ? 'Mon–Fri' : label;
  return index === 0 ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

/** Phone line: "Mon–Fri 5 AM – 5 PM · closed weekends and holidays". */
function phoneLine(groups, field) {
  return groups
    .map((group, index) => {
      const value = cellText(group.row, field);
      const label = shortDayLabel(group.label, index);
      if (value === 'Closed') return `closed ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
      return `${label} ${value}`;
    })
    .join(' · ');
}

function HoursSection({ afterHours }) {
  const groups = dayGroups(afterHours?.responseTable);
  if (groups.length === 0) return null;
  const phase = afterHours?.phase || null;
  const expect = { ...DEFAULT_EXPECT, ...(afterHours?.expect || {}) };

  return (
    <section aria-labelledby="tp-hours-heading" className="mx-auto flex max-w-[1120px] flex-col gap-[22px] px-[22px] pt-11 md:gap-7 md:px-10 md:pt-16">
      <div className="flex flex-col gap-1.5 md:gap-2">
        <h2 id="tp-hours-heading" className="m-0 text-xl font-bold md:text-2xl">When you can reach us</h2>
        <p className="m-0 text-sm text-[#475569] md:text-[15px]">All times are Pacific.</p>
      </div>

      {/* Desktop and tablet: a plain table. */}
      <table className="hidden w-full border-collapse text-[15px] leading-normal md:table">
        <thead>
          <tr>
            <th scope="col" className="w-[26%] border-b-2 border-[#0f172a] pb-3 pl-3.5 pr-4 text-left text-[13px] font-semibold text-[#475569]">Support</th>
            {groups.map((group) => (
              <th key={group.key} scope="col" className="w-[19%] border-b-2 border-[#0f172a] pb-3 pr-4 text-left text-[13px] font-semibold text-[#475569]">
                {group.label}
              </th>
            ))}
            <th scope="col" className="border-b-2 border-[#0f172a] pb-3 pr-3.5 text-left text-[13px] font-semibold text-[#475569]">What to expect</th>
          </tr>
        </thead>
        <tbody>
          {HOURS_ROWS.map((hoursRow) => {
            const now = phase === hoursRow.key;
            return (
              <tr key={hoursRow.key} className={now ? 'bg-[#fff4df]' : undefined} aria-current={now ? 'true' : undefined}>
                <th scope="row" className="border-b border-[#dfe3ec] py-[18px] pl-3.5 pr-4 text-left font-semibold">
                  {hoursRow.label}
                  {now && <span className="block text-[13px] font-bold text-[#9a4a06]">Right now</span>}
                </th>
                {groups.map((group) => {
                  const value = cellText(group.row, hoursRow.field);
                  const muted = value === 'Closed' || value === '—';
                  return (
                    <td key={group.key} className={`border-b border-[#dfe3ec] py-[18px] pr-4 ${muted ? 'text-[#475569]' : ''}`}>
                      {value}
                    </td>
                  );
                })}
                <td className="border-b border-[#dfe3ec] py-[18px] pr-3.5 text-[#334155]">{expect[hoursRow.field]}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Phone: stacked rows. */}
      <ul className="m-0 flex list-none flex-col border-t-2 border-[#0f172a] p-0 md:hidden">
        {HOURS_ROWS.map((hoursRow) => {
          const now = phase === hoursRow.key;
          return (
            <li
              key={hoursRow.key}
              className={`flex flex-col gap-1 border-b border-[#dfe3ec] px-3 py-3.5 ${now ? 'bg-[#fff4df]' : ''}`}
              aria-current={now ? 'true' : undefined}
            >
              <span className="text-base font-semibold">
                {hoursRow.label}
                {now && <span className="text-[13px] font-bold text-[#9a4a06]"> · right now</span>}
              </span>
              <span className="text-sm">{phoneLine(groups, hoursRow.field)}</span>
              <span className="text-sm text-[#475569]">{expect[hoursRow.field]}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── Panel states ──

function TicketLine({ ticket, className = '' }) {
  const ref = ticket?.ref;
  const parts = [ref, ticket?.subject, 'in our queue'].filter(Boolean);
  return <p className={`m-0 text-[13px] text-[#475569] md:text-[15px] ${className}`}>{parts.join(' · ')}</p>;
}

function waitLabel(nextShort, localHour) {
  if (!nextShort) return "It can wait until we're back";
  const weekday = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/.exec(nextShort);
  if (weekday) return `It can wait until ${weekday[1]}`;
  if (/^\d/.test(nextShort) && /AM$/.test(nextShort)) return 'It can wait until morning';
  if (/^\d/.test(nextShort) && Number.isFinite(localHour) && localHour < 12) return 'It can wait until later today';
  return "It can wait until we're back";
}

function AskPanel({ data, submitting, onSubmit, onCanWait }) {
  const lateNight = data?.afterHours?.phase === 'late_night';
  const localHour = data?.afterHours?.localHour;
  const when = Number.isFinite(localHour) && localHour >= 5 && localHour < 17 ? 'today' : 'tonight';
  return (
    <div className="md:grid md:grid-cols-[88px_minmax(0,1fr)] md:items-start md:gap-x-7">
      <img src={ICON_TONIGHT} alt="" className="hidden h-[88px] w-[88px] md:block" />
      <div className="flex flex-col gap-3.5">
        <div className="order-1 flex items-center gap-3 md:order-2">
          <img src={ICON_TONIGHT} alt="" className="h-12 w-12 flex-none md:hidden" />
          <h2 className="m-0 text-[22px] font-bold leading-tight md:text-[28px]">Is this high priority?</h2>
        </div>
        <TicketLine ticket={data?.ticket} className="order-2 md:order-1" />
        <p className="order-3 m-0 max-w-[720px] text-[15px] leading-relaxed text-[#334155] md:text-base">
          Most things can wait for the morning, and that&apos;s completely fine.
          <span className="hidden md:inline"> We&apos;ll be on it first thing.</span>
          {lateNight
            ? ` If it's stopping your work ${when}, our after-hours support can still help, though at this hour it can take longer than 2 hours.`
            : ` If it's stopping your work ${when}, our after-hours support can help; they usually reply within about 2 hours.`}
        </p>
        <div className="order-4 mt-1 flex flex-col gap-3 md:mt-0 md:flex-row md:flex-wrap md:items-center md:gap-4 md:pt-2">
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitting}
            aria-busy={submitting || undefined}
            className="tp-focus-ring inline-flex h-[58px] items-center justify-center gap-2.5 rounded-[14px] border-0 bg-[#dc2626] px-4 text-[17px] font-bold text-white shadow-[0_4px_0_#8f1414,0_10px_24px_rgba(185,28,28,0.28)] transition-[transform,box-shadow,background-color] duration-75 ease-out hover:bg-[#c81e1e] active:translate-y-[3px] active:shadow-[0_1px_0_#8f1414,0_4px_10px_rgba(185,28,28,0.25)] disabled:cursor-wait disabled:opacity-80 motion-reduce:transition-none motion-reduce:active:translate-y-0 md:gap-3 md:px-7 md:text-lg"
          >
            {submitting
              ? <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              : <Bell className="h-5 w-5 md:h-[22px] md:w-[22px]" strokeWidth={2.2} aria-hidden="true" />}
            {submitting ? 'Contacting after-hours support…' : 'Contact after-hours support'}
          </button>
          <button
            type="button"
            onClick={onCanWait}
            disabled={submitting}
            className="tp-focus-ring h-[54px] rounded-[14px] border border-[#b6bfcf] bg-white px-6 text-base font-semibold text-[#0f172a] hover:bg-[#f7f8fb] disabled:opacity-60 md:h-[58px] md:text-[17px]"
          >
            {waitLabel(data?.afterHours?.nextBusinessShort, localHour)}
          </button>
        </div>
      </div>
    </div>
  );
}

function CanWaitPanel({ data, onBack }) {
  return (
    <div className="flex flex-col gap-3.5 md:grid md:grid-cols-[88px_minmax(0,1fr)] md:items-start md:gap-x-7">
      <img src={ICON_CAN_WAIT} alt="" className="h-12 w-12 md:h-[88px] md:w-[88px]" />
      <div className="flex flex-col gap-3.5" role="status">
        <TicketLine ticket={data?.ticket} />
        <h2 className="m-0 text-[22px] font-bold leading-tight md:text-[28px]">Thanks — we&apos;ll pick it up first thing.</h2>
        <p className="m-0 text-[15px] leading-relaxed text-[#334155] md:text-base">You can close this page.</p>
        <p className="m-0 text-sm text-[#475569]">
          Changed your mind?{' '}
          <button type="button" onClick={onBack} className="tp-focus-ring rounded font-semibold text-[#1d4ed8] underline-offset-2 hover:text-[#1e3a8a] hover:underline">
            Contact after-hours support
          </button>
        </p>
      </div>
    </div>
  );
}

const STEPS = [
  { title: 'Support alerted' },
  { title: 'They look at your ticket', body: "They'll read what you sent and may call or e-mail you." },
  { title: 'You hear back', body: 'The reply comes to your ticket e-mail, like any other.' },
];

function SentPanel({ data }) {
  const sentAt = data?.escalation?.sentAtLocal || null;
  const lateNight = data?.afterHours?.phase === 'late_night';
  const ref = data?.ticket?.ref;
  const unreached = data?.status === 'submitted' && data?.notificationSummary && Number(data.notificationSummary.queued) === 0;

  if (unreached) {
    return (
      <div className="flex flex-col gap-3.5" role="status">
        <TicketLine ticket={data?.ticket} />
        <h2 className="m-0 text-[22px] font-bold leading-tight md:text-[28px]">We marked your ticket urgent</h2>
        <p className="m-0 max-w-[760px] text-[15px] leading-relaxed text-[#334155] md:text-base">
          We couldn&apos;t reach after-hours support just now, so it&apos;s at the top of our queue for first thing. If anything changes, reply to your ticket e-mail.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8 md:gap-10">
      <div className="flex flex-col gap-3.5" role="status">
        <TicketLine ticket={data?.ticket} />
        <div className="flex items-center gap-3 md:gap-3.5">
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-[#16a34a] md:h-10 md:w-10" aria-hidden="true">
            <Check className="h-5 w-5 text-white" strokeWidth={3} />
          </span>
          <h2 className="m-0 text-[22px] font-bold leading-tight md:text-[28px]">After-hours support has your request</h2>
        </div>
        <p className="m-0 max-w-[760px] text-[15px] leading-relaxed text-[#334155] md:text-[17px]">
          {sentAt ? `We alerted them at ${sentAt}. ` : 'We alerted them. '}
          {lateNight
            ? 'They usually reply within about 2 hours, but at this hour it can take longer. '
            : 'They usually reply within about 2 hours. '}
          You don&apos;t need to do anything else.
        </p>
      </div>

      <div className="flex flex-col gap-5">
        <h3 className="m-0 text-lg font-bold md:text-[22px]">What happens next</h3>
        <div className="relative">
          {/* Track: vertical on phones, horizontal from md. */}
          <span aria-hidden="true" className="absolute left-[14px] right-[33%] top-[14px] hidden h-0.5 bg-[#dfe3ec] md:block" />
          <span aria-hidden="true" className="absolute left-[14px] top-[14px] hidden h-0.5 w-[16%] bg-[#0b2a6f] md:block" />
          <ol className="relative m-0 grid list-none gap-6 p-0 md:grid-cols-3 md:gap-x-8 md:gap-y-0">
            {STEPS.map((step, index) => (
              <li key={step.title} className="relative flex gap-3.5 md:flex-col md:gap-2.5">
                {index < STEPS.length - 1 && (
                  <span aria-hidden="true" className={`absolute -bottom-6 left-[14px] top-[30px] w-0.5 md:hidden ${index === 0 ? 'bg-[#0b2a6f]' : 'bg-[#dfe3ec]'}`} />
                )}
                {index === 0 ? (
                  <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full bg-[#0b2a6f]" aria-hidden="true">
                    <Check className="h-4 w-4 text-white" strokeWidth={3} />
                  </span>
                ) : (
                  <span
                    className={`h-[30px] w-[30px] flex-none rounded-full bg-white ${index === 1 ? 'shadow-[inset_0_0_0_2px_#0b2a6f]' : 'shadow-[inset_0_0_0_2px_#b6bfcf]'}`}
                    aria-hidden="true"
                  />
                )}
                <div className="flex flex-col gap-1 md:gap-2.5">
                  <span className="text-base font-semibold">{step.title}</span>
                  <span className="text-sm leading-normal text-[#475569]">
                    {index === 0
                      ? [sentAt ? `${sentAt}.` : null, ref ? `${ref} is now marked Urgent.` : 'Your ticket is now marked Urgent.'].filter(Boolean).join(' ')
                      : step.body}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

function unavailableCopy(reasons = []) {
  if (reasons.includes('not_after_hours')) {
    return {
      title: "We're in the office right now",
      body: 'Your ticket is in our queue and we answer tickets as they come in, so there is no need for after-hours support.',
    };
  }
  if (reasons.includes('self_service_disabled')) {
    return {
      title: "After-hours support isn't available from this page",
      body: "Your ticket is in our queue, and we'll pick it up first thing when we're back.",
    };
  }
  return {
    title: "After-hours support isn't available right now",
    body: "Your ticket is in our queue, and we'll pick it up first thing when we're back.",
  };
}

function UnavailablePanel({ data }) {
  const copy = unavailableCopy(data?.reasons || []);
  const inOffice = (data?.reasons || []).includes('not_after_hours');
  return (
    <div className="flex flex-col gap-3.5 md:grid md:grid-cols-[88px_minmax(0,1fr)] md:items-start md:gap-x-7">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#eef2ff] md:h-[88px] md:w-[88px]" aria-hidden="true">
        <Clock3 className="h-6 w-6 text-[#0b2a6f] md:h-10 md:w-10" />
      </span>
      <div className="flex flex-col gap-3.5">
        <TicketLine ticket={data?.ticket} />
        <h2 className="m-0 text-[22px] font-bold leading-tight md:text-[28px]">{copy.title}</h2>
        <p className="m-0 max-w-[720px] text-[15px] leading-relaxed text-[#334155] md:text-base">{copy.body}</p>
        {inOffice && data?.ticket?.raiseUrgencyUrl && (
          <p className="m-0 text-sm text-[#475569]">
            Need it sooner?{' '}
            <a href={data.ticket.raiseUrgencyUrl} className="tp-focus-ring rounded font-semibold text-[#1d4ed8] hover:text-[#1e3a8a]">
              Tell us it&apos;s urgent
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

// ── Page ──

function Banner({ data }) {
  const brand = data?.branding?.brandName || data?.workspace?.name || 'Ticket Pulse';
  const afterHours = data?.afterHours || {};
  const inOffice = afterHours.phase === 'business' || afterHours.availability?.isBusinessHours === true;
  const until = afterHours.nextBusinessShort || afterHours.availability?.nextBusinessTimeLocal || null;
  let headline = "We're out of the office right now";
  if (!data) headline = 'After-hours support';
  else if (inOffice) headline = "We're in the office now";
  else if (until) headline = `We're out of the office until ${until}`;

  return (
    <header className="relative h-[190px] overflow-hidden bg-[#0b2a6f] md:h-[250px]">
      <img
        src={SKYLINE}
        alt="A quiet night skyline with mountains, city lights and a crescent moon"
        className="absolute inset-0 h-full w-full object-cover object-[72%_80%] md:object-[center_78%]"
      />
      <div className="relative mx-auto flex max-w-[1120px] flex-col gap-[18px] px-5 pt-3.5 md:gap-9 md:px-10 md:pt-7">
        <div className="flex items-center gap-2 md:gap-3">
          {data?.branding?.logoDataUrl && (
            <span className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-white p-0.5 md:h-10 md:rounded-lg md:w-10 md:p-1.5">
              <img src={data.branding.logoDataUrl} alt={data.branding.logoAltText || brand} className="max-h-full max-w-full object-contain" />
            </span>
          )}
          <span className="text-sm font-medium text-[#dbe4ff] md:text-base">{brand}</span>
        </div>
        <div className="flex flex-col gap-1 md:gap-1.5">
          {data && <p className="m-0 text-sm text-[#dbe4ff] md:text-base">{greetingFor(afterHours.localHour)}</p>}
          <h1 className="m-0 text-[26px] font-bold leading-[1.12] text-white md:text-[38px] md:leading-[1.1]">{headline}</h1>
        </div>
      </div>
    </header>
  );
}

export default function PublicTicketEscalation() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [canWait, setCanWait] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await publicTicketEscalationAPI.get(token);
        if (!cancelled) setData(unwrap(response));
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.message || err.message || 'This link is unavailable.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await publicTicketEscalationAPI.submit(token);
      setData(unwrap(response));
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'We could not reach after-hours support. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const reasons = data?.reasons || [];
  const sent = Boolean(data) && (
    data.status === 'submitted'
    || data.status === 'already_escalated'
    || data.status === 'cooldown'
    || data.alreadyEscalated === true
    || reasons.includes('cooldown_active')
  );
  const available = Boolean(data?.available) && !sent;

  let panel;
  if (loading && !data) {
    panel = (
      <div className="flex items-center gap-3 text-[#475569]" role="status">
        <Activity className="h-5 w-5 animate-spin text-[#1d4ed8] motion-reduce:animate-none" aria-hidden="true" />
        Loading your ticket…
      </div>
    );
  } else if (!data) {
    panel = (
      <div className="flex flex-col gap-3" role="alert">
        <h2 className="m-0 text-[22px] font-bold md:text-[28px]">This link isn&apos;t working</h2>
        <p className="m-0 text-[15px] leading-relaxed text-[#334155] md:text-base">
          {error || 'This link is unavailable.'} Reply to your ticket e-mail and we&apos;ll pick it up.
        </p>
      </div>
    );
  } else if (sent) {
    panel = <SentPanel data={data} />;
  } else if (available && canWait) {
    panel = <CanWaitPanel data={data} onBack={() => setCanWait(false)} />;
  } else if (available) {
    panel = <AskPanel data={data} submitting={submitting} onSubmit={submit} onCanWait={() => setCanWait(true)} />;
  } else {
    panel = <UnavailablePanel data={data} />;
  }

  const fixedItself = sent
    ? 'Fixed itself after all? Reply "all good" to your ticket e-mail so support can stand down.'
    : 'Something changed, or it fixed itself? Reply to your ticket e-mail at any time.';

  return (
    <div className="tp-light min-h-screen bg-[#f7f8fb] text-[#0f172a]">
      <Banner data={data} />

      <main>
        <div className="relative mx-auto -mt-7 max-w-[1120px] px-3.5 md:-mt-11 md:px-10">
          <div className="rounded-[18px] bg-white px-5 py-6 shadow-[0_14px_40px_rgba(11,42,111,0.14)] md:rounded-[20px] md:px-11 md:py-9 md:shadow-[0_18px_50px_rgba(11,42,111,0.14)]">
            {panel}
            {data && error && (
              <p role="alert" className="m-0 mt-4 rounded-lg bg-[#fef2f2] px-4 py-3 text-sm font-semibold text-[#991b1b]">
                {error}
              </p>
            )}
          </div>
        </div>

        {data && !sent && <HoursSection afterHours={data.afterHours} />}
      </main>

      {data && (
        <footer className="mx-auto flex max-w-[1120px] flex-col gap-2.5 px-[22px] pb-9 pt-10 text-sm text-[#475569] md:flex-row md:flex-wrap md:justify-between md:gap-4 md:px-10 md:pb-12 md:pt-14">
          <span>{fixedItself}</span>
          {data.ticket?.publicStatusUrl && (
            <a href={data.ticket.publicStatusUrl} className="tp-focus-ring rounded text-[#1d4ed8] hover:text-[#1e3a8a]">
              View your ticket
            </a>
          )}
        </footer>
      )}
    </div>
  );
}
