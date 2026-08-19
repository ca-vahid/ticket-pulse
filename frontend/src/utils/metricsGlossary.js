/**
 * Metrics glossary — single source of truth for "what does this number mean?"
 * hints across Analytics (QA 08-17 #5). Every entry is written from the actual
 * derivation in backend/src/services/analyticsService.js (and reportService.js
 * for the Reports tab), phrased for coordinators — not SQL.
 *
 * Shape: { [metricKey]: { label, definition, formula?, caveats? } }
 * - label:      short human name (shown as the popover heading fallback).
 * - definition: one or two plain sentences a coordinator can act on.
 * - formula:    optional "how it's computed" line, shown in a muted mono style.
 * - caveats:    optional honesty note (sample size, sparse fields, framing).
 *
 * House rules baked in:
 * - CSAT / survey metrics ALWAYS point at the response count (coverage is low).
 * - People metrics are balance/coaching signals, never rankings.
 * - Everything here is deterministic and explainable — no AI estimates.
 */

export const METRICS_GLOSSARY = {
  /* ---------------------------------------------------------------- overview */
  created: {
    label: 'Created',
    definition: 'Tickets created in the selected date range, from every source — email, portal, phone, and Ticket Pulse-born.',
    caveats: 'Respects the noise filter and any category filter. The % delta compares against the immediately-preceding period of the same length.',
  },
  resolvedClosed: {
    label: 'Closed / Resolved',
    definition: 'Tickets that entered the queue in the selected range (assigned in range, or created in range if never assigned) and are now in a closed or resolved status.',
    caveats: 'Counted by assignment date, not close date — historical closed/resolved timestamps are too sparse to trust for older tickets.',
  },
  openBacklog: {
    label: 'Open Backlog',
    definition: 'All tickets currently sitting in an open or pending status — a right-now snapshot of the whole queue, not limited to the selected range.',
  },
  overdueRisk: {
    label: 'Overdue Risk',
    definition: 'Open tickets whose resolution due date has already passed. These are live breaches, worth triaging first.',
    formula: 'open tickets where dueBy < now',
  },
  netChange: {
    label: 'Net Change',
    definition: 'Created minus closed/resolved for the selected range. Positive means the backlog grew; negative means the team closed more than arrived.',
    formula: 'created − closed/resolved',
  },
  avgResolution: {
    label: 'Avg Resolution',
    definition: 'Average time from creation to resolution for range tickets that have a recorded resolution time, shown in hours.',
    caveats: 'Only sampled tickets count — the card shows how many. Check Resolution Coverage in Data Quality before treating this as the whole story.',
  },
  csat: {
    label: 'CSAT',
    definition: 'Average FreshService satisfaction-survey score for responses submitted in the selected range.',
    caveats: 'Survey coverage is low — always read this together with the response count shown under the number. A handful of responses can swing the average.',
  },
  firstResponseRisk: {
    label: 'First Response Risk',
    definition: 'Open tickets that have already passed their first-response due time without one — requesters still waiting to hear anything.',
    formula: 'open tickets where frDueBy < now',
  },

  /* ------------------------------------------------------------ data quality */
  rangeTickets: {
    label: 'Range Tickets',
    definition: 'How many tickets fall inside the selected range after the noise and category filters — the denominator behind the coverage percentages on this card.',
  },
  resolutionCoverage: {
    label: 'Resolution Coverage',
    definition: 'Share of range tickets that carry a recorded resolution time. When this is low, resolution-time metrics describe only the covered slice.',
    formula: 'tickets with resolution time ÷ range tickets',
  },
  csatSamples: {
    label: 'CSAT Samples',
    definition: 'Number of satisfaction-survey responses submitted in the selected range — the N behind every CSAT number on this page.',
    caveats: 'Survey coverage is low by nature; a CSAT average is only as reliable as this count.',
  },
  classifiedCanonical: {
    label: 'Classified',
    definition: 'Range tickets carrying a canonical Ticket Pulse category (and subcategory where the workspace uses one) — the cleanest slice for category analytics.',
  },
  legacyFallback: {
    label: 'Legacy Fallback',
    definition: 'Range tickets categorized only through mirrored FreshService or legacy fields instead of the canonical taxonomy. They still count in totals but their category labels are best-effort.',
  },
  categoryReviewNeeded: {
    label: 'Review Needed',
    definition: 'Range tickets flagged because their category fit looks weak or was queued for review during a taxonomy migration. Clearing these improves every category chart.',
  },
  unclassified: {
    label: 'Unclassified',
    definition: 'Range tickets with no usable category value at all — they appear as "Uncategorized" in category views.',
  },
  medianFirstResponse: {
    label: 'Median First Response',
    definition: 'Median time from ticket creation to the first public agent reply, across range tickets that have a first-reply timestamp.',
    caveats: 'Shown only once at least 30% of range tickets carry the timestamp — the n= and coverage under the number tell you how much history is populated.',
  },
  p90FirstResponse: {
    label: 'P90 First Response',
    definition: '90% of first replies in the sample were faster than this. A good read on the slow tail, less swayed by outliers than the average.',
    caveats: 'Same sample and 30% coverage gate as the median first response.',
  },
  originSplit: {
    label: 'Origin Split',
    definition: 'Range tickets split by where they were born: created in Ticket Pulse (TP-born) versus synced in from FreshService (FS-born).',
  },

  /* -------------------------------------------------------------- categories */
  categoriesCreatedDemand: {
    label: 'Created Demand',
    definition: 'Tickets created in the selected range, counted across every category — the total demand the category map divides up.',
  },
  categoriesOpen: {
    label: 'Open in Categories',
    definition: 'Tickets currently open or pending, whatever their age — a right-now queue snapshot, not limited to the range. The subtitle counts how many of them are already past their due date.',
  },
  categoriesReviewNeeded: {
    label: 'Review Needed',
    definition: 'Tickets in this view flagged for a category review — weak AI classification fit or a pending taxonomy-migration check. They are the review queue for keeping the map honest.',
  },
  categoriesAutomationFailures: {
    label: 'Automation Failures',
    definition: 'AI assignment pipeline runs in the range that errored or failed, counted against the category of the ticket they ran on. The subtitle shows total category-linked runs for scale.',
  },
  requesterHotspots: {
    label: 'Requester Hotspots',
    definition: 'The people who opened the most tickets in the selected range. Each row shows their ticket count and share of the listed total — useful for spotting repeat issues worth a root-cause look.',
  },

  /* ---------------------------------------------------- team balance & capacity */
  balanceScore: {
    label: 'Balance Score',
    definition: 'How evenly assignments are spread across the team once leave is accounted for: 100 means everyone carried the same load per day they were actually available; lower means load is concentrating on fewer people.',
    formula: '100 − (spread ÷ average) of per-tech assignments per available day',
    caveats: 'A balance signal for the team, not a score for any individual.',
  },
  avgAssignedPerTech: {
    label: 'Avg Assigned',
    definition: 'Average number of tickets assigned per active technician in the selected range — the team midpoint the distribution views compare against.',
  },
  avgPerAvailableDay: {
    label: 'Avg / Available Day',
    definition: 'Team assignments divided by the team’s total available days — weekdays in the range minus each person’s approved leave. The fairest per-day load figure when people were away.',
    formula: 'total assigned ÷ Σ (weekdays − leave days)',
  },
  openOver24h: {
    label: 'Open > 24h',
    definition: 'Tickets in the current open queue that were created more than 24 hours ago — age pressure right now, regardless of the selected range.',
  },
  assignmentSpread: {
    label: 'Assignment Spread',
    definition: 'The gap in assigned tickets between the most- and least-assigned technician in the range. A wide spread is a prompt to rebalance, never a scoreboard.',
    formula: 'max assigned − min assigned',
  },
  teamCloseRate: {
    label: 'Team Close Rate',
    definition: 'Share of the team’s range-assigned tickets that are now closed or resolved — team throughput, with the raw closed-of-assigned counts underneath.',
    formula: 'closed ÷ assigned, team-wide',
  },

  /* -------------------------------------------------- per-agent table columns */
  agentAssigned: {
    label: 'Assigned',
    definition: 'Tickets assigned to this technician in the selected range (or created-in-range if never formally assigned).',
  },
  agentOpenNow: {
    label: 'Open Now',
    definition: 'Tickets currently sitting open with this technician — a right-now queue count, not range-scoped.',
  },
  agentPendingNow: {
    label: 'Pending Now',
    definition: 'Tickets currently in a pending/waiting status with this technician — usually waiting on the requester or a third party.',
  },
  agentSelfPicked: {
    label: 'Self-picked',
    definition: 'Range tickets this technician picked up themselves (the assigner and assignee are the same person).',
  },
  agentCoordinatorAssigned: {
    label: 'Coordinator-assigned',
    definition: 'Range tickets a person other than the technician (typically a coordinator) assigned to them.',
  },
  agentAppAssigned: {
    label: 'App-assigned',
    definition: 'Range tickets assigned by Ticket Pulse’s automation (the app service account) — the AI routing pipeline.',
  },
  agentClosed: {
    label: 'Closed',
    definition: 'This technician’s range-assigned tickets that are now closed or resolved.',
  },
  agentCloseRate: {
    label: 'Close %',
    definition: 'Closed as a share of this technician’s range-assigned tickets. Context matters — a low value can simply mean recent assignments still in flight.',
    formula: 'closed ÷ assigned',
  },
  agentAvgResolution: {
    label: 'Avg Res.',
    definition: 'Average recorded resolution time for this technician’s range tickets, in hours — only tickets with a resolution time count.',
    caveats: 'Small samples swing this a lot; use as coaching context, not a ranking.',
  },
  agentCsat: {
    label: 'CSAT',
    definition: 'Average satisfaction-survey score on this technician’s tickets, with the response count in parentheses.',
    caveats: 'Survey coverage is low — never read the average without the count next to it.',
  },
  agentRejected: {
    label: 'Rejected',
    definition: 'Assignments this technician bounced back in the range — often a competency or workload signal worth a conversation, not a fault count.',
  },
  agentAvailableDays: {
    label: 'Available Days',
    definition: 'Weekdays in the selected range minus this technician’s approved leave days — the denominator that keeps per-day load fair for people who were away.',
    formula: 'range weekdays − leave days',
  },
  agentAssignedPerAvailableDay: {
    label: 'Assigned / Avail. Day',
    definition: 'This technician’s assigned tickets divided by their available days — the leave-adjusted load rate the Balance Score is built on.',
    formula: 'assigned ÷ available days',
  },
  agentLeaveDays: {
    label: 'Leave Days',
    definition: 'Approved leave days for this technician inside the selected range (from Vacation Tracker or the shared-mailbox sync). Hover the value for the per-type breakdown.',
  },
  agentWfhDays: {
    label: 'WFH Days',
    definition: 'Work-from-home days recorded for this technician inside the selected range. WFH days still count as available.',
  },
  agentLoadStatus: {
    label: 'Load status',
    definition: 'Quick read on the current queue (open + pending): 15 or more shows Watch, 30 or more shows High. A staffing signal, not a performance grade.',
  },
  shareOfTeam: {
    label: 'Share of Team',
    definition: 'This technician’s assigned tickets as a percentage of everything the visible team was assigned in the range — how the workload pie is currently sliced.',
  },

  /* ----------------------------------------------------------------- quality */
  qualityAvgResolution: {
    label: 'Avg Resolution',
    definition: 'Mean time from creation to resolution across range tickets with a recorded resolution time, in hours. The sampled-ticket count below the number is the N.',
  },
  qualityMedianResolution: {
    label: 'Median Resolution',
    definition: 'Half of the sampled tickets resolved faster than this. More robust than the average when a few monsters skew the data.',
  },
  qualityP90Resolution: {
    label: 'P90 Resolution',
    definition: '90% of sampled tickets resolved faster than this — the honest view of the slow tail your requesters actually feel.',
  },
  satisfiedTopTwoBox: {
    label: 'Satisfied (top-2-box)',
    definition: 'Share of rated tickets whose rating counts as satisfied: a FreshService CSAT of 3–4, or a first-party score of 4–5. One rating per ticket; first-party feedback wins when a ticket has both.',
    caveats: 'Always read alongside the rated-ticket count — survey coverage is low.',
  },
  firstPartyFeedback: {
    label: 'First-party feedback',
    definition: 'Average score from Ticket Pulse’s own 1–5 feedback prompt, separate from FreshService CSAT surveys.',
    caveats: 'The response count below the number is the whole sample — treat small N gently.',
  },
  satisfactionAverage: {
    label: 'Average score',
    definition: 'Mean satisfaction across both sources, normalized to 0–100% so a 4-point CSAT and a 5-point feedback score can be averaged together. Only reaches 100% when every rating is the maximum.',
    caveats: 'The subtitle shows how many ratings came from each source — the mix matters as much as the mean.',
  },

  /* ---------------------------------------------------------- automation ops */
  pipelineRuns: {
    label: 'Pipeline Runs',
    definition: 'AI assignment pipeline executions in the selected range — every run counts, including reruns and rebound-triggered runs.',
  },
  routingAccuracy: {
    label: 'Routing accuracy',
    definition: 'Percentage of auto-assigned tickets still with the AI’s pick after 7 days. A ticket counts against accuracy when a human reassigned it away within 7 days of the AI’s decision.',
  },
  rebounds: {
    label: 'Rebounds',
    definition: 'Unique tickets that bounced back and re-entered the assignment pipeline at least once in this range. Multiple rebounds on the same ticket count once — the same definition Assignment Review uses.',
  },
  syncFailureRate: {
    label: 'Sync Failure Rate',
    definition: 'Percentage of FreshService sync jobs in this range that logged a failure (failed sync logs divided by all sync logs, most recent 500).',
  },
  staleStartedSyncs: {
    label: 'Stale Started Syncs',
    definition: 'Sync jobs still marked ‘started’ more than 30 minutes after they began — likely stuck or crashed mid-run and worth investigating.',
  },

  /* ----------------------------------------------------------------- reports */
  reportCreated: {
    label: 'Created',
    definition: 'Tickets created inside this report’s window that match its scope. The delta compares against the prior period of the same length.',
  },
  reportPriorPeriod: {
    label: 'Prior period',
    definition: 'Ticket count for the equally-long period immediately before this report’s window, same scope — the baseline the Created delta is measured against.',
  },
  reportResolvedInWindow: {
    label: 'Resolved in window',
    definition: 'Of the tickets created in this window, how many already have a resolution timestamp — same-window creations that also finished.',
  },
  reportAvgResolution: {
    label: 'Avg resolution',
    definition: 'Average creation-to-resolution time, in hours, across tickets both created and resolved inside this window.',
    caveats: 'Tickets created here but resolved after the window don’t count yet, so early reads skew fast.',
  },
};

/** Look up a glossary entry; returns null (never throws) for unknown keys. */
export function getMetricHint(key) {
  return METRICS_GLOSSARY[key] || null;
}

/**
 * Plain-text one-liner for `title=` / `aria-label=` fallbacks where a full
 * popover would be per-row noise (table cells, mini-stat chips).
 */
export function metricHintText(key) {
  const entry = METRICS_GLOSSARY[key];
  if (!entry) return '';
  return [entry.definition, entry.caveats].filter(Boolean).join(' ');
}
