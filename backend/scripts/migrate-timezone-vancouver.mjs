// One-off data migration (BC permanent UTC-7 from 1 Nov 2026):
// America/Los_Angeles still falls back an hour, so every stored Pacific zone moves to
// America/Vancouver, and the assignment prompt's "Toronto is 3 hours ahead" line is
// replaced by the seasonal wording. Sandbox workspaces (6-9) and history rows
// (daily review runs, cancelled scheduled tickets) are left alone.
//
//   DATABASE_URL=... node scripts/migrate-timezone-vancouver.mjs          # dry run
//   DATABASE_URL=... node scripts/migrate-timezone-vancouver.mjs --apply  # writes
import prisma from '../src/services/prisma.js';
import promptRepository, { DEFAULT_SYSTEM_PROMPT } from '../src/services/promptRepository.js';

const APPLY = process.argv.includes('--apply');
const SANDBOXES = [6, 7, 8, 9];
const LA = 'America/Los_Angeles';
const VAN = 'America/Vancouver';
const CHANGED_BY = 'timezone-migration 2026-10';
const OLD_LINE = '- Agents are in different timezones (e.g., Toronto is 3 hours ahead of Vancouver). A ticket analyzed at 9am PT can be assigned to an Eastern agent who started at 8am ET and is already 3 hours into their shift.';
const NEW_LINE = DEFAULT_SYSTEM_PROMPT.split('\n').find((line) => line.startsWith('- Agents are in different timezones'));

if (!NEW_LINE || NEW_LINE === OLD_LINE) throw new Error('New prompt line not found in DEFAULT_SYSTEM_PROMPT');

const live = { notIn: SANDBOXES };

const workspaces = await prisma.workspace.findMany({ where: { id: live, defaultTimezone: LA }, select: { id: true, name: true } });
const hours = await prisma.businessHour.count({ where: { workspaceId: live, timezone: LA } });
const techs = await prisma.technician.count({ where: { workspaceId: live, timezone: LA } });
const setting = await prisma.appSettings.findUnique({ where: { key: 'default_timezone' } });
console.log(`workspaces ${workspaces.map((w) => `${w.id} ${w.name}`).join(', ') || 'none'}`);
console.log(`business_hours rows ${hours}; technicians ${techs}; app setting default_timezone ${setting?.value ?? 'unset'}`);

const prompts = [];
for (const ws of await prisma.workspace.findMany({ where: { id: live }, select: { id: true } })) {
  const published = await prisma.assignmentPromptVersion.findFirst({ where: { workspaceId: ws.id, status: 'published' }, orderBy: { version: 'desc' } });
  if (published?.systemPrompt?.includes(OLD_LINE)) prompts.push(published);
}
console.log(`published prompts with the old line: ${prompts.map((p) => `ws${p.workspaceId} v${p.version}`).join(', ') || 'none'}`);

if (APPLY) {
  const w = await prisma.workspace.updateMany({ where: { id: live, defaultTimezone: LA }, data: { defaultTimezone: VAN } });
  const b = await prisma.businessHour.updateMany({ where: { workspaceId: live, timezone: LA }, data: { timezone: VAN } });
  const t = await prisma.technician.updateMany({ where: { workspaceId: live, timezone: LA }, data: { timezone: VAN } });
  if (setting?.value === LA) await prisma.appSettings.update({ where: { key: 'default_timezone' }, data: { value: VAN, updatedAt: new Date() } });
  for (const p of prompts) {
    const draft = await promptRepository.createVersion(p.workspaceId, {
      systemPrompt: p.systemPrompt.replace(OLD_LINE, NEW_LINE),
      toolConfig: p.toolConfig,
      notes: `BC permanent UTC-7 from 1 Nov 2026: Toronto is 2-3 hours ahead of Vancouver depending on the season (from v${p.version}).`,
      createdBy: CHANGED_BY,
    });
    const published = await promptRepository.publish(draft.id, CHANGED_BY);
    console.log(`ws${p.workspaceId}: prompt v${p.version} -> v${published.version}`);
  }
  console.log(`UPDATED workspaces ${w.count}, business_hours ${b.count}, technicians ${t.count}, setting ${setting?.value === LA ? 1 : 0}, prompts ${prompts.length}`);
} else {
  console.log('DRY RUN - nothing written. Re-run with --apply.');
}
await prisma.$disconnect();
