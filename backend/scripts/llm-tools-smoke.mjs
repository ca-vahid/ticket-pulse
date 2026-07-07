/**
 * LLM evidence-tools smoke check (gap plan P5 rollout tooling). Probes the
 * admin surfaces an operator needs before/after enabling tool mode:
 *   1. catalog        — the tool list the UI offers
 *   2. policy         — current workspace policy (mode, includePrivateNotes)
 *   3. usage          — per-tool last-used/last-error indicators
 *   4. context-preview — the evidence bundle builder (mock-safe, no email)
 *
 * Usage:
 *   TP_BASE_URL=https://ticket-pulse-app.azurewebsites.net \
 *   TP_AUTH_TOKEN=<jwt> TP_WORKSPACE_ID=1 node scripts/llm-tools-smoke.mjs
 */
const BASE = (process.env.TP_BASE_URL || 'http://localhost:5180').replace(/\/+$/, '');
const TOKEN = process.env.TP_AUTH_TOKEN;
const WS = process.env.TP_WORKSPACE_ID || '1';
if (!TOKEN) { console.error('Set TP_AUTH_TOKEN (a signed-in admin JWT).'); process.exit(1); }

const headers = { Authorization: `Bearer ${TOKEN}`, 'X-Workspace-Id': WS, 'Content-Type': 'application/json' };
let failures = 0;

async function probe(label, path, options = {}) {
  try {
    const res = await fetch(`${BASE}/api/notification-workflows${path}`, { headers, ...options });
    const body = await res.json().catch(() => ({}));
    const ok = res.ok && body?.success !== false;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (HTTP ${res.status})`);
    if (!ok) { failures += 1; console.log('      ', JSON.stringify(body).slice(0, 200)); }
    return body?.data;
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${label}  (${err.message})`);
    return null;
  }
}

const catalog = await probe('tool catalog', '/llm-tools/catalog');
if (catalog && !catalog.length) { console.log('      catalog is empty — unexpected'); failures += 1; }

const policy = await probe('workspace policy', '/llm-tools/policy');
if (policy) {
  console.log(`       mode=${policy.mode} includePrivateNotes=${policy.includePrivateNotes} tools=${(policy.enabledTools || []).length}`);
}

const usage = await probe('tool usage indicators', '/llm-tools/usage');
if (usage) {
  const names = Object.keys(usage);
  console.log(`       ${names.length} tool(s) with recorded usage${names.length ? `: ${names.join(', ')}` : ''}`);
}

await probe('context preview (mock-safe)', '/llm-tools/context-preview', {
  method: 'POST',
  body: JSON.stringify({}),
});

console.log(failures === 0 ? '\nAll probes passed.' : `\n${failures} probe(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
