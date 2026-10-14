/**
 * "How often the AI's pick stands" (QA 10-13 item 16, Analytics → Automation Ops).
 *
 * Deterministic counting only: no model call, no prediction. The file has two
 * halves so the rules can be tested without a database:
 *
 *   computePickAccuracy(inputs)  pure; every counting rule lives here
 *   fetchPickInputs(db, ...)     the reads (names only, never a photo column;
 *                                the run's recommendation JSON is reduced to
 *                                its ranked technician ids in SQL, because the
 *                                full JSON carries an HTML briefing per run)
 *
 * The rules, in the order they are applied to a ticket:
 *
 *  1. A ticket is counted ONCE, by its first full run: the earliest run on the
 *     ticket that reached an assignment decision (auto_assigned, or a
 *     suggestion: pending_review / approved / modified / rejected) AND named
 *     at least one technician. After-hours priority-only runs, classification
 *     runs, re-runs and rebound runs never count a ticket a second time.
 *  2. The ticket belongs to the period its first full run started in.
 *  3. Left out, and counted so the page can say so: noise; deleted / spam;
 *     copies closed into another ticket; onboarding / offboarding family
 *     tickets (routed by rule, not by the AI); tickets a person already owned
 *     before the AI ran; runs that named nobody.
 *  4. "Who did the ticket" = the assignee when it was resolved or closed. A
 *     ticket still open counts once its current owner has held it for
 *     OPEN_HOLD_HOURS; before that it is "too early to say". Closed with no
 *     owner, or open with no owner, cannot be judged.
 *  5. First choice kept = that person is the AI's first choice. In the list =
 *     that person is anywhere in the AI's ranked list (first choice included).
 *  6. Changed by a person (auto-assign only) = the assignment the AI made was
 *     ended by a person: handed back by the assignee, or moved / cleared by
 *     someone else. A move made by Ticket Pulse itself (a re-run, a rule) is
 *     counted apart and is not a person's change.
 *  7. No rate is produced for fewer than MIN_RATE_SAMPLE tickets.
 *
 * Team-safe: nothing here ranks people. Rows are by category, by week and by
 * ticket.
 */

export const PICK_RULES = {
  MIN_RATE_SAMPLE: 20,
  OPEN_HOLD_HOURS: 24,
  QUICK_CHANGE_MINUTES: 60,
  OVERRIDE_LIST_LIMIT: 25,
  START_TOLERANCE_MS: 60 * 1000,
};

export const SUGGEST_DECISIONS = ['pending_review', 'approved', 'modified', 'rejected'];
export const FULL_RUN_DECISIONS = ['auto_assigned', ...SUGGEST_DECISIONS];
const REMOVED_STATUSES = ['deleted', 'spam'];
const DUPLICATE_LINK_KINDS = ['duplicate_of', 'merged_into'];
/** Subjects the onboarding engine (and FreshService before it) gives a family's children. Same test the grouping sweep uses. */
const FAMILY_SUBJECT = /^\s*(child ticket\b|nh\s+(laptop|workstation)\s*-)/i;
const UNCATEGORISED = 'No category';

const ms = (value) => (value ? new Date(value).getTime() : null);

/** "Reza Zaim (in FreshService)" and "Muhammad (Mo) Shahidullah" compare equal to the plain name. */
export function normaliseName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isSystemActor(name, serviceAccountNames = []) {
  const raw = String(name || '').trim().toLowerCase();
  if (!raw) return false;
  if (raw.startsWith('ticket pulse')) return true;
  const plain = normaliseName(name);
  return serviceAccountNames.some((entry) => normaliseName(entry) === plain);
}

function isReboundRun(run) {
  return Boolean(run.isRebound) || ['rebound', 'rebound_exhausted'].includes(run.triggerSource);
}

function pickIdsOf(run) {
  return (Array.isArray(run.pickIds) ? run.pickIds : [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

/** n of N, with a percentage only when N is large enough to mean something. */
export function rate(n, total, minSample = PICK_RULES.MIN_RATE_SAMPLE) {
  const count = Number(n || 0);
  const of = Number(total || 0);
  return {
    n: count,
    of,
    pct: of >= minSample ? Math.round((count / of) * 100) : null,
  };
}

function emptyTally() {
  return { judged: 0, firstChoice: 0, inList: 0, changedByPerson: 0 };
}

function addToTally(tally, row) {
  tally.judged += 1;
  if (row.firstChoice) tally.firstChoice += 1;
  if (row.inList) tally.inList += 1;
  if (row.changedByPerson) tally.changedByPerson += 1;
}

function tallyRates(tally, mode) {
  return {
    tickets: tally.judged,
    firstChoice: rate(tally.firstChoice, tally.judged),
    inList: rate(tally.inList, tally.judged),
    // Auto-assign: a person ended the AI's assignment. Suggest: the person who
    // took the ticket was not on the AI's list at all.
    changed: mode === 'auto'
      ? rate(tally.changedByPerson, tally.judged)
      : rate(tally.judged - tally.inList, tally.judged),
  };
}

/** How a person ended the AI's own assignment (auto-assign), from the episode the AI opened. */
function describeAutoChange({ run, pick, owner, episodes, laterRuns, serviceAccountNames, techNames }) {
  const anchor = ms(run.createdAt) - PICK_RULES.START_TOLERANCE_MS;
  const sorted = episodes.slice().sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
  const episode = sorted.find((e) => Number(e.technicianId) === pick && ms(e.startedAt) >= anchor) || null;
  const rebounded = laterRuns.some(isReboundRun);
  const none = { changedByPerson: false, systemMoved: false, how: null, minutes: null, quick: null, byName: null, rebounded };

  if (!episode) {
    // No record of the AI's assignment as an episode: fall back to the outcome.
    if (owner !== null && owner !== pick) return { ...none, changedByPerson: true, how: 'unknown' };
    return none;
  }
  const ended = episode.endMethod === 'rejected' || episode.endMethod === 'reassigned';
  if (!ended) {
    if (owner !== null && owner !== pick) return { ...none, changedByPerson: true, how: 'unknown' };
    return none;
  }
  if (isSystemActor(episode.endActorName, serviceAccountNames)) return { ...none, systemMoved: true };

  const minutes = episode.endedAt ? Math.max(0, Math.round((ms(episode.endedAt) - ms(episode.startedAt)) / 60000)) : null;
  const actor = normaliseName(episode.endActorName);
  const assignee = normaliseName(techNames.get(pick));
  // "rejected" = the assignee was cleared. By themselves (or with no actor
  // recorded) it is a hand-back; cleared by somebody else it is a move.
  const handedBack = episode.endMethod === 'rejected' && (!actor || actor === assignee);
  return {
    changedByPerson: true,
    systemMoved: false,
    how: handedBack ? 'handed_back' : 'moved_by_other',
    minutes,
    quick: minutes === null ? null : minutes <= PICK_RULES.QUICK_CHANGE_MINUTES,
    byName: String(episode.endActorName || '').replace(/\s*\(in FreshService\)\s*$/i, '') || null,
    rebounded,
  };
}

/** How the person who did the ticket came to have it (suggest mode). */
function describeTake({ owner, episodes, techNames }) {
  const current = episodes
    .filter((e) => Number(e.technicianId) === owner)
    .sort((a, b) => ms(b.startedAt) - ms(a.startedAt))[0] || null;
  if (!current) return { how: 'unknown', byName: null };
  const by = normaliseName(current.startAssignedByName);
  if (current.startMethod === 'self_picked' || (by && by === normaliseName(techNames.get(owner)))) {
    return { how: 'picked_up', byName: null };
  }
  if (current.startMethod === 'coordinator_assigned' && current.startAssignedByName) {
    return { how: 'assigned_by', byName: current.startAssignedByName };
  }
  return { how: 'unknown', byName: null };
}

/**
 * @param {object} inputs
 * @param {Array}  inputs.runs      every run of the candidate tickets, any date: { id, ticketId, decision, triggerSource, isRebound, assignedTechId, createdAt, pickIds }
 * @param {Array}  inputs.tickets   { id, displayRef, subject, status, isNoise, assignedTechId, assignedAt, category }
 * @param {Array}  inputs.episodes  { ticketId, technicianId, startedAt, endedAt, startMethod, startAssignedByName, endMethod, endActorName }
 * @param {Iterable<number>} inputs.duplicateTicketIds   copies closed into another ticket
 * @param {Iterable<number>} inputs.onboardingTicketIds  onboarding / offboarding family tickets
 * @param {Map<number,string>} inputs.techNames
 * @param {string[]} inputs.terminalStatuses  the workspace's Resolved + Closed status names
 * @param {string[]} inputs.serviceAccountNames
 * @param {Date} inputs.start / inputs.end  the selected range
 * @param {Date} inputs.now
 * @param {(date: Date) => string} inputs.weekKeyOf
 */
export function computePickAccuracy({
  runs = [],
  tickets = [],
  episodes = [],
  duplicateTicketIds = [],
  onboardingTicketIds = [],
  techNames = new Map(),
  terminalStatuses = ['Resolved', 'Closed'],
  serviceAccountNames = [],
  start,
  end,
  now = new Date(),
  weekKeyOf = (date) => new Date(date).toISOString().slice(0, 10),
} = {}) {
  const startMs = ms(start);
  const endMs = ms(end);
  const nowMs = ms(now);
  const terminal = new Set(terminalStatuses.map((s) => String(s).toLowerCase()));
  const duplicates = new Set([...duplicateTicketIds].map(Number));
  const onboarding = new Set([...onboardingTicketIds].map(Number));
  const ticketById = new Map(tickets.map((t) => [Number(t.id), t]));

  const runsByTicket = new Map();
  for (const run of runs) {
    const list = runsByTicket.get(Number(run.ticketId)) || [];
    list.push(run);
    runsByTicket.set(Number(run.ticketId), list);
  }
  const episodesByTicket = new Map();
  for (const episode of episodes) {
    const list = episodesByTicket.get(Number(episode.ticketId)) || [];
    list.push(episode);
    episodesByTicket.set(Number(episode.ticketId), list);
  }

  const excluded = { noise: 0, removed: 0, duplicates: 0, onboarding: 0, ownedBeforeAi: 0, namedNobody: 0, earlierPeriod: 0 };
  const notYet = { tooEarly: 0, nobodyHasIt: 0, closedWithNoOwner: 0 };
  const rows = [];
  let considered = 0;

  for (const [ticketId, ticketRuns] of runsByTicket) {
    const ticket = ticketById.get(ticketId);
    if (!ticket) continue; // outside the page's category filter
    ticketRuns.sort((a, b) => Number(a.id) - Number(b.id));
    const decided = ticketRuns.filter((r) => FULL_RUN_DECISIONS.includes(r.decision));
    const inRange = (r) => ms(r.createdAt) >= startMs && ms(r.createdAt) <= endMs;
    if (!decided.some(inRange)) continue;

    const first = decided.find((r) => pickIdsOf(r).length > 0) || null;
    if (first && ms(first.createdAt) < startMs) { excluded.earlierPeriod += 1; continue; }
    if (first && ms(first.createdAt) > endMs) continue; // belongs to a later period
    considered += 1;

    const ticketEpisodes = episodesByTicket.get(ticketId) || [];
    const status = String(ticket.status || '').toLowerCase();
    const hasDuplicateDecision = (() => {
      const last = ticketRuns.filter((r) => ['duplicate_dismissed', 'duplicate_reverted'].includes(r.decision)).pop();
      return last?.decision === 'duplicate_dismissed';
    })();

    if (ticket.isNoise) { excluded.noise += 1; continue; }
    if (REMOVED_STATUSES.includes(status)) { excluded.removed += 1; continue; }
    if (duplicates.has(ticketId) || hasDuplicateDecision) { excluded.duplicates += 1; continue; }
    if (onboarding.has(ticketId) || FAMILY_SUBJECT.test(String(ticket.subject || ''))) { excluded.onboarding += 1; continue; }
    if (!first) { excluded.namedNobody += 1; continue; }
    const ownedBefore = isReboundRun(first)
      || ticketEpisodes.some((e) => ms(e.startedAt) < ms(first.createdAt) - PICK_RULES.START_TOLERANCE_MS);
    if (ownedBefore) { excluded.ownedBeforeAi += 1; continue; }

    const mode = first.decision === 'auto_assigned' ? 'auto' : 'suggest';
    const list = pickIdsOf(first);
    const pick = list[0];
    const owner = ticket.assignedTechId === null || ticket.assignedTechId === undefined ? null : Number(ticket.assignedTechId);
    const isClosed = terminal.has(status);

    let state = 'judged';
    if (owner === null) state = isClosed ? 'closedWithNoOwner' : 'nobodyHasIt';
    else if (!isClosed) {
      const active = ticketEpisodes
        .filter((e) => Number(e.technicianId) === owner && !e.endedAt)
        .sort((a, b) => ms(b.startedAt) - ms(a.startedAt))[0];
      const heldSince = ms(active?.startedAt) ?? ms(ticket.assignedAt);
      if (heldSince === null || nowMs - heldSince < PICK_RULES.OPEN_HOLD_HOURS * 3600 * 1000) state = 'tooEarly';
    }

    const laterRuns = ticketRuns.filter((r) => Number(r.id) > Number(first.id));
    const change = mode === 'auto'
      ? describeAutoChange({ run: first, pick, owner, episodes: ticketEpisodes, laterRuns, serviceAccountNames, techNames })
      : { changedByPerson: false, systemMoved: false, how: null, minutes: null, quick: null, byName: null, rebounded: laterRuns.some(isReboundRun) };
    const take = mode === 'suggest' && owner !== null ? describeTake({ owner, episodes: ticketEpisodes, techNames }) : null;

    rows.push({
      ticketId,
      displayRef: ticket.displayRef || `#${ticketId}`,
      subject: ticket.subject || '(no subject)',
      category: ticket.category || UNCATEGORISED,
      mode,
      week: weekKeyOf(new Date(first.createdAt)),
      runAt: new Date(first.createdAt).toISOString(),
      reviewDecision: mode === 'suggest' ? first.decision : null,
      aiFirstChoiceId: pick,
      aiFirstChoice: techNames.get(pick) || `Technician ${pick}`,
      aiList: list.map((id) => techNames.get(id) || `Technician ${id}`),
      ownerId: owner,
      owner: owner === null ? null : (techNames.get(owner) || `Technician ${owner}`),
      state,
      firstChoice: owner !== null && owner === pick,
      inList: owner !== null && list.includes(owner),
      changedByPerson: change.changedByPerson,
      systemMoved: change.systemMoved,
      changeHow: change.how,
      changeMinutes: change.minutes,
      changeQuick: change.quick,
      changeBy: change.byName,
      rebounded: change.rebounded,
      takeHow: take?.how || null,
      takeBy: take?.byName || null,
    });
  }

  const buildMode = (mode) => {
    const all = rows.filter((r) => r.mode === mode);
    if (!all.length) return null;
    const judged = all.filter((r) => r.state === 'judged');
    const total = emptyTally();
    const byCategory = new Map();
    const byWeek = new Map();
    for (const row of judged) {
      addToTally(total, row);
      const cat = byCategory.get(row.category) || emptyTally();
      addToTally(cat, row);
      byCategory.set(row.category, cat);
      const week = byWeek.get(row.week) || emptyTally();
      addToTally(week, row);
      byWeek.set(row.week, week);
    }
    const count = (list, test) => list.filter(test).length;
    const out = {
      mode,
      eligible: all.length,
      ...tallyRates(total, mode),
      notYet: {
        tooEarly: count(all, (r) => r.state === 'tooEarly'),
        nobodyHasIt: count(all, (r) => r.state === 'nobodyHasIt'),
        closedWithNoOwner: count(all, (r) => r.state === 'closedWithNoOwner'),
      },
      // Volume order (largest first), then name. A table of categories, not of people.
      categories: [...byCategory.entries()]
        .map(([name, tally]) => ({ name, ...tallyRates(tally, mode) }))
        .sort((a, b) => b.tickets - a.tickets || a.name.localeCompare(b.name)),
      weeks: [...byWeek.entries()]
        .map(([week, tally]) => ({ week, ...tallyRates(tally, mode) }))
        .sort((a, b) => a.week.localeCompare(b.week)),
    };
    if (mode === 'auto') {
      const changed = judged.filter((r) => r.changedByPerson);
      out.changes = {
        handedBack: count(changed, (r) => r.changeHow === 'handed_back'),
        movedByOther: count(changed, (r) => r.changeHow === 'moved_by_other'),
        unknown: count(changed, (r) => r.changeHow === 'unknown'),
        withinHour: count(changed, (r) => r.changeQuick === true),
        later: count(changed, (r) => r.changeQuick === false),
        timeUnknown: count(changed, (r) => r.changeQuick === null),
        rebounded: count(judged, (r) => r.rebounded),
        movedByTicketPulse: count(judged, (r) => r.systemMoved),
      };
    } else {
      // The review queue's own answer, over every eligible suggestion.
      out.review = {
        of: all.length,
        approvedAsIs: count(all, (r) => r.reviewDecision === 'approved'),
        changedInReview: count(all, (r) => r.reviewDecision === 'modified'),
        rejected: count(all, (r) => r.reviewDecision === 'rejected'),
        notAnswered: count(all, (r) => r.reviewDecision === 'pending_review'),
      };
      out.taken = {
        pickedUp: count(judged, (r) => r.takeHow === 'picked_up'),
        assignedBy: count(judged, (r) => r.takeHow === 'assigned_by'),
        unknown: count(judged, (r) => r.takeHow === 'unknown'),
      };
    }
    // Spread across the team: how often each person was the AI's first choice
    // against how often they did the ticket. Alphabetical, never ranked: it
    // shows whether the AI leans on a few names, not who is better.
    const spread = new Map();
    const spreadRow = (name) => {
      if (!spread.has(name)) spread.set(name, { name, firstChoice: 0, didIt: 0 });
      return spread.get(name);
    };
    for (const row of judged) {
      spreadRow(row.aiFirstChoice).firstChoice += 1;
      if (row.owner) spreadRow(row.owner).didIt += 1;
    }
    out.spread = [...spread.values()].sort((x, y) => x.name.localeCompare(y.name));
    // Recent tickets where a person overrode the AI, newest first. For a
    // suggestion, "overrode" = the person who did it was not the first choice.
    out.overrides = judged
      .filter((r) => (mode === 'auto' ? r.changedByPerson : !r.firstChoice))
      .sort((a, b) => b.runAt.localeCompare(a.runAt))
      .slice(0, PICK_RULES.OVERRIDE_LIST_LIMIT)
      .map((r) => ({
        ticketId: r.ticketId,
        displayRef: r.displayRef,
        subject: r.subject,
        category: r.category,
        runAt: r.runAt,
        aiFirstChoice: r.aiFirstChoice,
        tookIt: r.owner,
        inList: r.inList,
        how: mode === 'auto' ? r.changeHow : (r.reviewDecision === 'modified' ? 'changed_in_review' : r.takeHow),
        by: mode === 'auto' ? r.changeBy : r.takeBy,
        minutes: r.changeMinutes,
        rebounded: r.rebounded,
      }));
    return out;
  };

  for (const row of rows) if (row.state !== 'judged') notYet[row.state] += 1;
  const auto = buildMode('auto');
  const suggest = buildMode('suggest');
  const judgedTotal = (auto?.tickets || 0) + (suggest?.tickets || 0);

  return {
    rules: {
      minRateSample: PICK_RULES.MIN_RATE_SAMPLE,
      openHoldHours: PICK_RULES.OPEN_HOLD_HOURS,
      quickChangeMinutes: PICK_RULES.QUICK_CHANGE_MINUTES,
    },
    counts: {
      considered,
      eligible: rows.length,
      judged: judgedTotal,
      excluded,
      excludedTotal: Object.values(excluded).reduce((sum, n) => sum + n, 0) - excluded.earlierPeriod,
      notYet,
    },
    // The mode most tickets in the range were handled in; the page leads with it.
    leadMode: (auto?.eligible || 0) >= (suggest?.eligible || 0) ? (auto ? 'auto' : null) : 'suggest',
    auto,
    suggest,
    rows,
  };
}

/** One line per counted ticket, for the CSV. No ranking, no scores. */
export function pickAccuracyExportRows(result) {
  const HOW = {
    handed_back: 'Handed back by the assignee',
    moved_by_other: 'Moved by someone else',
    changed_in_review: 'Changed in the review queue',
    picked_up: 'Picked up by the person',
    assigned_by: 'Assigned by a person',
    unknown: 'Not recorded',
  };
  const STATE = {
    judged: 'Counted',
    tooEarly: 'Too early to say',
    nobodyHasIt: 'Nobody has it yet',
    closedWithNoOwner: 'Closed with no owner',
  };
  return (result?.rows || [])
    .slice()
    .sort((a, b) => b.runAt.localeCompare(a.runAt))
    .map((r) => ({
      Ticket: r.displayRef,
      Subject: r.subject,
      Category: r.category,
      'AI ran': r.runAt.slice(0, 10),
      Mode: r.mode === 'auto' ? 'AI assigned' : 'AI suggested',
      "AI's first choice": r.aiFirstChoice,
      "AI's list": r.aiList.join('; '),
      'Who did it': r.owner || '',
      Counted: STATE[r.state] || r.state,
      'First choice kept': r.state === 'judged' ? (r.firstChoice ? 'Yes' : 'No') : '',
      'In the list': r.state === 'judged' ? (r.inList ? 'Yes' : 'No') : '',
      'Changed by a person': r.mode === 'auto' && r.state === 'judged' ? (r.changedByPerson ? 'Yes' : 'No') : '',
      How: HOW[r.mode === 'auto' ? r.changeHow : (r.reviewDecision === 'modified' ? 'changed_in_review' : r.takeHow)] || '',
      By: (r.mode === 'auto' ? r.changeBy : r.takeBy) || '',
      'Minutes until changed': r.changeMinutes ?? '',
      'Came back to the AI': r.rebounded ? 'Yes' : '',
    }));
}

const soft = (read, fallback) => Promise.resolve().then(read).catch(() => fallback);

/**
 * The reads. `db` is a Prisma client. Returns the raw inputs for
 * computePickAccuracy (the caller adds names for statuses, service accounts
 * and the category of each ticket).
 */
export async function fetchPickInputs(db, { workspaceId, start, end, ticketWhere = {}, ticketSelect = {} }) {
  // Every run of every ticket that reached an assignment decision in the
  // range. The ranked technician ids are pulled out of the JSON in SQL: the
  // column also holds an HTML briefing per run, far too heavy to hydrate.
  const runs = await soft(() => db.$queryRaw`
    SELECT r.id,
           r.ticket_id        AS "ticketId",
           r.decision,
           r.trigger_source   AS "triggerSource",
           (jsonb_typeof(r.rebound_from) = 'object') AS "isRebound",
           r.assigned_tech_id AS "assignedTechId",
           r.created_at       AS "createdAt",
           CASE
             WHEN jsonb_typeof(r.recommendation -> 'recommendations') = 'array'
               THEN jsonb_path_query_array(r.recommendation, '$.recommendations[*].techId')
             WHEN jsonb_typeof(r.recommendation) = 'array'
               THEN jsonb_path_query_array(r.recommendation, '$[*].techId')
             ELSE '[]'::jsonb
           END AS "pickIds"
      FROM assignment_pipeline_runs r
     WHERE r.workspace_id = ${workspaceId}
       AND r.ticket_id IN (
             SELECT c.ticket_id
               FROM assignment_pipeline_runs c
              WHERE c.workspace_id = ${workspaceId}
                AND c.created_at >= ${start}
                AND c.created_at <= ${end}
                AND c.decision IN ('auto_assigned', 'pending_review', 'approved', 'modified', 'rejected')
           )
     ORDER BY r.id
  `, []);
  const ticketIds = [...new Set((runs || []).map((r) => Number(r.ticketId)))];
  if (!ticketIds.length) {
    return { runs: [], tickets: [], episodes: [], duplicateTicketIds: [], onboardingTicketIds: [], techNames: new Map() };
  }

  const [tickets, episodes, links, family] = await Promise.all([
    soft(() => db.ticket.findMany({
      where: { AND: [{ workspaceId, id: { in: ticketIds } }, ticketWhere] },
      select: {
        id: true,
        freshserviceTicketId: true,
        nativeNumber: true,
        origin: true,
        subject: true,
        status: true,
        isNoise: true,
        assignedTechId: true,
        assignedAt: true,
        ...ticketSelect,
      },
    }), []),
    soft(() => db.ticketAssignmentEpisode.findMany({
      where: { workspaceId, ticketId: { in: ticketIds } },
      select: {
        ticketId: true,
        technicianId: true,
        startedAt: true,
        endedAt: true,
        startMethod: true,
        startAssignedByName: true,
        endMethod: true,
        endActorName: true,
      },
    }), []),
    soft(() => db.ticketLink.findMany({
      where: { workspaceId, ticketId: { in: ticketIds }, kind: { in: DUPLICATE_LINK_KINDS } },
      select: { ticketId: true },
    }), []),
    soft(() => db.hrLifecycleFamilyMember.findMany({
      where: { workspaceId, ticketId: { in: ticketIds } },
      select: { ticketId: true },
    }), []),
  ]);

  const techIds = new Set();
  for (const run of runs) for (const id of pickIdsOf(run)) techIds.add(id);
  for (const ticket of tickets || []) if (ticket.assignedTechId) techIds.add(Number(ticket.assignedTechId));
  // Names only. The technician row also carries a photo (about 11 KB each).
  const technicians = techIds.size
    ? await soft(() => db.technician.findMany({ where: { id: { in: [...techIds] } }, select: { id: true, name: true } }), [])
    : [];

  return {
    runs: (runs || []).map((r) => ({ ...r, id: Number(r.id), ticketId: Number(r.ticketId) })),
    tickets: tickets || [],
    episodes: episodes || [],
    duplicateTicketIds: (links || []).map((l) => l.ticketId),
    onboardingTicketIds: (family || []).map((m) => m.ticketId),
    techNames: new Map((technicians || []).map((t) => [Number(t.id), t.name])),
  };
}
