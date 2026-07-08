/**
 * v3.0.10-preview dev self-test (Features 07-07 wrap). Guardrails: dev only,
 * throwaway TP tickets (selftest@invalid.local, silent creation, no AI
 * triage), workflows created disabled and deleted afterwards, everything
 * cleaned up. The AI first-reply chain has its own deeper audit
 * (selftest-ai-first-reply.mjs, 16/16).
 *
 * Run from backend/: node scripts/selftest-0710.mjs
 */
const BASE = 'http://127.0.0.1:3000/api';
let token = null;
let workspaceId = null;
const results = [];
const made = { tickets: [], workflows: [] };

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

async function makeTicket(n) {
  const res = await api('POST', '/tickets', {
    subject: `SELFTEST 0710 wrap ${n}`,
    description: '<p>Self-test ticket — safe to delete.</p>',
    requesterEmail: 'selftest@invalid.local',
    requesterName: 'Self Test',
    priority: 3,
    notifyRequester: false,
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

// ---------- item 1: arrival channel persists + labels ----------
{
  const t = await makeTicket('source');
  const detail = await api('GET', `/tickets/${t.id}?reconcile=0`);
  ok('app-created ticket carries source=Agent (103)', detail.json?.data?.source === 103, `source=${detail.json?.data?.source}`);
  const meta = await api('GET', '/tickets/meta');
  const agent = (meta.json?.data?.sources || []).find((s) => s.value === 103);
  ok('queue meta labels the Agent channel', agent?.label === 'Agent', JSON.stringify(agent || null));
}

// ---------- item 6: link by visible refs ----------
{
  const a = await makeTicket('link-a');
  const b = await makeTicket('link-b');
  const link = await api('POST', `/tickets/${a.id}/links`, { relatedTicketRef: b.displayRef, kind: 'related_to' });
  ok('link by TP-#### display ref works', link.status === 201 && link.json?.data?.resolvedTarget?.id === b.id, `${a.displayRef} → ${b.displayRef}`);
  const badRef = await api('POST', `/tickets/${a.id}/links`, { relatedTicketRef: 'TP-999999', kind: 'related_to' });
  ok('unknown ref error names the ref', badRef.status === 404 && /TP-999999/.test(badRef.json?.message || ''), badRef.json?.message);
}

// ---------- item 5: template → stage-for-approval graph publishes ----------
{
  const definition = {
    version: 2,
    metadata: {},
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggerType: 'ticket.created' } },
      { id: 'tmpl', type: 'template_render', position: { x: 240, y: 0 }, data: { subject: 'Re: {{ ticket.subject }}', html: '<p>Thanks — we are on it.</p>' } },
      { id: 'stage', type: 'propose_reply', position: { x: 480, y: 0 }, data: { label: 'Stage for approval' } },
      { id: 'end', type: 'stop', position: { x: 720, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'tmpl' },
      { id: 'e2', source: 'tmpl', target: 'stage' },
      { id: 'e3', source: 'stage', target: 'end' },
    ],
  };
  const created = await api('POST', '/notification-workflows', {
    triggerType: 'ticket.created', name: 'SELFTEST template staging', definition, routingMode: 'additive',
  });
  const wf = created.json?.data;
  if (wf?.id) made.workflows.push(wf.id);
  ok('template→stage-for-approval graph saves', created.status === 201, created.json?.message);
  const pub = await api('POST', `/notification-workflows/${wf?.id}/publish`, { changeNote: 'selftest', enabled: false });
  ok('…and publishes (QA #5 fixed)', pub.status === 200, pub.json?.message || (pub.json?.details || []).join('; '));
}

// ---------- item 3: manual sub-workflows + editable trigger ----------
{
  const sub = await api('POST', '/notification-workflows', { triggerType: 'manual', name: 'SELFTEST sub-workflow' });
  const wf = sub.json?.data;
  if (wf?.id) made.workflows.push(wf.id);
  ok('manual (sub-workflow) trigger creates a disabled draft', sub.status === 201 && wf?.triggerType === 'manual' && wf?.isEnabled === false);

  const moved = await api('PUT', `/notification-workflows/${wf?.id}/trigger`, { triggerType: 'ticket.note_added' });
  const trig = (moved.json?.data?.draftDefinition?.nodes || []).find((n) => n.type === 'trigger');
  ok('trigger is editable (manual → note_added, node retargeted)', moved.status === 200 && moved.json?.data?.triggerType === 'ticket.note_added' && trig?.data?.triggerType === 'ticket.note_added');

  const bad = await api('PUT', `/notification-workflows/${wf?.id}/trigger`, { triggerType: 'ticket.exploded' });
  ok('unknown trigger rejected', bad.status >= 400);
}

// ---------- cleanup ----------
for (const id of made.workflows) {
  await api('PUT', `/notification-workflows/${id}/enabled`, { enabled: false });
  await api('PUT', `/notification-workflows/${id}/archive`, { archived: true });
  await api('DELETE', `/notification-workflows/${id}`);
}
for (const id of made.tickets) {
  await api('DELETE', `/tickets/${id}`);
}
console.log(`\nCleanup: removed ${made.workflows.length} workflow(s), ${made.tickets.length} ticket(s).`);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILURES: ${failed.map((f) => f.name).join('; ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
