#!/usr/bin/env node
/**
 * QA 11-05 #5 — backfill: onboarding / offboarding tickets of the last six
 * months that have NO category get the one their template gives them.
 *
 * DRY RUN BY DEFAULT: reads only, prints the counts per group and the ticket
 * ids. Nothing is written without --apply.
 *
 *   node scripts/backfill-hr-categories.mjs                    # dry run, workspace 1 (IT), 180 days
 *   node scripts/backfill-hr-categories.mjs --days=90 --workspace=1
 *   node scripts/backfill-hr-categories.mjs --apply [--undo-file=path.json]
 *
 * Who gets what (uncategorized only — a category somebody set is never touched):
 *   1. family members      a child by its template key (Settings → Comings &
 *                          Goings → the child's category); the parent and
 *                          attached notices by their notice kind
 *   2. HR-sender notices   by type (departure, new hire, transfer, leave), in
 *                          a family or not
 *   3. old FreshService    "Child Ticket - <Laptop|Phone|iPad|Disable Account|
 *      children            Decommissioning Account|…> - …" by the word in the
 *                          subject (a new hire's by the onboarding template)
 *
 * --apply writes each category as a system change in the ticket's history
 * (actor "Ticket Pulse (Onboarding)"), with NO workflow event: TP-born
 * through updateTicketFields (emitEvent false; the FS copy is mirrored as
 * usual), FS-born on our row only (no FreshService write). Each ticket is
 * marked as template-categorized, so a later AI run keeps it. An undo file
 * lists every id with its before/after: [{ ticketId, ref, origin, from, to }].
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { HR_SENDERS, NOTICE_EFFECT } from '../src/utils/hrNoticeClassifier.js';

const CHILD_SUBJECT = /^Child Ticket\s*-\s*(Laptop and Workstation Setup|User Creation|Decommissioning Account|Disable Account|Workstation|Laptop|Phone|iPad)\s*-\s*(.*)$/i;
const OFFBOARDING_WORD_KEY = { laptop: 'laptop', phone: 'phone', ipad: 'ipad', 'disable account': 'disable_account', 'decommissioning account': 'decommission_account' };
const ONBOARDING_WORD_KEY = { 'user creation': 'laptop', 'laptop and workstation setup': 'workstation', workstation: 'workstation', laptop: 'laptop' };
const ROLE_NOTICE_TYPE = { offboarding: 'departure', onboarding: 'new_hire' };

const refOf = (t) => (t.origin === 'ticketpulse' && t.nativeNumber ? `TP-${t.nativeNumber}` : (t.freshserviceTicketId ? `#${t.freshserviceTicketId}` : `ticket ${t.id}`));

/** "Child Ticket - <word> - <notice subject>" → { kind, key } or null. */
export function childFromSubject(subject) {
  const m = String(subject || '').match(CHILD_SUBJECT);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const rest = m[2] || '';
  const onboarding = /new hire/i.test(rest) || ['user creation', 'laptop and workstation setup', 'workstation'].includes(word);
  if (onboarding) return { kind: 'onboarding', key: ONBOARDING_WORD_KEY[word] || null, word: m[1] };
  return { kind: 'offboarding', key: OFFBOARDING_WORD_KEY[word] || null, word: m[1] };
}

/**
 * Reads only. Returns { rows: [{ ticketId, ref, origin, group, to }], skipped }.
 * `hr` is the hrLifecycleService (getSettings / classify / category helpers).
 */
export async function planHrCategoryBackfill(db, hr, { workspaceId = 1, days = 180, now = new Date() } = {}) {
  const ws = Number(workspaceId);
  const since = new Date(now.getTime() - days * 86400e3);
  const settings = await hr.getSettings(ws, { withTechs: false });
  const tz = await hr._timeZone(ws);

  const families = await db.hrLifecycleFamily.findMany({ where: { workspaceId: ws }, select: { id: true, kind: true, template: true, parentTicketId: true }, take: 5000 });
  const famById = new Map(families.map((f) => [f.id, f]));
  const members = families.length
    ? await db.hrLifecycleFamilyMember.findMany({ where: { workspaceId: ws, familyId: { in: families.map((f) => f.id) } }, select: { familyId: true, ticketId: true, role: true, templateKey: true }, take: 20000 })
    : [];
  const membership = new Map();
  for (const f of families) if (f.parentTicketId) membership.set(f.parentTicketId, { role: 'parent', family: f });
  for (const m of members) if (!membership.has(m.ticketId) || m.role === 'child') membership.set(m.ticketId, { role: m.role, templateKey: m.templateKey, family: famById.get(m.familyId) });

  const tickets = await db.ticket.findMany({
    where: {
      workspaceId: ws,
      internalCategoryId: null,
      createdAt: { gte: since },
      status: { notIn: ['Deleted', 'Spam'] },
      OR: [
        { id: { in: [...membership.keys()] } },
        { requester: { email: { in: [...HR_SENDERS] } } },
        { subject: { startsWith: 'Child Ticket' } },
      ],
    },
    select: {
      id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true, subject: true, descriptionText: true,
      status: true, createdAt: true, internalCategoryId: true, requester: { select: { email: true } },
    },
    orderBy: { id: 'asc' },
    take: 5000,
  });

  const rows = [];
  const skipped = [];
  for (const t of tickets) {
    if (t.internalCategoryId) continue;
    let group = null;
    let to = null;
    const m = membership.get(t.id);
    if (m && m.role === 'child' && m.family) {
      to = hr._categoryForKey(settings, m.family.kind, m.templateKey, m.family.template);
      if (!to.categoryId) to = hr._categoryForKey(settings, m.family.kind, m.templateKey);
      group = `family child: ${m.family.kind} / ${m.templateKey || '?'}`;
    } else if (m && (m.role === 'parent' || m.role === 'notice') && m.family) {
      const c = hr.classify(t, tz);
      const type = c && NOTICE_EFFECT[c.type] ? c.type : ROLE_NOTICE_TYPE[m.family.kind];
      to = hr._noticeCategory(settings, type);
      group = `family ${m.role}: ${type}`;
    } else if (m && m.role === 'linked') {
      skipped.push({ ticketId: t.id, why: 'linked NH automation ticket' });
      continue;
    } else {
      const c = HR_SENDERS.includes(String(t.requester?.email || '').toLowerCase()) ? hr.classify(t, tz) : null;
      if (c && NOTICE_EFFECT[c.type]) {
        to = hr._noticeCategory(settings, c.type);
        group = `notice: ${c.type}`;
      } else {
        const child = childFromSubject(t.subject);
        if (child?.key) {
          to = hr._categoryForKey(settings, child.kind, child.key);
          group = `old child: ${child.kind} / ${child.word}`;
        }
      }
    }
    if (!group) continue;
    if (!to?.categoryId) { skipped.push({ ticketId: t.id, why: `${group}: no category in the settings` }); continue; }
    rows.push({ ticketId: t.id, ref: refOf(t), origin: t.origin, group, to: { categoryId: to.categoryId, subcategoryId: to.subcategoryId || null } });
  }
  return { rows, skipped };
}

export function summarize(rows) {
  const out = {};
  for (const r of rows) {
    const k = `${r.group} → ${r.to.categoryId}${r.to.subcategoryId ? ` > ${r.to.subcategoryId}` : ''}`;
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function parseArgs(argv) {
  const get = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const ws = Number(get('workspace')) || 1;
  if ([6, 7, 8, 9].includes(ws)) throw new Error(`Workspace ${ws} is out of bounds for this script`);
  return {
    apply: argv.includes('--apply'),
    workspaceId: ws,
    days: Number(get('days')) || 180,
    undoFile: get('undo-file') || `backfill-hr-categories-undo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { default: prisma } = await import('../src/services/prisma.js');
  const { default: hr } = await import('../src/services/hrLifecycleService.js');
  try {
    const { rows, skipped } = await planHrCategoryBackfill(prisma, hr, args);
    console.log(`${args.apply ? 'APPLY' : 'DRY RUN'} — onboarding/offboarding categories, workspace ${args.workspaceId}, last ${args.days} days, uncategorized only`);
    console.log(`to categorize: ${rows.length}`);
    for (const [k, n] of Object.entries(summarize(rows)).sort()) console.log(`  ${String(n).padStart(4)}  ${k}`);
    console.log(`skipped: ${skipped.length}`, JSON.stringify(skipped.reduce((m, s) => ({ ...m, [s.why]: (m[s.why] || 0) + 1 }), {})));
    console.log('ids:', JSON.stringify(rows.map((r) => r.ticketId)));
    if (!args.apply) {
      console.log('Nothing written (dry run). Re-run with --apply to write them.');
      return;
    }
    const undo = [];
    const out = { warnings: [] };
    for (const r of rows) {
      const t = { id: r.ticketId, workspaceId: args.workspaceId, origin: r.origin, nativeNumber: null, freshserviceTicketId: null };
      const wrote = await hr._applyCategory(t, r.to, out, { recheck: true, backfill: true });
      if (wrote) undo.push({ ticketId: r.ticketId, ref: r.ref, origin: r.origin, from: { categoryId: null, subcategoryId: null }, to: r.to });
    }
    writeFileSync(args.undoFile, JSON.stringify(undo, null, 2));
    console.log(`written: ${undo.length}; warnings: ${out.warnings.length}; undo file: ${args.undoFile}`);
    for (const w of out.warnings.slice(0, 20)) console.log(`  ! ${w}`);
  } finally {
    await prisma.$disconnect?.();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
