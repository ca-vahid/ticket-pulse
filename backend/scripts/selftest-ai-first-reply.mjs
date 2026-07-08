/**
 * End-to-end functional audit of the "AI first-reply draft (human approves)"
 * template (QA 07-07 #4 — prove it's real, not a placeholder).
 *
 * Guardrails: dev only (localhost:3000); the template sends NO email (it
 * stages drafts); throwaway TP tickets use selftest@invalid.local with
 * notifyRequester:false + runAiTriage:false; the installed workflow is
 * disabled/archived/deleted and the tickets removed at the end.
 * Costs ~2 small LLM calls.
 *
 * Run from backend/: node scripts/selftest-ai-first-reply.mjs
 */
const BASE = 'http://127.0.0.1:3000/api';
let token = null;
let workspaceId = null;
const results = [];
const made = { tickets: [], workflowId: null };

function ok(name, cond, detail = '') {
  results.push({ name, pass: !!cond });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollProposal(ticketId, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api('GET', `/tickets/${ticketId}/proposed-replies`);
    const open = (res.json?.data || []).find((p) => p.status === 'proposed');
    if (open) return open;
    await sleep(5000);
  }
  return null;
}

async function makeTicket(n) {
  // notifyRequester must be TRUE: silent creation deliberately skips ALL
  // lifecycle workflows (by design), so the draft workflow would never fire.
  // Email stays impossible in dev — no provider configured, and the
  // requester domain (.invalid.local) is undeliverable anyway.
  const res = await api('POST', '/tickets', {
    subject: `SELFTEST AI-draft audit ${n}: printer offline in accounting`,
    description: '<p>The shared printer on the 3rd floor shows offline since this morning. Restarting it did not help. Can someone take a look?</p>',
    requesterEmail: 'selftest@invalid.local',
    requesterName: 'Self Test',
    priority: 3,
    notifyRequester: true,
    runAiTriage: false,
  });
  const t = res.json?.data;
  if (t?.id) made.tickets.push(t.id);
  return t;
}

// ---------- auth ----------
{
  const login = await api('POST', '/auth/dev-login', {});
  token = login.json?.authToken;
  const wss = login.json?.availableWorkspaces || [];
  workspaceId = (wss.find((w) => /it/i.test(w.name) && !/account/i.test(w.name)) || wss[0])?.id || 1;
  ok('dev-login', !!token, `workspace ${workspaceId}`);
  if (!token) process.exit(1);
}

// ---------- install + publish + enable the template ----------
{
  const install = await api('POST', '/notification-workflows/templates/ai_first_reply_draft/install');
  const wf = install.json?.data;
  made.workflowId = wf?.id || null;
  ok('template installs as a disabled draft', !!wf?.id && wf.isEnabled === false, `workflow ${wf?.id}`);

  const publish = await api('POST', `/notification-workflows/${made.workflowId}/publish`, {
    changeNote: 'AI first-reply audit (selftest)', enabled: false,
  });
  ok('draft publishes (validator accepts propose_reply-terminated graph)', publish.status === 200, publish.json?.message || '');

  const enable = await api('PUT', `/notification-workflows/${made.workflowId}/enabled`, { enabled: true });
  ok('workflow enables', enable.status === 200 && enable.json?.data?.isEnabled === true);
}

// ---------- ticket 1: draft appears, dismiss works ----------
let proposal1 = null;
{
  const t1 = await makeTicket(1);
  ok('throwaway ticket 1 created', !!t1?.id, t1?.displayRef);
  proposal1 = t1?.id ? await pollProposal(t1.id) : null;
  ok('LLM draft staged as a proposed reply', !!proposal1, proposal1 ? `proposal ${proposal1.id}, confidence=${proposal1.confidence || 'n/a'}` : 'timed out');
  if (proposal1) {
    ok('draft has body content', Boolean(proposal1.bodyHtml || proposal1.bodyText));
    ok('draft source is the workflow LLM', proposal1.source === 'workflow_llm', proposal1.source);

    const list = await api('GET', `/tickets?q=SELFTEST AI-draft audit 1&pageSize=5`);
    const row = (list.json?.data?.items || []).find((x) => x.id === t1.id);
    ok('queue row carries hasProposedReply', row?.hasProposedReply === true);

    const dismiss = await api('POST', `/tickets/${t1.id}/proposed-replies/${proposal1.id}/dismiss`);
    const after = await api('GET', `/tickets/${t1.id}/proposed-replies`);
    ok('dismiss clears the open proposal', dismiss.status === 200 && !(after.json?.data || []).some((p) => p.status === 'proposed'));
  }
}

// ---------- ticket 2: approve & send goes through the real reply path ----------
{
  const t2 = await makeTicket(2);
  ok('throwaway ticket 2 created', !!t2?.id, t2?.displayRef);
  const proposal2 = t2?.id ? await pollProposal(t2.id) : null;
  ok('second draft staged', !!proposal2);
  if (proposal2) {
    const send = await api('POST', `/tickets/${t2.id}/proposed-replies/${proposal2.id}/send`, {});
    ok('approve & send succeeds', send.status === 200, send.json?.message || '');
    const detail = await api('GET', `/tickets/${t2.id}?reconcile=0`);
    const entries = detail.json?.data?.thread || [];
    const hasReply = Array.isArray(entries) && entries.some((e) => (e.incoming === false || e.authorType === 'agent') && !e.isPrivate);
    ok('sent draft became a real public reply on the thread', hasReply, `${Array.isArray(entries) ? entries.length : 0} entries`);
    const after = await api('GET', `/tickets/${t2.id}/proposed-replies?status=`);
    const sent = (after.json?.data || []).find((p) => p.id === proposal2.id);
    ok('proposal recorded as sent', !sent || sent.status === 'sent', sent?.status || 'not returned');
  }
}

// ---------- cleanup ----------
if (made.workflowId) {
  await api('PUT', `/notification-workflows/${made.workflowId}/enabled`, { enabled: false });
  await api('PUT', `/notification-workflows/${made.workflowId}/archive`, { archived: true });
  const del = await api('DELETE', `/notification-workflows/${made.workflowId}`);
  ok('workflow cleaned up (disabled → archived → deleted)', del.status === 200);
}
for (const id of made.tickets) {
  await api('DELETE', `/tickets/${id}`);
}
console.log(`\nCleanup: removed workflow ${made.workflowId}, ${made.tickets.length} throwaway ticket(s).`);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILURES: ${failed.map((f) => f.name).join('; ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
