#!/usr/bin/env node
/**
 * Issue OAuth 2.0 client-credentials for the Assetron approval integration.
 *
 * The Settings UI can only issue credentials for the workspace the admin is
 * currently in, and the sandbox workspace is deliberately inactive (so no
 * scheduler touches it), which keeps it out of the workspace picker. This
 * script is how QA issues both the sandbox and the production credential.
 *
 * Least privilege by design: `approvals:read` ONLY. That scope reaches exactly
 * two endpoints — GET /tickets/{id}/approval and GET /tickets/{id}/approvals.
 * It cannot read ticket bodies, conversations or attachments, which is also
 * what Assetron asked for ("please do not return more than the above").
 *
 * The client secret is printed ONCE and never stored in clear anywhere. Hand it
 * over through a secret channel — never in a document, a ticket or email.
 *
 *   node scripts/assetron-issue-credentials.mjs --workspace 6                  # dry run
 *   node scripts/assetron-issue-credentials.mjs --workspace 6 --apply
 *   node scripts/assetron-issue-credentials.mjs --workspace 1 --apply --expires 365
 *   node scripts/assetron-issue-credentials.mjs --list --workspace 6
 *   node scripts/assetron-issue-credentials.mjs --revoke <clientId> --apply
 */
import { PrismaClient } from '@prisma/client';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const after = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const APPLY = has('--apply');
const workspaceId = Number(after('--workspace'));
const expiresInDays = after('--expires') ? Number(after('--expires')) : null;

const prisma = new PrismaClient();
const SCOPES = ['approvals:read'];

async function main() {
  const { default: oauthClientService } = await import('../src/services/oauthClientService.js');

  if (has('--list')) {
    const list = await oauthClientService.list(workspaceId);
    if (!list.length) { console.log(`No OAuth clients in workspace ${workspaceId}.`); return; }
    for (const c of list) {
      console.log(`${c.clientId}  ${c.name.padEnd(28)} scopes=${(c.scopes || []).join(',')}  enabled=${c.isEnabled}  lastUsed=${c.lastUsedAt || 'never'}`);
    }
    return;
  }

  if (has('--revoke')) {
    const clientId = after('--revoke');
    console.log(APPLY ? `Revoking ${clientId}...` : `DRY RUN — would revoke ${clientId}`);
    if (!APPLY) return;
    await oauthClientService.revoke(workspaceId, clientId, { email: 'assetron-integration-script' });
    console.log('Revoked. Assetron will start receiving 401 invalid_token immediately.');
    return;
  }

  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, isActive: true } });
  if (!ws) { console.error(`No workspace ${workspaceId}.`); process.exitCode = 1; return; }

  const name = `Assetron (${ws.isActive ? 'production' : 'sandbox'})`;
  console.log(`Workspace ${ws.id} "${ws.name}"${ws.isActive ? '' : ' [sandbox — inactive]'}`);
  console.log(`Client name: ${name}`);
  console.log(`Scopes:      ${SCOPES.join(', ')}`);
  console.log(`Expires:     ${expiresInDays ? `${expiresInDays} days` : 'never (rotate on a schedule instead)'}`);

  if (!APPLY) { console.log('\nDRY RUN — pass --apply to issue.'); return; }

  const client = await oauthClientService.create(workspaceId, { name, scopes: SCOPES, expiresInDays }, { email: 'assetron-integration-script' });
  console.log('\n─────────── HAND THESE OVER SECURELY — THE SECRET IS SHOWN ONCE ───────────');
  console.log('  token_url:     https://ticket-pulse-app.azurewebsites.net/api/v1/oauth/token');
  console.log('  grant_type:    client_credentials');
  console.log(`  client_id:     ${client.clientId}`);
  console.log(`  client_secret: ${client.clientSecret || client.secret}`);
  console.log('───────────────────────────────────────────────────────────────────────────');
  console.log('\nIf this secret is ever exposed, revoke it with --revoke <client_id> --apply.');
}

try { await main(); } finally { await prisma.$disconnect(); }
