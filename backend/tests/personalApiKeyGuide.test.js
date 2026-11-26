import { readFileSync } from 'node:fs';
import { buildPersonalKeyGuide, keptTags, GUIDE_FILENAME } from '../src/services/personalApiKeyGuide.js';
import { resolveApiPublicBase } from '../src/utils/apiPublicBase.js';

/**
 * Personal API keys (4.4.05), owner change 3: the guide a person feeds to
 * their AI assistant. Every route it names must be a real /api/v1 route, it
 * must carry the rules (auth, limit, no undo, idempotency, body format, no
 * signature, warnings, FreshService rules, errors), and never a secret.
 */
const ROUTES = [...readFileSync(new URL('../src/routes/apiV1.routes.js', import.meta.url), 'utf8')
  .matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)]
  .map(([, method, path]) => `${method.toUpperCase()} ${path}`);

const base = {
  baseUrl: 'https://tickets.example.com',
  workspace: { id: 1, name: 'IT' },
  person: { name: 'Dana Fox', email: 'dana.fox@example.com' },
  abilities: ['read', 'reply', 'update', 'tasks'],
  scopes: ['tickets:read', 'conversations:write'],
  rateLimit: 60,
  key: { name: 'Laptop script', prefix: 'tpu_AbCdEfGh', expiresAt: '2027-02-20T00:00:00.000Z' },
};

/** "curl -X POST .../api/v1/tickets/TP-1234/replies" → "POST /tickets/:id/replies" */
function calls(markdown) {
  const out = [];
  for (const line of markdown.split('\n')) {
    for (const m of line.matchAll(/(?:curl(?: -X (GET|POST|PUT|PATCH|DELETE))?\s+"|`(GET|POST|PUT|PATCH|DELETE) )https:\/\/tickets\.example\.com\/api\/v1(\/[^"?`\s]*)/g)) {
      const method = m[1] || m[2] || 'GET';
      const path = m[3]
        .replace(/\/tickets\/TP-1234/, '/tickets/:id')
        .replace(/\/tasks\/\d+/, '/tasks/:taskId')
        .replace(/\/tags\/[a-z]+$/, '/tags/:tag');
      out.push(`${method} ${path}`);
    }
  }
  return [...new Set(out)];
}

describe('the guide names only real v1 routes', () => {
  const md = buildPersonalKeyGuide(base);

  test('every curl and inline call is a route apiV1.routes.js defines', () => {
    const named = calls(md);
    expect(named.length).toBeGreaterThanOrEqual(10);
    for (const c of named) expect(ROUTES).toContain(c);
    for (const needed of ['GET /me', 'GET /me/guide', 'GET /tickets', 'GET /tickets/:id', 'GET /tickets/:id/conversations', 'POST /tickets/:id/replies', 'POST /tickets/:id/notes', 'PATCH /tickets/:id', 'POST /tickets/:id/tasks']) {
      expect(named).toContain(needed);
    }
  });

  test('carries the rules an assistant needs', () => {
    expect(md).toContain('Base URL: `https://tickets.example.com/api/v1`');
    expect(md).toContain('Authorization: Bearer <YOUR_KEY>');
    expect(md).toMatch(/60 requests a minute/);
    expect(md).toMatch(/No undo/);
    expect(md).toMatch(/Idempotency-Key/);
    expect(md).toMatch(/No Markdown/);
    expect(md).toMatch(/Do not add a signature, a sign-off name, or the earlier e-mails/);
    expect(md).toMatch(/A short greeting/);
    for (const w of ['signature_removed', 'requester_unattended', 'requester_automated']) expect(md).toContain(w);
    expect(md).toMatch(/## FreshService tickets/);
    for (const s of ['401', '403 `read_only_role`', '409', '422', '429']) expect(md).toContain(s);
    expect(md).toContain('dana.fox@example.com');
    expect(md).toContain('Scopes in force today: `tickets:read`, `conversations:write`');
    expect(md).toContain('"Laptop script" (`tpu_AbCdEfGh…`)');
    // review #9: plain, accurate wording
    expect(md).toMatch(/can't create new tickets/);
    expect(md).not.toMatch(/never creates? a ticket/i);
  });

  test('lists the HTML tags the sanitizer keeps and explains line breaks', () => {
    const { recommended } = keptTags();
    expect(recommended).toEqual(expect.arrayContaining(['p', 'br', 'b', 'a', 'ul', 'li']));
    for (const t of recommended) expect(md).toContain(`\`<${t}>\``);
    expect(md).toMatch(/each line break is kept as a line break/);
  });

  test('the example bodies hold no signature and no secret', () => {
    expect(md).not.toMatch(/tpu_[A-Za-z0-9_-]{20,}/);
    expect(md).not.toMatch(/Dana Fox<\/|Regards,|Kind regards/);
    expect(GUIDE_FILENAME).toBe('ticket-pulse-api-guide.md');
  });
});

describe('the guide follows the key', () => {
  test('a read-only key describes reads only and says writes are refused', () => {
    const md = buildPersonalKeyGuide({ ...base, abilities: ['read'], scopes: ['tickets:read'] });
    expect(md).not.toContain('/replies');
    expect(md).not.toContain('-X PATCH');
    expect(md).toMatch(/No: reply to requesters and add private notes\. Calls for it get `403`/);
  });

  test('a person who is read-only today gets reads only whatever the key says', () => {
    const md = buildPersonalKeyGuide({ ...base, readOnly: true });
    expect(md).not.toContain('/replies');
    expect(md).toMatch(/read-only right now/);
  });
});

// 4.4.24: the guide's base came from PUBLIC_APP_URL, the web host, which
// answers /api/v1 with an HTML 404. The routes now pass resolveApiPublicBase.
describe('the guide names the API host', () => {
  const WEB = 'https://tickets.example.com';
  const API_HOSTS = ['api.ticketpulse.bgcsi.com', 'api.ticketpulse.bgcsaas.com', 'ticket-pulse-app.azurewebsites.net'];
  const env = { NODE_ENV: 'production', PUBLIC_APP_URL: WEB };
  const req = (headers) => ({ protocol: 'https', get: (n) => headers[String(n).toLowerCase()] });

  test.each([
    ['the API host it was fetched from', { host: 'api.ticketpulse.bgcsaas.com' }],
    ['a forwarded API host', { host: 'ticket-pulse-app.azurewebsites.net', 'x-forwarded-host': 'api.ticketpulse.bgcsi.com' }],
    ['the web host (fallback)', { host: 'tickets.example.com' }],
    ['a spoofed host (fallback)', { host: 'evil.example.com', 'x-forwarded-host': 'evil.example.com' }],
  ])('%s: never PUBLIC_APP_URL, always an API host, docs link included', (_label, headers) => {
    const baseUrl = resolveApiPublicBase(req(headers), { env });
    expect(baseUrl).not.toBe(WEB);
    expect(API_HOSTS).toContain(new URL(baseUrl).hostname);
    const md = buildPersonalKeyGuide({ ...base, baseUrl });
    expect(md).not.toContain(WEB);
    expect(md).toContain(`Full reference: ${baseUrl}/api/v1/docs`);
    expect(md).toContain(`- Base URL: \`${baseUrl}/api/v1\``);
  });
});
