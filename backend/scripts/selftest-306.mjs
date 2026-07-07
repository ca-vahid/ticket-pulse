/**
 * v3.0.6-preview dev self-test (gap plan 2 Phase 6).
 * Guardrails: dev only (localhost:3000), throwaway TP tickets with requester
 * selftest@invalid.local + notifyRequester:false + runAiTriage:false, webhook
 * target is example.com (delivery just fails — nothing real is called),
 * everything created is deleted at the end. No FreshService writes (dev
 * mirror disabled), no outbound email (dev SendGrid empty).
 *
 * Run from backend/: node scripts/selftest-306.mjs
 */
const BASE = 'http://127.0.0.1:3000/api';
let token = null;
let workspaceId = null;
const results = [];
const made = { tickets: [], webhooks: [] };

function ok(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(workspaceId ? { 'X-Workspace-Id': String(workspaceId) } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

// ---------- auth ----------
{
  const login = await api('POST', '/auth/dev-login', {});
  token = login.json?.authToken;
  // The IT workspace has the ticket volume; dev-login may default elsewhere.
  const wss = login.json?.availableWorkspaces || [];
  workspaceId = (wss.find((w) => /it/i.test(w.name) && !/account/i.test(w.name)) || wss[0])?.id
    || login.json?.user?.selectedWorkspaceId || 1;
  ok('dev-login', !!token, `workspace ${workspaceId}`);
  if (!token) process.exit(1);
}

// ---------- presence ----------
{
  const snap = await api('GET', '/tickets/presence');
  ok('presence snapshot (empty object)', snap.status === 200 && typeof snap.json?.data === 'object');

  const list = await api('GET', '/tickets?pageSize=1');
  const anyTicket = list.json?.data?.items?.[0];
  if (anyTicket) {
    const beat = await api('POST', `/tickets/${anyTicket.id}/presence`, {});
    ok('presence heartbeat', beat.status === 200 && Array.isArray(beat.json?.data?.viewers));
    const snap2 = await api('GET', '/tickets/presence');
    ok('presence snapshot shows the viewer', Array.isArray(snap2.json?.data?.[anyTicket.id]) && snap2.json.data[anyTicket.id].length === 1);
    const leave = await api('POST', `/tickets/${anyTicket.id}/presence`, { leaving: true });
    const snap3 = await api('GET', '/tickets/presence');
    ok('presence leave clears', leave.status === 200 && !snap3.json?.data?.[anyTicket.id]);
  }
}

// ---------- webhooks ----------
{
  const create = await api('POST', '/tickets/webhook-subscriptions', {
    url: 'https://example.com/tp-selftest-hook',
    events: ['ticket.created', 'ticket.tags_changed'],
  });
  const sub = create.json?.data;
  ok('webhook create returns whsec_ secret once', create.status === 201 || create.status === 200 ? String(sub?.secret || '').startsWith('whsec_') : false);
  if (sub?.id) {
    made.webhooks.push(sub.id);
    const listed = await api('GET', '/tickets/webhook-subscriptions');
    const row = (listed.json?.data || []).find((w) => w.id === sub.id);
    ok('webhook list hides the secret', row && !row.secret);
    const ping = await api('POST', `/tickets/webhook-subscriptions/${sub.id}/test`);
    ok('webhook test ping runs (example.com does not 2xx — failure recorded)', ping.status === 200 && ping.json?.data?.ok === false);
    const after = await api('GET', '/tickets/webhook-subscriptions');
    const row2 = (after.json?.data || []).find((w) => w.id === sub.id);
    ok('failure accounting incremented', (row2?.failureCount || 0) >= 1);
    const ssrf = await api('POST', '/tickets/webhook-subscriptions', { url: 'http://169.254.169.254/latest', events: ['ticket.created'] });
    ok('SSRF-unsafe webhook URL rejected', ssrf.status >= 400);
  }
}

// ---------- embeddings / similar-by-content (2 tiny OpenAI calls) ----------
{
  const mk = (subject, description) => api('POST', '/tickets', {
    subject,
    description: `<p>${description}</p>`,
    requesterEmail: 'selftest@invalid.local',
    requesterName: 'Self Test',
    priority: 3,
    notifyRequester: false,
    runAiTriage: false,
  });
  const a = await mk('SELFTEST VPN tunnel keeps dropping on laptop', 'The corporate VPN disconnects every ten minutes on my laptop since the update.');
  const b = await mk('SELFTEST VPN connection drops constantly', 'My VPN keeps disconnecting again and again on the notebook after the recent update.');
  const ta = a.json?.data; const tb = b.json?.data;
  ok('throwaway TP tickets created', !!ta?.id && !!tb?.id, `${ta?.displayRef}, ${tb?.displayRef}`);
  if (ta?.id) made.tickets.push(ta.id);
  if (tb?.id) made.tickets.push(tb.id);

  if (ta?.id && tb?.id) {
    await new Promise((r) => setTimeout(r, 6000)); // fire-and-forget embeddings
    const rel = await api('GET', `/tickets/${ta.id}/related`);
    const sim = rel.json?.data?.similarByContent || [];
    ok('related payload has similarByContent[]', Array.isArray(rel.json?.data?.similarByContent));
    ok('sibling found similar by content', sim.some((s) => s.id === tb.id), sim.length ? `top ${Math.round((sim[0]?.similarity || 0) * 100)}%` : 'no matches (embedding may still be in flight)');
  }
}

// ---------- sentiment (1 Haiku call, in-process via the service) ----------
{
  const { default: ticketSentimentService } = await import('../src/services/ticketSentimentService.js');
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const target = made.tickets[0];
  if (target) {
    const sentiment = await ticketSentimentService.refreshSentiment(target, workspaceId);
    const row = await prisma.ticket.findUnique({ where: { id: target }, select: { sentiment: true, sentimentComputedAt: true } });
    ok('sentiment classified + stored', !!sentiment && row?.sentiment === sentiment && !!row?.sentimentComputedAt, `= ${sentiment}`);
    const detail = await api('GET', `/tickets/${target}?reconcile=0`);
    ok('sentiment flows to the ticket payload', detail.json?.data?.sentiment === sentiment);
  }
  await prisma.$disconnect();
}

// ---------- cleanup ----------
for (const id of made.webhooks) {
  await api('DELETE', `/tickets/webhook-subscriptions/${id}`);
}
for (const id of made.tickets) {
  await api('DELETE', `/tickets/${id}`);
}
console.log(`\nCleanup: removed ${made.webhooks.length} webhook(s), ${made.tickets.length} throwaway ticket(s).`);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILURES: ${failed.map((f) => f.name).join('; ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
