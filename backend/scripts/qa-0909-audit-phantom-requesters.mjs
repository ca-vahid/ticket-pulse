#!/usr/bin/env node
/**
 * Find requester records on an INTERNAL domain that no longer correspond to a
 * real mailbox, and optionally suppress them (QA 09-09).
 *
 * Background: a QA run of the Project Accounting Power App integration posted
 * a ticket through POST /api/v1/tickets with a GUESSED requester address
 * (susan.xu@bgcengineering.ca, when her login is sxu@). resolveRequester looks
 * for an existing requester, asks Microsoft Graph to enrich it, gets a 404,
 * swallows it, and creates the row anyway — so a typo becomes a permanent
 * directory entry that shadows a real employee in every requester picker.
 *
 * Classification is deliberately three-way, and the middle case is the one
 * that matters:
 *
 *   UPN     — /users/{email} resolves. A real account. Leave alone.
 *   ALIAS   — 404 on the UPN lookup, but the address IS a proxyAddress or
 *             otherMail on a live mailbox. Mail sent there REACHES a real
 *             person, so it must never be suppressed. If a separate requester
 *             row exists for the owner's primary address, this is a duplicate
 *             to MERGE, not a phantom to remove.
 *   ABSENT  — no account, no alias, no otherMail. Nothing can be delivered
 *             here. This is the phantom.
 *
 * Checking only /users/{email} would classify skumar@ and aschevers@ as
 * phantoms; both are live SMTP aliases (Kumar Sriskandakumar and Amanda Soto
 * Montes, whose previous surname is kept as an alias). Suppressing those would
 * have broken real ticket creation for two employees.
 *
 *   node scripts/qa-0909-audit-phantom-requesters.mjs                  # audit
 *   node scripts/qa-0909-audit-phantom-requesters.mjs --apply          # suppress ABSENT
 *   node scripts/qa-0909-audit-phantom-requesters.mjs --json out.json  # machine-readable
 *
 * Suppression writes requesters.suppressed_at/_reason. It deliberately does
 * NOT use is_active: the FreshService requester sync overwrites is_active from
 * FreshService on every cycle, so a deactivation would be undone on the next
 * sync for any row FreshService still knows about.
 */
import { PrismaClient } from '@prisma/client';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const jsonPath = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;
const CONCURRENCY = 8;

const prisma = new PrismaClient();

async function graphToken() {
  const tenant = process.env.AZURE_AD_TENANT_ID;
  const body = new URLSearchParams({
    client_id: process.env.AZURE_AD_CLIENT_ID,
    client_secret: process.env.AZURE_AD_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, { method: 'POST', body });
  const json = await res.json();
  if (!json.access_token) throw new Error(`Graph token failed: ${JSON.stringify(json).slice(0, 200)}`);
  return json.access_token;
}

/** UPN -> ALIAS -> ABSENT, with UNAVAILABLE kept distinct from ABSENT. */
async function classify(email, headers) {
  const direct = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}?$select=userPrincipalName,displayName,accountEnabled`,
    { headers },
  );
  if (direct.ok) {
    const d = await direct.json();
    return { verdict: 'UPN', owner: d.userPrincipalName, enabled: d.accountEnabled };
  }
  if (direct.status !== 404) return { verdict: 'UNAVAILABLE', owner: null, http: direct.status };

  for (const filter of [
    `proxyAddresses/any(x:x eq 'smtp:${email}')`,
    `otherMails/any(x:x eq '${email}')`,
  ]) {
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users?$filter=${encodeURIComponent(filter)}&$select=userPrincipalName,displayName&$count=true`,
      { headers },
    );
    if (!res.ok) continue;
    const d = await res.json();
    if ((d.value || []).length) {
      return { verdict: 'ALIAS', owner: d.value[0].userPrincipalName, ownerName: d.value[0].displayName };
    }
  }
  return { verdict: 'ABSENT', owner: null };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

try {
  const token = await graphToken();
  const headers = { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' };

  const rows = await prisma.$queryRawUnsafe(`
    SELECT r.id, r.name, r.email, r.freshservice_id::text AS fs_id,
           r.created_at, r.suppressed_at,
           (SELECT count(*) FROM tickets t WHERE t.requester_id = r.id) AS tickets,
           (SELECT count(*) FROM tickets t WHERE t.requester_id = r.id AND t.origin = 'ticketpulse') AS tp_born
    FROM requesters r
    WHERE r.is_active = true
      AND (r.email ILIKE '%@bgcengineering.ca' OR r.email ILIKE '%@cambioearth.com')
    ORDER BY r.email
  `);
  console.log(`Checking ${rows.length} active internal requesters against Entra...\n`);

  const results = await mapLimit(rows, CONCURRENCY, async (r) => ({
    ...r,
    tickets: Number(r.tickets),
    tp_born: Number(r.tp_born),
    ...(await classify(r.email, headers)),
  }));

  const tally = results.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] || 0) + 1; return acc; }, {});
  console.log('Verdicts:', JSON.stringify(tally), '\n');

  const absent = results.filter((r) => r.verdict === 'ABSENT');
  const aliases = results.filter((r) => r.verdict === 'ALIAS');
  const unavailable = results.filter((r) => r.verdict === 'UNAVAILABLE');

  // An ALIAS whose owner also has their OWN requester row is a duplicate of a
  // real person: two rows, one human. Merge candidate, never a suppression.
  const byEmail = new Map(results.map((r) => [String(r.email || '').toLowerCase(), r]));
  const dupes = aliases
    .map((a) => ({ ...a, ownerRow: byEmail.get(String(a.owner || '').toLowerCase()) || null }))
    .filter((a) => a.ownerRow);

  console.log(`ABSENT — nothing can be delivered to these (${absent.length}):`);
  for (const r of absent) {
    console.log(`  ${String(r.id).padEnd(6)} ${r.email.padEnd(38)} ${String(r.tickets).padStart(4)} tickets (${r.tp_born} TP-born)  created ${String(r.created_at).slice(0, 10)}${r.suppressed_at ? '  [already suppressed]' : ''}`);
  }

  console.log(`\nALIAS on a live mailbox — deliverable, do NOT suppress (${aliases.length}):`);
  for (const r of aliases) console.log(`  ${String(r.id).padEnd(6)} ${r.email.padEnd(38)} -> ${r.owner}`);

  if (dupes.length) {
    console.log(`\nMERGE CANDIDATES — an alias row AND the owner's own row exist (${dupes.length}):`);
    for (const r of dupes) {
      console.log(`  ${r.email} (id ${r.id}, ${r.tickets} tickets)  ==  ${r.ownerRow.email} (id ${r.ownerRow.id}, ${r.ownerRow.tickets} tickets)`);
    }
    console.log('  Not merged by this script: re-pointing tickets rewrites attribution, so it wants a human decision.');
  }

  if (unavailable.length) {
    console.log(`\nUNAVAILABLE — Graph could not answer, treated as unknown, NOT suppressed (${unavailable.length}):`);
    for (const r of unavailable) console.log(`  ${r.email} (http ${r.http})`);
  }

  if (jsonPath) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), tally, absent, aliases, dupes, unavailable }, null, 2));
    console.log(`\nWrote ${jsonPath}`);
  }

  // WHICH of the ABSENT rows may be suppressed?
  //
  // "Absent from Graph /users" is NOT the same as "fabricated". Three very
  // different populations land in that bucket:
  //
  //   * device and service senders — bgc-van-lidar1@ (628 tickets),
  //     rapidrecovery@ (626), the Synology NAS boxes. Real senders with no
  //     Entra user object.
  //   * shared mailboxes and distribution lists — hr@, accountspayable@,
  //     accountsreceivable@. Graph /users never returns these, and we cannot
  //     confirm them as groups either: this app registration has no
  //     Group.Read.All, so /groups answers 403.
  //   * former employees whose account was deleted after they left.
  //
  // None of those is a bug, and suppressing a 628-ticket device sender would
  // be an incident. So suppression keys off evidence WE own rather than an
  // absence in someone else's directory: a row is only auto-suppressed when
  // EVERY ticket on it was created inside Ticket Pulse (tp_born === tickets).
  // A device or shared mailbox files by email, so its tickets are
  // FreshService-born and it can never match this rule.
  const fabricated = absent.filter((r) => r.tickets > 0 && r.tp_born === r.tickets);
  const testish = absent.filter((r) => !fabricated.includes(r)
    && /^(test|qa|jdoe|dummy|sample|d-m-o-s-s)[._-]?/i.test(r.email.split('@')[0]));
  const leaveAlone = absent.filter((r) => !fabricated.includes(r) && !testish.includes(r));

  console.log(`\nFABRICATED BY TICKET PULSE — every ticket is TP-born (${fabricated.length}):`);
  for (const r of fabricated) console.log(`  ${String(r.id).padEnd(6)} ${r.email.padEnd(40)} ${r.tickets} ticket(s), all TP-born`);

  console.log(`\nLOOKS LIKE TEST DATA — no TP-born evidence, needs --include-test (${testish.length}):`);
  for (const r of testish) console.log(`  ${String(r.id).padEnd(6)} ${r.email.padEnd(40)} ${r.tickets} ticket(s)`);

  console.log(`\nLEFT ALONE — devices, shared mailboxes, former staff (${leaveAlone.length}):`);
  for (const r of leaveAlone) console.log(`  ${String(r.id).padEnd(6)} ${r.email.padEnd(40)} ${String(r.tickets).padStart(4)} ticket(s)`);
  console.log('  Not suppressed: absence from Graph /users does not make these wrong, and');
  console.log('  /groups cannot be read with this app registration (403 on Group.Read.All).');

  const includeTest = argv.includes('--include-test');
  const toSuppress = [...fabricated, ...(includeTest ? testish : [])].filter((r) => !r.suppressed_at);
  if (!APPLY) {
    console.log(`\nDRY RUN — --apply would suppress ${toSuppress.length} row(s)${includeTest ? ', including test data' : ''}.`);
    console.log('Add --include-test to also suppress the test-looking rows.');
  } else if (!toSuppress.length) {
    console.log('\nNothing to suppress.');
  } else {
    for (const r of toSuppress) {
      const reason = /^(test|qa|jdoe|dummy|sample)[._-]|(^|[._-])(test|qa)([._-]|$)/i.test(r.email.split('@')[0])
        ? 'qa_artifact' : 'entra_absent';
      await prisma.requester.update({
        where: { id: r.id },
        data: { suppressedAt: new Date(), suppressedReason: reason },
      });
      console.log(`  suppressed ${r.email} (${reason})`);
    }
    console.log(`\nSuppressed ${toSuppress.length}. They disappear from requester pickers immediately;`);
    console.log('their existing tickets keep their history, and the FreshService sync cannot undo this.');
  }
} finally {
  await prisma.$disconnect();
}
