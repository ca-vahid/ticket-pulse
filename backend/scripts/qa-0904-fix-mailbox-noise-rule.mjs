/**
 * QA 09-04 — repair the "Mailbox Full / Archive Warnings" rule in place.
 *
 * The rule matched the subject alone, so every ticket it ever caught was an
 * EMPLOYEE forwarding their own Exchange warning to ask for help (11 of 12; the
 * twelfth came from the Exchange system mailbox, which is the only thing it was
 * meant to catch). It now requires the sender to be Exchange itself.
 *
 * Also stamps the July phishing-simulation campaign rule with
 * autoCloseFromPeople, because there the forwards ARE the noise.
 *
 * Usage:
 *   node scripts/qa-0904-fix-mailbox-noise-rule.mjs            # dry run
 *   node scripts/qa-0904-fix-mailbox-noise-rule.mjs --apply    # write
 *   DATABASE_URL=<prod> node scripts/... --apply               # against prod
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();

const CHANGES = [
  {
    match: 'Mailbox Full / Archive Warnings',
    data: {
      senderPattern: 'microsoftexchange[0-9a-f]{6,}@|^postmaster@',
      description: 'Automated mailbox capacity warnings sent by Exchange/M365 itself. A person forwarding their own warning is a real request and is left in the queue.',
    },
  },
  {
    matchContains: 'Phishing simulation forwards',
    data: { autoCloseFromPeople: true },
  },
];

for (const change of CHANGES) {
  const where = change.match
    ? { name: change.match }
    : { name: { contains: change.matchContains } };
  const rules = await prisma.noiseRule.findMany({
    where,
    select: { id: true, name: true, workspaceId: true, senderPattern: true, autoCloseFromPeople: true, matchCount: true },
  });
  if (rules.length === 0) {
    console.log(`SKIP  no rule matching ${JSON.stringify(where)}`);
    continue;
  }
  for (const rule of rules) {
    console.log(`${APPLY ? 'APPLY' : 'DRY  '} #${rule.id} ws${rule.workspaceId} "${rule.name}" (${rule.matchCount} lifetime matches)`);
    console.log(`      before: senderPattern=${JSON.stringify(rule.senderPattern)} autoCloseFromPeople=${rule.autoCloseFromPeople}`);
    console.log(`      after : ${JSON.stringify(change.data)}`);
    if (APPLY) {
      await prisma.noiseRule.update({ where: { id: rule.id }, data: change.data });
    }
  }
}

// What the repaired rule would have done to the tickets it already caught.
const caught = await prisma.ticket.findMany({
  where: { noiseRuleMatched: 'Mailbox Full / Archive Warnings' },
  select: { id: true, subject: true, isNoise: true, requester: { select: { email: true } } },
  orderBy: { createdAt: 'desc' },
});
const exchange = /microsoftexchange[0-9a-f]{6,}@|^postmaster@/i;
const wrong = caught.filter((t) => !exchange.test(t.requester?.email || ''));
console.log(`\nTickets this rule has caught: ${caught.length}; sent by a person, not Exchange: ${wrong.length}`);
for (const t of wrong.slice(0, 15)) console.log(`  #${t.id} ${t.requester?.email || '(none)'} — ${String(t.subject).slice(0, 60)}`);
console.log('\nExisting tickets are left as they are: they are closed, and re-opening year-old mail would confuse people.');

await prisma.$disconnect();
