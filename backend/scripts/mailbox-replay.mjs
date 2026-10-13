// Replay a mailbox's recent mail through the ingest rules WITHOUT ingesting anything
// (plans/IT_INTAKE_MIGRATION_PLAN.md, section 5). Graph reads and database reads only.
//
//   node scripts/mailbox-replay.mjs --mailbox it@example.com --workspace 1 [--days 6] [--profile helpdesk]
//        [--fs-reads-mail no] [--top 500]
//
// Each message is judged as of its own arrival (tickets created after it are ignored), so the
// result is what the rules would have done had this mailbox been connected at the time.
// Against production use a DATABASE_URL with connection_limit=1.
import { PrismaClient } from '@prisma/client';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const mailbox = arg('--mailbox');
const workspaceId = Number(arg('--workspace'));
if (!mailbox || !workspaceId) { console.error('usage: --mailbox <address> --workspace <id> [--days 6] [--profile helpdesk|standard] [--fs-reads-mail yes|no] [--top 500]'); process.exit(1); }
const days = Number(arg('--days', 6));
const profile = arg('--profile', 'helpdesk');
const fsReadsMail = arg('--fs-reads-mail', 'no');

const prisma = new PrismaClient();
const { default: settingsRepository } = await import('../src/services/settingsRepository.js');
if (fsReadsMail === 'no') {
  // In this process only: the cut-over setting "FreshService reads no mail for this workspace". Nothing is saved.
  const realGet = settingsRepository.get.bind(settingsRepository);
  settingsRepository.get = async (key, ...rest) => (key === `fs_helpdesk_emails_ws${workspaceId}` ? 'none' : realGet(key, ...rest));
}
const { default: ingest } = await import('../src/services/mailboxIngestService.js');

const count = (list) => Object.entries(list.reduce((a, k) => { a[k] = (a[k] || 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]);
try {
  const connection = { id: 0, workspaceId, address: mailbox, mode: 'ingest', newTicketPolicy: 'create', agentCcIntake: true, intakeProfile: profile };
  const out = await ingest.recheckInbox(connection, { since: new Date(Date.now() - days * 86400000), dryRun: true, top: Number(arg('--top', 500)), asOfArrival: true });
  const key = (x) => `${x.outcome}${x.reason ? `:${x.reason}` : ''}${x.via ? `:${x.via}` : ''}`;
  console.log(`${out.scanned} messages since ${out.since} (${profile} profile)`);
  for (const [k, n] of count(out.results.map(key))) console.log(`  ${String(n).padStart(4)}  ${k}`);
  const skipped = out.results.filter((x) => x.outcome === 'skipped');
  if (skipped.length) console.log('skipped, by sender:', JSON.stringify(count(skipped.map((x) => `${x.reason} ${String(x.from).toLowerCase()}`)).slice(0, 12)));
  const errors = out.results.filter((x) => x.outcome === 'error');
  if (errors.length) console.log('errors:', JSON.stringify(count(errors.map((x) => String(x.error).slice(0, 100)))));
} catch (err) {
  console.error('replay failed:', err.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
process.exit();
