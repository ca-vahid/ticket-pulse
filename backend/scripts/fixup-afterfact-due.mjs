#!/usr/bin/env node
/**
 * QA 11-05 #6 — fix-up: open AFTER-THE-FACT offboarding families made under
 * the old due rule (everything due "the notice day, 5 PM": TP-11340 and its
 * children were overdue four hours after they arrived) get the new dates:
 *   parent   the notice date + Settings' parent due offset (7 days)
 *   children their after-the-fact offset in BUSINESS days after the notice
 *            (5 by default; the workspace business calendar)
 *
 * DRY RUN BY DEFAULT: reads only, prints each ticket with old → new due.
 *
 *   node scripts/fixup-afterfact-due.mjs                 # dry run, workspace 1
 *   node scripts/fixup-afterfact-due.mjs --family=37     # one family
 *   node scripts/fixup-afterfact-due.mjs --apply [--undo-file=path.json]
 *
 * Never moves a due date a person set: a ticket is only touched while its due
 * date is still exactly the one the old rule gave it AND no due change by
 * anyone but Ticket Pulse is in its history. Closed tickets are left.
 *
 * --apply writes the due date as a system change (actor "Ticket Pulse
 * (Onboarding)", no workflow event), stores the child's new offset on its
 * family member row (so a later wake keeps the new date), and writes an undo
 * file: [{ ticketId, ref, from, to, memberId, memberOffsetFrom }].
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SAME_MS = 60e3;
const refOf = (t) => (t.origin === 'ticketpulse' && t.nativeNumber ? `TP-${t.nativeNumber}` : (t.freshserviceTicketId ? `#${t.freshserviceTicketId}` : `ticket ${t.id}`));
const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Reads only. Returns { rows: [{ familyId, ticketId, ref, role, key, from, to, action, why? }] }. */
export async function planAfterFactFixup(db, hr, { workspaceId = 1, familyId = null } = {}) {
  const ws = Number(workspaceId);
  const { addDays, dueInstant, familyDueDate, localDate } = await import('../src/services/hrLifecycleService.js');
  const { default: businessCalendarService } = await import('../src/services/businessCalendarService.js');
  const settings = await hr.getSettings(ws, { withTechs: false });
  const tz = await hr._timeZone(ws);
  const calendar = await businessCalendarService.loadCalendarSafe(ws);
  const items = new Map((settings.templates?.offboarding_after_fact || []).map((i) => [i.key, i]));
  const families = await db.hrLifecycleFamily.findMany({
    where: { workspaceId: ws, kind: 'offboarding', afterTheFact: true, status: 'open', ...(familyId ? { id: Number(familyId) } : {}) },
    orderBy: { id: 'asc' },
    take: 200,
  });
  const rows = [];
  for (const f of families) {
    const members = await db.hrLifecycleFamilyMember.findMany({ where: { familyId: f.id, role: 'child' }, orderBy: { id: 'asc' }, take: 50 });
    const ids = [f.parentTicketId, ...members.map((m) => m.ticketId)].filter(Boolean);
    const tickets = await db.ticket.findMany({
      where: { id: { in: ids }, workspaceId: ws },
      select: { id: true, origin: true, nativeNumber: true, freshserviceTicketId: true, status: true, dueBy: true, createdAt: true },
    });
    const dueChanges = await db.ticketActivity.findMany({
      where: { ticketId: { in: ids }, activityType: 'due_changed' },
      select: { ticketId: true, performedBy: true },
      take: 500,
    });
    const byId = new Map(tickets.map((t) => [t.id, t]));
    const date = f.effectiveDate ? new Date(f.effectiveDate).toISOString().slice(0, 10) : null;
    const notice = hr._noticeDateOf(f, tz);
    const base = date ? (notice && date < notice ? notice : date) : notice;
    const list = [
      ...(f.parentTicketId ? [{ role: 'parent', ticketId: f.parentTicketId, member: null }] : []),
      ...members.map((m) => ({ role: 'child', ticketId: m.ticketId, member: m })),
    ];
    for (const x of list) {
      const t = byId.get(x.ticketId);
      if (!t) continue;
      const key = x.member?.templateKey || null;
      const row = { familyId: f.id, ticketId: t.id, ref: refOf(t), role: x.role, key, from: iso(t.dueBy) };
      if (['Resolved', 'Closed', 'Deleted', 'Spam'].includes(t.status)) { rows.push({ ...row, action: 'skip', why: `status ${t.status}` }); continue; }
      // What the OLD rule set: the parent on the base date, a child on base + its stored offset (calendar days).
      const oldDue = base ? dueInstant(x.role === 'parent' ? base : addDays(base, x.member?.dueOffsetDays || 0), tz) : null;
      const offset = x.role === 'child' ? Number(items.get(key)?.dueOffsetDays ?? 5) : 0;
      const newDate = familyDueDate({
        kind: 'offboarding', afterTheFact: true, role: x.role, offsetDays: offset, date, noticeDate: notice,
        parentDueOffsetDays: settings.parentDueOffsetDays, calendar, floor: t.createdAt ? localDate(t.createdAt, tz) : null,
      });
      const to = newDate ? dueInstant(newDate, tz) : null;
      const byPerson = dueChanges.some((a) => a.ticketId === t.id && !String(a.performedBy || '').startsWith('Ticket Pulse'));
      const stillTemplate = oldDue && t.dueBy && Math.abs(new Date(t.dueBy).getTime() - new Date(oldDue).getTime()) < SAME_MS;
      if (byPerson) { rows.push({ ...row, to, action: 'skip', why: 'a person changed the due date' }); continue; }
      if (!stillTemplate) { rows.push({ ...row, to, action: 'skip', why: `due is not the old template's (${iso(oldDue)})` }); continue; }
      if (to && Math.abs(new Date(to).getTime() - new Date(t.dueBy).getTime()) < SAME_MS) { rows.push({ ...row, to, action: 'skip', why: 'already right' }); continue; }
      rows.push({ ...row, to, action: 'move', origin: t.origin, memberId: x.member?.id ?? null, memberOffsetFrom: x.member?.dueOffsetDays ?? null, memberOffsetTo: x.role === 'child' ? offset : null });
    }
  }
  return { rows };
}

function parseArgs(argv) {
  const get = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const ws = Number(get('workspace')) || 1;
  if ([6, 7, 8, 9].includes(ws)) throw new Error(`Workspace ${ws} is out of bounds for this script`);
  return {
    apply: argv.includes('--apply'),
    workspaceId: ws,
    familyId: get('family') ? Number(get('family')) : null,
    undoFile: get('undo-file') || `fixup-afterfact-due-undo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  };
}

/**
 * Due dates are 17:00 in Vancouver. A Node whose time-zone data predates BC's
 * permanent UTC-7 (1 Nov 2026) is an hour off, so the script re-runs itself
 * with the repo's ICU files (backend/tzdata/2026e, see its README) — the probe
 * runner hands it the App Service's Linux path, which does not exist here.
 */
async function ensureTimeZoneData() {
  const { checkTimeZoneData } = await import('../src/utils/tzDataCheck.js');
  if (checkTimeZoneData().ok) return true;
  if (process.env.TP_TZ_RESPAWNED) return false;
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { spawnSync } = await import('node:child_process');
  const dir = fileURLToPath(new URL('../tzdata/2026e', import.meta.url));
  if (!existsSync(dir)) return false;
  const r = spawnSync(process.execPath, process.argv.slice(1), { env: { ...process.env, ICU_TIMEZONE_FILES_DIR: dir, TP_TZ_RESPAWNED: '1' }, stdio: 'inherit' });
  process.exit(r.status ?? 1);
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!(await ensureTimeZoneData())) {
    console.log('WARNING: this Node does not know BC\'s permanent UTC-7 — the due times below are an hour off.');
    if (args.apply) throw new Error('Refusing --apply with old time-zone data: set ICU_TIMEZONE_FILES_DIR to backend/tzdata/2026e');
  }
  const { default: prisma } = await import('../src/services/prisma.js');
  const { default: hr, HR_LIFECYCLE_ACTOR } = await import('../src/services/hrLifecycleService.js');
  try {
    const { rows } = await planAfterFactFixup(prisma, hr, args);
    console.log(`${args.apply ? 'APPLY' : 'DRY RUN'} — after-the-fact offboarding due dates, workspace ${args.workspaceId}${args.familyId ? `, family ${args.familyId}` : ''}`);
    for (const r of rows) {
      console.log(`  family ${r.familyId}  ${r.ref.padEnd(9)} ${r.role.padEnd(6)} ${String(r.key || '').padEnd(8)} ${r.from || '—'} → ${r.to || '—'}  ${r.action}${r.why ? ` (${r.why})` : ''}`);
    }
    const moves = rows.filter((r) => r.action === 'move');
    console.log(`to move: ${moves.length}; skipped: ${rows.length - moves.length}`);
    if (!args.apply) {
      console.log('Nothing written (dry run). Re-run with --apply to move them.');
      return;
    }
    const { default: ticketService } = await import('../src/services/ticketService.js');
    const undo = [];
    for (const r of moves) {
      try {
        if (r.origin === 'ticketpulse') await ticketService.updateTicketFields(r.ticketId, args.workspaceId, { dueBy: r.to }, HR_LIFECYCLE_ACTOR, { emitEvent: false });
        else await ticketService.updateFsTicket(r.ticketId, args.workspaceId, { dueBy: r.to }, HR_LIFECYCLE_ACTOR, { notifyLifecycle: false });
        if (r.memberId && r.memberOffsetTo !== null) await prisma.hrLifecycleFamilyMember.update({ where: { id: r.memberId }, data: { dueOffsetDays: r.memberOffsetTo } });
        undo.push({ ticketId: r.ticketId, ref: r.ref, from: r.from, to: r.to, memberId: r.memberId, memberOffsetFrom: r.memberOffsetFrom });
      } catch (err) {
        console.log(`  ! ${r.ref}: ${err.message}`);
      }
    }
    writeFileSync(args.undoFile, JSON.stringify(undo, null, 2));
    console.log(`moved: ${undo.length}; undo file: ${args.undoFile}`);
  } finally {
    await prisma.$disconnect?.();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
