import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Download, Loader2, RefreshCw } from 'lucide-react';
import MetricHint from './MetricHint';
import { analyticsAPI } from '../../services/api';
import { chartPalette } from '../../utils/highchartsTheme';
import { motionReduced } from '../../utils/motionPreference';

/**
 * Analytics → Automation Ops, first section: "How often the AI's pick stands"
 * (QA 10-13 item 16). Deterministic counts from the server
 * (GET /analytics/ai-pick-accuracy): no AI-written text, no ranking of people.
 *
 * Two readings, because "AI suggestion vs actual assignee" means two things:
 *   auto     the AI assigned the ticket: did that person keep it?
 *   suggest  the AI only suggested: was the person who did it on the AI's list?
 *
 * Props
 *   params      the page's analytics query (range, start/end, timezone, category filter)
 *   ChartBlock  the page's Highcharts wrapper ({ options, height }); without it the weeks render as a table
 *   isMobile    shorter chart
 *   palette     the page's theme-resolved chart palette (falls back to the current theme's)
 *   data        optional: a ready payload (tests, screenshots); skips the fetch
 *
 * Every rate shows its count; under `rules.minRateSample` tickets there is no
 * rate at all, only "n of N" and "not enough tickets yet".
 */

const fmt = (value) => Number(value || 0).toLocaleString();
const plural = (n, one, many) => `${fmt(n)} ${Number(n) === 1 ? one : many}`;

const COPY = {
  auto: {
    tab: 'The AI assigned',
    lead: 'Here the AI assigns the ticket itself. These numbers show how often the person it chose was the one who did the ticket, and how often a person changed the assignment.',
    figures: [
      { key: 'firstChoice', metric: 'aiPickFirstChoiceKept', label: 'First choice kept' },
      { key: 'inList', metric: 'aiPickInListAuto', label: "Done by someone on the AI's list" },
      { key: 'changed', metric: 'aiPickChangedByPerson', label: 'Changed by a person' },
    ],
    columns: ['First choice kept', 'In the list', 'Changed by a person'],
    overridesTitle: "Recent tickets where a person changed the AI's assignment",
    overridesEmpty: "Nobody changed the AI's assignment in this period.",
  },
  suggest: {
    tab: 'The AI only suggested',
    lead: 'Here the AI suggests and a person takes or assigns the ticket. These numbers compare the AI’s list with the person who did the ticket.',
    figures: [
      { key: 'firstChoice', metric: 'aiPickFirstChoiceTook', label: "Done by the AI's first choice" },
      { key: 'inList', metric: 'aiPickInListSuggest', label: "Done by someone on the AI's list" },
      { key: 'changed', metric: 'aiPickOffList', label: 'Done by someone not on the list' },
    ],
    columns: ['First choice did it', 'In the list', 'Not on the list'],
    overridesTitle: "Recent tickets not done by the AI's first choice",
    overridesEmpty: "Every ticket in this period was done by the AI's first choice.",
  },
};

const SERIES = {
  auto: ['First choice kept', 'In the list', 'Changed by a person'],
  suggest: ['First choice did it', 'In the list', 'Not on the list'],
};

function weekLabel(week) {
  const date = new Date(`${week}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return week;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function dayLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function afterText(minutes) {
  if (minutes === null || minutes === undefined) return '';
  if (minutes < 1) return ' within a minute';
  if (minutes < 60) return ` after ${minutes} min`;
  if (minutes < 48 * 60) return ` after ${Math.round(minutes / 60)} h`;
  return ` after ${Math.round(minutes / 1440)} days`;
}

/** Plain words for how a person came to change, or take, the ticket. */
export function overrideHowText(row) {
  const by = row.by ? ` by ${row.by}` : '';
  let text;
  switch (row.how) {
  case 'handed_back': text = `Handed back${by}${afterText(row.minutes)}`; break;
  case 'moved_by_other': text = `Moved${by}${afterText(row.minutes)}`; break;
  case 'changed_in_review': text = 'Changed in the review queue'; break;
  case 'picked_up': text = 'Picked it up'; break;
  case 'assigned_by': text = `Assigned${by}`; break;
  default: text = 'How is not recorded';
  }
  return row.rebounded ? `${text}, then back to the AI for another pick` : text;
}

/** Weekly trend chart options. Colours come from the theme palette, never hardcoded. */
export function buildPickTrendOptions(weeks = [], mode = 'auto', palette = {}) {
  const names = SERIES[mode] || SERIES.auto;
  const animate = !motionReduced();
  const point = (rateObj) => ({ y: rateObj?.pct ?? null, n: rateObj?.n ?? 0, of: rateObj?.of ?? 0 });
  const line = (name, key, color, dashStyle) => ({
    type: 'line',
    name,
    color,
    dashStyle,
    data: weeks.map((week) => point(week[key])),
    tooltip: { pointFormat: '<span style="color:{point.color}">●</span> {series.name}: <b>{point.y}%</b> ({point.n} of {point.of})<br/>' },
  });
  return {
    // alignTicks off: the ticket-count axis must not stretch the percentage axis past 100.
    chart: { backgroundColor: 'transparent', spacing: [8, 8, 8, 8], animation: animate, alignTicks: false },
    title: { text: null },
    credits: { enabled: false },
    accessibility: { enabled: true, description: 'Weekly share of tickets, with the number of tickets counted each week.' },
    xAxis: { categories: weeks.map((week) => weekLabel(week.week)), labels: { style: { fontSize: '11px' } } },
    yAxis: [
      { min: 0, max: 100, tickPositions: [0, 25, 50, 75, 100], title: { text: null }, labels: { format: '{value}%', style: { fontSize: '11px' } }, gridLineDashStyle: 'Dash' },
      { min: 0, title: { text: null }, labels: { style: { fontSize: '11px' } }, opposite: true, gridLineWidth: 0, allowDecimals: false },
    ],
    legend: { itemStyle: { fontSize: '12px' } },
    tooltip: { shared: true },
    plotOptions: {
      series: { animation: animate, connectNulls: false },
      line: { marker: { enabled: true, radius: 3 }, lineWidth: 2 },
      column: { borderRadius: 3 },
    },
    series: [
      {
        type: 'column',
        name: 'Tickets counted',
        yAxis: 1,
        color: palette.soft?.slate || palette.ash || palette.slate,
        data: weeks.map((week) => week.tickets || 0),
        tooltip: { pointFormat: '<span style="color:{point.color}">●</span> Tickets counted: <b>{point.y}</b><br/>' },
      },
      line(names[0], 'firstChoice', palette.blue),
      line(names[1], 'inList', palette.green, 'ShortDash'),
      line(names[2], 'changed', palette.amber),
    ],
  };
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // A subject is typed by a requester: never let a spreadsheet run it as a formula.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function rowsToCsv(rows = []) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return [headers.map(csvCell).join(','), ...rows.map((row) => headers.map((h) => csvCell(row[h])).join(','))].join('\r\n');
}

function Rate({ value, minSample }) {
  const count = `${fmt(value?.n)} of ${fmt(value?.of)}`;
  if (value?.pct === null || value?.pct === undefined) {
    return (
      <span className="tabular-nums text-foreground/85" title={`Not enough tickets yet for a rate (fewer than ${minSample}).`}>
        {count}
      </span>
    );
  }
  return (
    <span className="tabular-nums">
      <span className="font-semibold text-foreground">{value.pct}%</span>
      <span className="ml-1.5 text-xs text-muted-foreground">{count}</span>
    </span>
  );
}

function Figure({ label, metric, value, minSample }) {
  const enough = value?.pct !== null && value?.pct !== undefined;
  return (
    <div className="min-w-0 py-1 sm:px-5 sm:first:pl-0" data-testid={`ai-pick-figure-${metric}`}>
      <p className="flex items-center gap-1 text-[13px] font-medium text-muted-foreground">
        <span>{label}</span>
        <MetricHint metric={metric} title={label} />
      </p>
      {enough ? (
        <p className="mt-0.5 text-2xl font-bold tabular-nums text-foreground">{value.pct}%</p>
      ) : (
        <p className="mt-1 text-sm font-semibold text-foreground/85">Not enough tickets yet</p>
      )}
      <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
        {fmt(value?.n)} of {plural(value?.of, 'ticket', 'tickets')}
        {!enough && ` (a rate needs ${minSample})`}
      </p>
    </div>
  );
}

function Facts({ title, rows, note }) {
  return (
    <section aria-label={title} className="min-w-0">
      <h3 className="mb-1.5 text-[13px] font-semibold text-foreground">{title}</h3>
      <dl className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0 text-sm text-foreground/85">{row.label}</dt>
            <dd className="flex-none text-sm font-semibold tabular-nums text-foreground">{fmt(row.value)}</dd>
          </div>
        ))}
      </dl>
      {note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
    </section>
  );
}

function leftOutParts(counts) {
  const ex = counts?.excluded || {};
  return [
    [ex.onboarding, 'onboarding or offboarding (routed by rule, not by the AI)'],
    [ex.namedNobody, 'where the AI named nobody'],
    [ex.duplicates, 'copies closed into another ticket'],
    [ex.noise, 'noise'],
    [ex.removed, 'deleted or spam'],
    [ex.ownedBeforeAi, 'a person already had before the AI ran'],
  ].filter(([n]) => n > 0).map(([n, text]) => `${fmt(n)} ${text}`);
}

function notYetParts(notYet) {
  return [
    [notYet?.tooEarly, 'still open and with their owner for less than a day'],
    [notYet?.nobodyHasIt, 'open with nobody on them'],
    [notYet?.closedWithNoOwner, 'closed with nobody on them'],
  ].filter(([n]) => n > 0).map(([n, text]) => `${fmt(n)} ${text}`);
}

function ModeBody({ view, mode, rules, ChartBlock, isMobile, palette }) {
  const copy = COPY[mode];
  const minSample = rules?.minRateSample ?? 20;
  const [showSpread, setShowSpread] = useState(false);
  const trendOptions = useMemo(() => buildPickTrendOptions(view.weeks, mode, palette), [view.weeks, mode, palette]);
  const waiting = notYetParts(view.notYet);

  return (
    <div className="space-y-6" data-testid={`ai-pick-mode-${mode}`}>
      <p className="max-w-3xl text-sm text-muted-foreground">{copy.lead}</p>

      <div className="grid gap-y-3 sm:grid-cols-3 sm:divide-x sm:divide-border">
        {copy.figures.map((figure) => (
          <Figure key={figure.key} label={figure.label} metric={figure.metric} value={view[figure.key]} minSample={minSample} />
        ))}
      </div>
      {waiting.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="ai-pick-not-yet">
          Not counted yet: {waiting.join('; ')}.
        </p>
      )}

      <div className="grid gap-x-10 gap-y-5 sm:grid-cols-2">
        {mode === 'auto' ? (
          <>
            <Facts
              title="How a person changed it"
              rows={[
                { label: 'Handed back by the assignee', value: view.changes?.handedBack },
                { label: 'Moved or cleared by someone else', value: view.changes?.movedByOther },
                { label: 'Changed, how is not recorded', value: view.changes?.unknown },
              ]}
              note={view.changes?.movedByTicketPulse
                ? `${plural(view.changes.movedByTicketPulse, 'more ticket was', 'more tickets were')} moved by Ticket Pulse itself (a re-run or a rule). That is not a person's change and is not counted above.`
                : null}
            />
            <Facts
              title="How soon"
              rows={[
                { label: `Within ${rules?.quickChangeMinutes ?? 60} minutes`, value: view.changes?.withinHour },
                { label: 'Later', value: view.changes?.later },
                { label: 'Came back to the AI for another pick', value: view.changes?.rebounded },
              ]}
            />
          </>
        ) : (
          <>
            <Facts
              title={`In the review queue (${plural(view.review?.of, 'suggestion', 'suggestions')})`}
              rows={[
                { label: 'Approved as it was', value: view.review?.approvedAsIs },
                { label: 'Changed, then approved', value: view.review?.changedInReview },
                { label: 'Rejected', value: view.review?.rejected },
                { label: 'Not answered: the ticket was taken directly', value: view.review?.notAnswered },
              ]}
            />
            <Facts
              title="How the person came to have it"
              rows={[
                { label: 'Picked it up themselves', value: view.taken?.pickedUp },
                { label: 'Assigned by someone else', value: view.taken?.assignedBy },
                { label: 'Not recorded', value: view.taken?.unknown },
              ]}
            />
          </>
        )}
      </div>

      <section aria-label="By category">
        <h3 className="mb-2 text-[13px] font-semibold text-foreground">By category</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm" data-testid="ai-pick-categories">
            <thead>
              <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                <th scope="col" className="py-2 pr-4 font-medium">Category</th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">Tickets</th>
                {copy.columns.map((column) => (
                  <th key={column} scope="col" className="whitespace-nowrap py-2 pr-4 font-medium">{column}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {view.categories.map((row) => (
                <tr key={row.name}>
                  <th scope="row" className="py-2 pr-4 text-left font-normal text-foreground">{row.name}</th>
                  <td className="py-2 pr-4 text-right tabular-nums text-foreground/85">{fmt(row.tickets)}</td>
                  <td className="whitespace-nowrap py-2 pr-4"><Rate value={row.firstChoice} minSample={minSample} /></td>
                  <td className="whitespace-nowrap py-2 pr-4"><Rate value={row.inList} minSample={minSample} /></td>
                  <td className="whitespace-nowrap py-2 pr-4"><Rate value={row.changed} minSample={minSample} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Largest category first. A percentage appears from {minSample} tickets; below that only the count is shown.
        </p>
      </section>

      <section aria-label="Week by week">
        <h3 className="mb-2 text-[13px] font-semibold text-foreground">Week by week</h3>
        {ChartBlock && view.weeks.length > 0 ? (
          <>
            <ChartBlock options={trendOptions} height={isMobile ? '16rem' : '19rem'} />
            <p className="mt-1 text-xs text-muted-foreground">
              Weeks start on Monday. A week with fewer than {minSample} tickets has no point on the lines.
            </p>
          </>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm" data-testid="ai-pick-weeks">
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                  <th scope="col" className="py-2 pr-4 font-medium">Week of</th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">Tickets</th>
                  {copy.columns.map((column) => (
                    <th key={column} scope="col" className="whitespace-nowrap py-2 pr-4 font-medium">{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {view.weeks.map((row) => (
                  <tr key={row.week}>
                    <th scope="row" className="py-2 pr-4 text-left font-normal text-foreground">{weekLabel(row.week)}</th>
                    <td className="py-2 pr-4 text-right tabular-nums text-foreground/85">{fmt(row.tickets)}</td>
                    <td className="whitespace-nowrap py-2 pr-4"><Rate value={row.firstChoice} minSample={minSample} /></td>
                    <td className="whitespace-nowrap py-2 pr-4"><Rate value={row.inList} minSample={minSample} /></td>
                    <td className="whitespace-nowrap py-2 pr-4"><Rate value={row.changed} minSample={minSample} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-label={copy.overridesTitle}>
        <h3 className="mb-2 text-[13px] font-semibold text-foreground">{copy.overridesTitle}</h3>
        {view.overrides.length === 0 ? (
          <p className="text-sm text-muted-foreground">{copy.overridesEmpty}</p>
        ) : (
          <>
            <ul className="max-h-[30rem] divide-y divide-border/60 overflow-auto sm:hidden" data-testid="ai-pick-overrides-mobile">
              {view.overrides.map((row) => (
                <li key={row.ticketId} className="py-2.5 text-sm">
                  <a href={`/tickets/${row.ticketId}`} target="_blank" rel="noopener noreferrer" className="tp-focus-ring rounded font-medium text-primary hover:underline">
                    {row.displayRef}
                  </a>
                  <span className="ml-2 text-foreground/85">{row.subject}</span>
                  <p className="mt-1 text-xs text-muted-foreground">{row.category} · {dayLabel(row.runAt)}</p>
                  <p className="mt-1 text-foreground/85">AI: {row.aiFirstChoice}. Did it: {row.tookIt || 'nobody yet'}{row.inList && mode === 'suggest' ? ' (on the list)' : ''}.</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{overrideHowText(row)}</p>
                </li>
              ))}
            </ul>
            <div className="hidden max-h-96 overflow-auto sm:block">
              <table className="min-w-full text-sm" data-testid="ai-pick-overrides">
                <thead className="sticky top-0 z-10 bg-card">{/* QA 10-26 #6: above the rows' links */}
                  <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                    <th scope="col" className="py-2 pr-4 font-medium">Ticket</th>
                    <th scope="col" className="py-2 pr-4 font-medium">Category</th>
                    <th scope="col" className="whitespace-nowrap py-2 pr-4 font-medium">AI&rsquo;s pick</th>
                    <th scope="col" className="whitespace-nowrap py-2 pr-4 font-medium">Who did it</th>
                    <th scope="col" className="py-2 pr-4 font-medium">How</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {view.overrides.map((row) => (
                    <tr key={row.ticketId} className="align-top">
                      <td className="max-w-[22rem] py-2 pr-4">
                        <a href={`/tickets/${row.ticketId}`} target="_blank" rel="noopener noreferrer" className="tp-focus-ring whitespace-nowrap rounded font-medium text-primary hover:underline">
                          {row.displayRef}
                        </a>
                        <span className="ml-2 text-foreground/85">{row.subject}</span>
                        <span className="ml-2 whitespace-nowrap text-xs text-muted-foreground">{dayLabel(row.runAt)}</span>
                      </td>
                      <td className="py-2 pr-4 text-foreground/85">{row.category}</td>
                      <td className="whitespace-nowrap py-2 pr-4 text-foreground/85">{row.aiFirstChoice}</td>
                      <td className="py-2 pr-4 text-foreground/85">
                        <span className="whitespace-nowrap">{row.tookIt || 'Nobody yet'}</span>
                        {row.tookIt && (
                          <span className="block text-xs text-muted-foreground">{row.inList ? "On the AI's list" : 'Not on the list'}</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-foreground/85">{overrideHowText(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              The newest {view.overrides.length}. Open a ticket to read why. The CSV has every counted ticket.
            </p>
          </>
        )}
      </section>

      {view.spread?.length > 0 && (
        <section aria-label="Spread across the team">
          <button
            type="button"
            onClick={() => setShowSpread((open) => !open)}
            aria-expanded={showSpread}
            className="tp-focus-ring inline-flex items-center gap-1 rounded text-[13px] font-semibold text-foreground hover:text-primary"
          >
            <ChevronDown className={`h-4 w-4 ${showSpread ? '' : '-rotate-90'}`} aria-hidden="true" />
            Spread across the team
          </button>
          {showSpread && (
            <div className="mt-2">
              <p className="mb-2 max-w-3xl text-xs text-muted-foreground">
                How often each person was the AI&rsquo;s first choice, next to how often they did the ticket. It shows whether the AI leans on a few names. It says nothing about the quality of anyone&rsquo;s work. Alphabetical.
              </p>
              <div className="overflow-x-auto">
                <table className="text-sm" data-testid="ai-pick-spread">
                  <thead>
                    <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                      <th scope="col" className="py-2 pr-8 font-medium">Person</th>
                      <th scope="col" className="whitespace-nowrap py-2 pr-8 text-right font-medium">AI&rsquo;s first choice</th>
                      <th scope="col" className="whitespace-nowrap py-2 text-right font-medium">Did the ticket</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {view.spread.map((row) => (
                      <tr key={row.name}>
                        <th scope="row" className="py-1.5 pr-8 text-left font-normal text-foreground">{row.name}</th>
                        <td className="py-1.5 pr-8 text-right tabular-nums text-foreground/85">{fmt(row.firstChoice)}</td>
                        <td className="py-1.5 text-right tabular-nums text-foreground/85">{fmt(row.didIt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function HowCounted({ data }) {
  const rules = data.rules || {};
  const leftOut = leftOutParts(data.counts);
  const earlier = data.counts?.excluded?.earlierPeriod || 0;
  return (
    <details className="mt-6 border-t border-border pt-3 text-sm" data-testid="ai-pick-how-counted">
      <summary className="tp-focus-ring cursor-pointer rounded text-[13px] font-semibold text-foreground">How this is counted</summary>
      <ul className="mt-2 max-w-3xl list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
        <li>A ticket is counted once, by the first AI run that named at least one person for it. Later runs on the same ticket (a re-run, a priority change, a rebound) do not count it again. The ticket belongs to the period that first run started in.</li>
        <li>Who did the ticket is the assignee when it was resolved or closed. A ticket still open counts once its current owner has had it for {rules.openHoldHours ?? 24} hours.</li>
        <li>First choice means the person at the top of the AI&rsquo;s ranked list. In the list means anywhere on that list, first choice included.</li>
        <li>Changed by a person (when the AI assigns): the assignee handed it back, or someone else moved or cleared it. A ticket can be changed and still end with the first choice, so the numbers do not add up to 100%.</li>
        <li>Left out: noise, deleted and spam tickets, copies closed into another ticket, onboarding and offboarding tickets (they are routed by rule), tickets a person already had before the AI ran, and runs where the AI named nobody.</li>
        <li>No percentage is shown for fewer than {rules.minRateSample ?? 20} tickets. These are counts from the ticket history. Nothing here is written or estimated by AI.</li>
      </ul>
      <p className="mt-2 max-w-3xl text-sm text-muted-foreground" data-testid="ai-pick-left-out">
        In this period: {plural(data.counts?.considered, 'ticket', 'tickets')} had an AI assignment run, {fmt(data.counts?.judged)} counted.
        {leftOut.length > 0 && ` Left out: ${leftOut.join('; ')}.`}
        {earlier > 0 && ` ${plural(earlier, 'more ticket was', 'more tickets were')} already counted in an earlier period.`}
      </p>
    </details>
  );
}

export default function AiPickAccuracy({ params, ChartBlock = null, isMobile = false, palette: paletteProp = null, data: dataProp = null }) {
  const palette = useMemo(() => paletteProp || chartPalette(), [paletteProp]);
  const [fetched, setFetched] = useState(null);
  const [loading, setLoading] = useState(!dataProp);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState(null);
  const [exporting, setExporting] = useState(false);
  const seqRef = useRef(0);
  const paramsKey = JSON.stringify(params || {});

  const load = useCallback(async () => {
    if (dataProp) return;
    const query = JSON.parse(paramsKey);
    if (query.range === 'custom' && (!query.start || !query.end)) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await analyticsAPI.getAiPickAccuracy(query);
      if (seqRef.current === seq) setFetched(res?.data || null);
    } catch (err) {
      if (seqRef.current === seq) setError(err?.message || 'This section failed to load.');
    } finally {
      if (seqRef.current === seq) setLoading(false);
    }
  }, [dataProp, paramsKey]);

  useEffect(() => { load(); }, [load]);

  const data = dataProp || fetched;
  const modes = ['auto', 'suggest'].filter((key) => data?.[key]);
  const active = modes.includes(mode) ? mode : (modes.includes(data?.leadMode) ? data.leadMode : modes[0]);

  const downloadCsv = async () => {
    setExporting(true);
    try {
      const res = await analyticsAPI.getAiPickAccuracyExport(JSON.parse(paramsKey));
      const csv = rowsToCsv(res?.data?.rows || []);
      const blob = new Blob([String.fromCharCode(0xFEFF) + csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ai-pick-vs-assignee-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err?.message || 'The CSV could not be made.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-border bg-card p-3 shadow-sm sm:p-5" data-testid="ai-pick-accuracy" aria-busy={loading}>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">How often the AI&rsquo;s pick stands</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            The AI&rsquo;s suggested assignee against the person who did the ticket.
            {data?.counts ? ` ${plural(data.counts.judged, 'ticket', 'tickets')} counted in this period.` : ''}
          </p>
        </div>
        {data && modes.length > 0 && (
          <button
            type="button"
            onClick={downloadCsv}
            disabled={exporting}
            className="tp-focus-ring inline-flex flex-none items-center gap-1.5 self-start rounded-md px-2 py-1 text-sm font-medium text-primary hover:bg-muted disabled:opacity-60"
          >
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
            Download CSV
          </button>
        )}
      </div>

      {error && (
        <p className="mb-3 flex flex-wrap items-center gap-3 text-sm text-red-700 dark:text-red-200" role="alert">
          {error}
          <button type="button" onClick={load} className="tp-focus-ring inline-flex items-center gap-1 rounded font-medium underline">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Try again
          </button>
        </p>
      )}

      {!data && loading && (
        <div className="flex min-h-[10rem] items-center justify-center" data-testid="ai-pick-loading">
          <Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="Loading" />
        </div>
      )}

      {data && modes.length === 0 && (
        <p className="py-6 text-sm text-muted-foreground" data-testid="ai-pick-empty">
          {data.setup && !data.setup.enabled
            ? 'AI assignment is off in this workspace, so there is nothing to compare.'
            : 'No tickets with an AI pick to count in this period.'}
        </p>
      )}

      {data && modes.length > 0 && (
        <>
          {modes.length > 1 && (
            <div role="tablist" aria-label="How the AI was used" className="mb-4 flex gap-5 border-b border-border">
              {modes.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={active === key}
                  onClick={() => setMode(key)}
                  className={`tp-focus-ring -mb-px border-b-2 px-0.5 pb-2 text-sm ${
                    active === key ? 'border-primary font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {COPY[key].tab} <span className="tabular-nums text-muted-foreground">{fmt(data[key].tickets)}</span>
                </button>
              ))}
            </div>
          )}
          <ModeBody
            key={active}
            view={data[active]}
            mode={active}
            rules={data.rules}
            ChartBlock={ChartBlock}
            isMobile={isMobile}
            palette={palette}
          />
          <HowCounted data={data} />
        </>
      )}
    </section>
  );
}
