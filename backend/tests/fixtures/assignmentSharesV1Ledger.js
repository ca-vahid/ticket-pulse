/**
 * FROZEN COPY of the ticket-shares ledger as it was before rules per category
 * (origin/main at v4.4.28, services/assignmentShares/rules.js: splitCredit,
 * buildLedger, pickNext, previewSequence, decide). Do not edit: the QA 11-26
 * tests compare today's rules against it, to prove a v1 settings object
 * (the one Live in a workspace today) still makes exactly the same picks.
 */
import { onLeaveAt } from '../../src/services/assignmentShares/rules.js';

const UNIT = 10000;
/**
 * One ticket's credit, split over the people who were in: whole units that
 * add up to exactly one ticket. The rounding remainder goes to the largest
 * share (then the lower id), so the split is deterministic.
 * @returns {Map<number, number>} techId → units
 */
export function splitCredit(eligible) {
  const list = (eligible || []).filter((m) => m && m.pct > 0);
  const out = new Map();
  if (!list.length) return out;
  const sum = list.reduce((s, m) => s + m.pct, 0);
  let given = 0;
  for (const m of list) {
    const units = Math.floor((UNIT * m.pct) / sum);
    out.set(m.techId, units);
    given += units;
  }
  const first = [...list].sort((a, b) => b.pct - a.pct || a.techId - b.techId)[0];
  out.set(first.techId, out.get(first.techId) + (UNIT - given));
  return out;
}

/**
 * Earned and held, per person, over the counted tickets of the period.
 *
 * @param {object} p
 * @param {Array<{techId, pct}>} p.members
 * @param {Array<{holderId:number, at:Date|string}>} p.tickets  counted tickets (held by a member)
 * @param {Map<number, Array>} p.leavesByTech
 * @param {string} p.timeZone
 * @returns {Map<number, {earned:number, count:number}>}
 */
export function buildLedger({ members = [], tickets = [], leavesByTech = new Map(), timeZone } = {}) {
  const ledger = new Map(members.map((m) => [m.techId, { earned: 0, count: 0 }]));
  for (const t of tickets) {
    const at = new Date(t.at);
    const eligible = members.filter((m) => {
      const leaves = leavesByTech.get(m.techId);
      return !leaves?.length || !onLeaveAt(leaves, at, timeZone);
    });
    for (const [techId, units] of splitCredit(eligible)) ledger.get(techId).earned += units;
    const holder = ledger.get(Number(t.holderId));
    if (holder) holder.count += 1;
  }
  return ledger;
}

/**
 * The pick for the next ticket.
 *
 * @param {object} p
 * @param {Array<{techId, pct, name?}>} p.members
 * @param {Map} p.ledger           buildLedger()
 * @param {Map<number,string>} p.out  techId → why they cannot take it now (on leave, not active, handed it back)
 * @param {Map<number,string>} p.notWorking  techId → outside their working hours now: they earn, but do not take it
 * @param {Map<number, number>} p.lastAssignedAt  techId → ms of their latest assignment in the workspace (missing = never)
 * @returns {{ techId:number|null, scores: Array<{techId, pct, score, earnedNext, count, out:string|null}> }}
 */
export function pickNext({ members = [], ledger = new Map(), out = new Map(), notWorking = new Map(), lastAssignedAt = new Map() } = {}) {
  const eligible = members.filter((m) => !out.has(m.techId));
  const credit = splitCredit(eligible);
  const scores = members.map((m) => {
    const row = ledger.get(m.techId) || { earned: 0, count: 0 };
    const add = credit.get(m.techId) || 0;
    return {
      techId: m.techId,
      pct: m.pct,
      count: row.count,
      earnedNext: row.earned + add,
      score: row.earned + add - UNIT * row.count,
      out: out.get(m.techId) || null,
      notWorking: out.has(m.techId) ? null : (notWorking.get(m.techId) || null),
    };
  });
  const available = scores.filter((s) => !s.out);
  // People outside their hours wait while someone on the list is working.
  const working = available.filter((s) => !s.notWorking);
  const candidates = working.length ? working : available;
  if (!candidates.length) return { techId: null, scores };
  const last = (id) => (lastAssignedAt.has(id) ? lastAssignedAt.get(id) : -Infinity);
  candidates.sort((a, b) => b.score - a.score
    || b.pct - a.pct
    || last(a.techId) - last(b.techId)
    || a.techId - b.techId);
  return { techId: candidates[0].techId, scores };
}

/**
 * "The next N tickets would go to …": N picks in a row from the state now,
 * each one counted before the next (the same people out throughout).
 * @returns {number[]} techIds (shorter when nobody is in)
 */
export function previewSequence({ members = [], ledger = new Map(), out = new Map(), notWorking = new Map(), lastAssignedAt = new Map(), count = 10, now = new Date() } = {}) {
  const work = new Map([...ledger].map(([id, row]) => [id, { ...row }]));
  for (const m of members) if (!work.has(m.techId)) work.set(m.techId, { earned: 0, count: 0 });
  const last = new Map(lastAssignedAt);
  const picks = [];
  const eligible = members.filter((m) => !out.has(m.techId));
  const credit = splitCredit(eligible);
  for (let i = 0; i < count; i += 1) {
    const { techId } = pickNext({ members, ledger: work, out, notWorking, lastAssignedAt: last });
    if (!techId) break;
    picks.push(techId);
    for (const [id, units] of credit) work.get(id).earned += units;
    work.get(techId).count += 1;
    last.set(techId, new Date(now).getTime() + i + 1);
  }
  return picks;
}

const oneDecimal = (units) => Math.round((units / UNIT) * 10) / 10;
const nameOf = (names, id) => names.get(Number(id)) || `Technician ${id}`;
const periodWord = (period) => (period === 'month' ? 'this month' : 'this week');

/**
 * The whole decision for one ticket, with the sentences people read.
 * The sentences never list everyone's counts (agents can see suggestions);
 * the counts ride in the record, which only reviewers see.
 */
export function decide({ settings, ledger, out = new Map(), notWorking = new Map(), lastAssignedAt = new Map(), names = new Map(), aiPick = null } = {}) {
  const members = settings?.members || [];
  const { techId, scores } = pickNext({ members, ledger, out, notWorking, lastAssignedAt });
  const people = scores.map((s) => ({
    techId: s.techId,
    name: nameOf(names, s.techId),
    pct: s.pct,
    count: s.count,
    target: oneDecimal(s.earnedNext),
    out: s.out,
    ...(s.notWorking ? { notWorking: s.notWorking } : {}),
  }));
  const aiId = Number(aiPick?.techId) || null;
  const when = periodWord(settings?.period);
  if (!techId) {
    return {
      techId: null,
      people,
      agreesWithAi: false,
      sentence: 'Nobody on the share list is in, so the AI’s pick stands.',
      reason: null,
    };
  }
  const mine = people.find((p) => p.techId === techId);
  const reason = `furthest below their share ${when} (${mine.count} against about ${mine.target})`;
  return {
    techId,
    people,
    agreesWithAi: aiId === techId,
    reason,
    sentence: `${mine.name} is ${reason}.`,
  };
}
