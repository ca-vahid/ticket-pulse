#!/usr/bin/env node
/**
 * Auto-help P0 (plans/AUTO_HELP_PLAN.md): seed three DISABLED shadow-mode
 * playbooks for workspace 1 (IT). Idempotent by (workspace, name): an
 * existing playbook of the same name is left untouched.
 *
 * Categories are resolved by name at run time and printed; anything not found
 * is left null (a playbook without a category never matches and cannot be
 * switched on until someone picks one in Knowledge → Playbooks).
 *
 * Usage:  node scripts/seed-auto-help-playbooks.mjs [--apply]
 * Default = dry-run against whatever DATABASE_URL points at (dev). Uses a
 * single connection (connection_limit=1).
 */
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const WORKSPACE_ID = 1;

function withConnectionLimit(url) {
  if (!url) return url;
  if (/[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`;
}
process.env.DATABASE_URL = withConnectionLimit(process.env.DATABASE_URL);
const prisma = new PrismaClient();
console.log(`Auto-help playbook seed — workspace ${WORKSPACE_ID} — ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

const FOLLOW_UP = {
  nudgeAfterBusinessDays: 2,
  closeAfterBusinessDays: 2,
  // {{days}} is filled from closeAfterBusinessDays when the check-in is written.
  nudgeText: "Hope that sorted it out. If we don't hear back, we'll close this ticket in {{days}} — just reply if you still need a hand.",
  onSilence: 'resolve',
};
const KB_ALL = { mode: 'all', tags: [], includeVerifiedSolutions: true };

// category: candidate names for the top-level category; subcategories: candidate names (any that exist are used).
const PLAYBOOKS = [
  {
    name: 'Software installs (Company Portal)',
    category: ['Software & Apps', 'Software and Apps', 'Software', 'Applications'],
    subcategories: ['Installation', 'Install', 'Software Installation', 'Software Request', 'New Software'],
    match: {
      keywords: ['install', 'installation', 'download', 'set up', 'setup', 'company portal', 'need access to'],
      excludeKeywords: ['license', 'licence', 'purchase', 'quote', 'renewal', 'invoice', 'error', 'crash', 'not working', 'uninstall'],
    },
    allowedTools: ['search_knowledge', 'get_article', 'find_similar_resolved_tickets', 'get_ticket_details'],
    minConfidence: 0.8,
    priority: 120,
    instructions: [
      'Use this playbook when someone asks to have an application installed on their company computer.',
      '',
      'What a good answer looks like:',
      '- If a knowledge article or a resolved ticket shows the app is available in Company Portal, tell them to install it themselves:',
      '  1. Open Company Portal from the Start menu (search "Company Portal").',
      '  2. Search for the app by name.',
      '  3. Select it and choose Install. It can take a few minutes; keep the computer on and connected.',
      '- Name the exact app as it appears in the source. If the source gives a different edition or version, use the source\'s name.',
      '- If the source says the app needs a licence or manager approval first, say so plainly and stop there — do not describe how to buy it.',
      '',
      'Say it is not answerable when:',
      '- No source confirms this app is in Company Portal.',
      '- The request is really about a licence, a purchase, a renewal, an error or a crash.',
      '- They ask for admin rights or for software on a personal device.',
      '',
      'Keep it to a short intro line and the steps. No guesses about when IT will get to it.',
    ].join('\n'),
  },
  {
    name: 'Mobile & roaming',
    category: ['Mobile', 'Mobile Devices', 'Phones', 'Mobile & Phones', 'Telecom'],
    subcategories: ['Roaming', 'Travel', 'International Roaming', 'Mobile Plan', 'Travel Plan'],
    match: {
      keywords: ['roaming', 'travel', 'travelling', 'traveling', 'abroad', 'international', 'overseas', 'trip', 'data plan', 'esim'],
      excludeKeywords: ['lost', 'stolen', 'broken', 'cracked', 'new phone', 'replacement'],
    },
    allowedTools: ['search_knowledge', 'get_article', 'get_ticket_details', 'get_requester_profile'],
    minConfidence: 0.8,
    priority: 110,
    instructions: [
      'Use this playbook when someone is travelling and asks about using their company phone abroad (roaming, travel data plans).',
      '',
      'What a good answer looks like:',
      '- Use get_requester_profile to see which country and office they are in, and answer for THAT carrier and plan as described in the knowledge articles.',
      '- Explain what they need to do before the trip, in steps (for example: how the travel plan is added, when to switch data roaming on, what to do on arrival).',
      '- Mention any cost or approval rule exactly as the source states it. Never quote prices the source does not give.',
      '',
      'Say it is not answerable when:',
      '- No source covers their country or carrier.',
      '- The phone is lost, stolen or broken — that needs a person.',
      '- They need a new phone or a SIM swap.',
      '',
      'Short and practical. No promises about when a plan will be active unless the source says so.',
    ].join('\n'),
  },
  {
    name: 'Password, MFA & access',
    category: ['Accounts & Access', 'Account & Access', 'Access', 'Identity & Access', 'Accounts'],
    subcategories: ['Password', 'Password Reset', 'MFA', 'Multi-factor Authentication', 'Authenticator', 'Sign-in'],
    match: {
      keywords: ['password', 'reset', 'mfa', 'authenticator', 'multi-factor', '2fa', 'locked out', 'sign in', 'sign-in', 'login', 'log in'],
      excludeKeywords: ['phishing', 'suspicious', 'hacked', 'compromised', 'breach', 'new hire', 'terminated', 'departure'],
    },
    allowedTools: ['search_knowledge', 'get_article', 'get_ticket_details'],
    minConfidence: 0.85,
    priority: 130,
    instructions: [
      'Use this playbook for self-service password resets and multi-factor (MFA / Authenticator) set-up questions.',
      '',
      'What a good answer looks like:',
      '- Point them to the self-service path the knowledge articles describe (for example the self-service password reset page or re-registering the Authenticator app), as numbered steps.',
      '- Use the page names and menu labels exactly as the source gives them. Only include a link when the source contains it.',
      '- Remind them never to share a code or password with anyone, including IT.',
      '',
      'Say it is not answerable when:',
      '- There is any hint of a security problem: phishing, a suspicious sign-in, a hacked or compromised account.',
      '- They are fully locked out and self-service cannot work (no phone, no registered method) — a person must verify them.',
      '- It is about someone else\'s account, a new hire, or a departure.',
      '- No source describes the self-service steps.',
      '',
      'Never ask for or mention passwords or codes in the answer.',
    ].join('\n'),
  },
];

function pick(rows, names) {
  const lower = names.map((n) => n.toLowerCase());
  for (const n of lower) {
    const exact = rows.find((r) => r.name.toLowerCase() === n);
    if (exact) return exact;
  }
  return rows.find((r) => lower.some((n) => r.name.toLowerCase().includes(n))) || null;
}

async function main() {
  const cats = await prisma.competencyCategory.findMany({
    where: { workspaceId: WORKSPACE_ID, isActive: true },
    select: { id: true, name: true, parentId: true },
  });
  const tops = cats.filter((c) => c.parentId === null);
  let created = 0;
  for (const pb of PLAYBOOKS) {
    const top = pick(tops, pb.category);
    const subs = top ? cats.filter((c) => c.parentId === top.id) : [];
    const subIds = [...new Set(pb.subcategories.map((n) => pick(subs, [n])).filter(Boolean).map((s) => s.id))];
    console.log(`\n• ${pb.name}`);
    console.log(`  category: ${top ? `${top.name} (#${top.id})` : 'NOT FOUND — left empty'}`);
    console.log(`  subcategories: ${subIds.length ? subs.filter((s) => subIds.includes(s.id)).map((s) => `${s.name} (#${s.id})`).join(', ') : 'none found — covers the whole category'}`);

    const existing = await prisma.autoHelpPlaybook.findFirst({ where: { workspaceId: WORKSPACE_ID, name: pb.name }, select: { id: true } });
    if (existing) {
      console.log(`  exists as #${existing.id} — left untouched`);
      continue;
    }
    if (!APPLY) {
      console.log('  would create (disabled, shadow)');
      continue;
    }
    const row = await prisma.autoHelpPlaybook.create({
      data: {
        workspaceId: WORKSPACE_ID,
        name: pb.name,
        enabled: false,
        mode: 'shadow',
        categoryId: top?.id ?? null,
        subcategoryIds: subIds,
        match: pb.match,
        instructions: pb.instructions,
        // Off: answers must cite an article or verified solution. An admin can opt a
        // playbook in (Knowledge → Playbooks) once its instructions are a vetted how-to.
        instructionsAreSource: false,
        allowedTools: pb.allowedTools,
        kbScope: KB_ALL,
        minConfidence: pb.minConfidence,
        followUp: FOLLOW_UP,
        onHelp: 'assign_normally',
        priority: pb.priority,
        version: 1,
        createdBy: 'seed-auto-help-playbooks',
        updatedBy: 'seed-auto-help-playbooks',
      },
    });
    created += 1;
    console.log(`  created #${row.id} (disabled, shadow)`);
  }
  console.log(`\n${APPLY ? `Created ${created}` : 'Dry run — nothing written'}.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
