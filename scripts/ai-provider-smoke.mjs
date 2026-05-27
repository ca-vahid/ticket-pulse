#!/usr/bin/env node

const baseUrl = (process.env.TICKET_PULSE_API_URL || 'http://localhost:3000/api').replace(/\/$/, '');
const token = process.env.TICKET_PULSE_AUTH_TOKEN || '';
const workspaceId = process.env.TICKET_PULSE_WORKSPACE_ID || '1';
const operation = process.env.TICKET_PULSE_AI_OPERATION || 'assignment_pipeline';

const tests = [
  { provider: 'anthropic', model: process.env.TICKET_PULSE_ANTHROPIC_MODEL || 'claude-sonnet-4-6' },
  { provider: 'openai', model: process.env.TICKET_PULSE_OPENAI_MODEL || 'gpt-5.5' },
];

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Workspace-Id': workspaceId,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
}

for (const test of tests) {
  const result = await postJson('/ai-providers/test', { operation, ...test });
  if (!result.ok) {
    console.error(`${test.provider}/${test.model} failed (${result.status})`, result.payload);
    process.exitCode = 1;
  } else {
    console.log(`${test.provider}/${test.model} ok`, result.payload.data || result.payload);
  }
}
