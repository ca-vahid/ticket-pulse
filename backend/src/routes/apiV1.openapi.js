/**
 * OpenAPI 3.1 spec for the public API — the source of truth for the docs page,
 * and consumable by client/SDK generators. Self-contained (no external refs).
 */

const T = {
  Problem: {
    type: 'object',
    description: 'RFC 9457 problem+json error.',
    properties: {
      type: { type: 'string' }, title: { type: 'string' }, status: { type: 'integer' },
      code: { type: 'string' }, detail: { type: 'string' }, instance: { type: 'string' },
      request_id: { type: 'string' }, errors: { type: 'array', items: { type: 'object' } },
    },
    example: { type: 'https://…/errors/insufficient_scope', title: 'Forbidden', status: 403, code: 'insufficient_scope', detail: "This key is missing the 'tickets:write' scope", request_id: 'req_abc' },
  },
  Pagination: {
    type: 'object',
    properties: {
      next_cursor: { type: 'string', nullable: true, description: 'Opaque cursor for the next page (cursor mode).' },
      limit: { type: 'integer' }, page: { type: 'integer' }, page_size: { type: 'integer' }, total: { type: 'integer' },
    },
  },
  Ticket: {
    type: 'object',
    properties: {
      id: { type: 'integer' }, ref: { type: 'string', example: 'TP-1042' },
      origin: { type: 'string', enum: ['ticketpulse', 'freshservice'] },
      subject: { type: 'string' }, status: { type: 'string' }, priority: { type: 'integer', enum: [1, 2, 3, 4] },
      type: { type: 'string', nullable: true },
      requester: { type: 'object', nullable: true, properties: { id: { type: 'integer' }, name: { type: 'string' }, email: { type: 'string' } } },
      assignee: { type: 'object', nullable: true, properties: { id: { type: 'integer' }, name: { type: 'string' } } },
      group: { type: 'object', nullable: true },
      category: { type: 'string', nullable: true }, subcategory: { type: 'string', nullable: true },
      tags: { type: 'array', items: { type: 'string' } },
      createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
      resolvedAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  ThreadEntry: {
    type: 'object',
    properties: {
      id: { type: 'integer' }, type: { type: 'string' }, author: { type: 'string' },
      authorType: { type: 'string', nullable: true }, isPrivate: { type: 'boolean' },
      body: { type: 'string' }, at: { type: 'string', format: 'date-time' },
    },
  },
  CreateTicket: {
    type: 'object', required: ['subject', 'requesterEmail'],
    properties: {
      subject: { type: 'string' }, description: { type: 'string' },
      priority: { type: 'integer', enum: [1, 2, 3, 4], default: 2 },
      requesterEmail: { type: 'string', format: 'email' }, requesterName: { type: 'string' },
      runAiTriage: { type: 'boolean', default: true },
    },
    example: { subject: 'Laptop won’t boot', description: 'Black screen after update.', priority: 3, requesterEmail: 'jane@acme.com', requesterName: 'Jane Doe' },
  },
  UpdateTicket: {
    type: 'object',
    properties: {
      status: { type: 'string', example: 'Pending' }, priority: { type: 'integer', enum: [1, 2, 3, 4] },
      subject: { type: 'string' }, assignedTechId: { type: 'integer', nullable: true },
      internalCategoryId: { type: 'integer' }, internalSubcategoryId: { type: 'integer' }, groupId: { type: 'integer' },
    },
  },
  Message: { type: 'object', required: ['body'], properties: { body: { type: 'string' }, bodyHtml: { type: 'string' } } },
  Contact: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, email: { type: 'string', nullable: true }, phone: { type: 'string', nullable: true }, department: { type: 'string', nullable: true }, location: { type: 'string', nullable: true } } },
  Task: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' }, description: { type: 'string', nullable: true }, status: { type: 'string', enum: ['open', 'in_progress', 'done'] }, assignee: { type: 'object', nullable: true }, dueAt: { type: 'string', format: 'date-time', nullable: true } } },
};

function op(summary, scope, { tag, body, responseRef, status = 200, list = false } = {}) {
  const responses = {
    [status]: {
      description: 'OK',
      content: { 'application/json': { schema: list
        ? { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { items: { type: 'array', items: responseRef || {} }, pagination: { $ref: '#/components/schemas/Pagination' } } } } }
        : { type: 'object', properties: { success: { type: 'boolean' }, data: responseRef || { type: 'object' } } } } },
    },
    400: { $ref: '#/components/responses/Problem' },
    401: { $ref: '#/components/responses/Problem' },
    403: { $ref: '#/components/responses/Problem' },
    404: { $ref: '#/components/responses/Problem' },
    429: { $ref: '#/components/responses/Problem' },
  };
  const o = { summary, tags: [tag], security: [{ apiKey: [] }], responses };
  if (scope) o['x-required-scope'] = scope;
  if (body) o.requestBody = { required: true, content: { 'application/json': { schema: body } } };
  return o;
}

const ref = (n) => ({ $ref: `#/components/schemas/${n}` });

export function buildOpenApiSpec(baseUrl) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Ticket Pulse Integration API',
      version: '2.0.0',
      description: [
        'Key-authenticated, workspace-scoped integration API — a FreshService-replacement surface.',
        '',
        '**Auth:** `Authorization: Bearer tp_live_…` (or `tp_test_…`). Each key carries explicit scopes.',
        '**Errors:** RFC 9457 `application/problem+json` with a stable `code`.',
        '**Every response** carries `X-Request-Id` and `X-RateLimit-*`; `429` includes `Retry-After`.',
        '**Idempotency:** send `Idempotency-Key: <uuid>` on writes to make retries safe.',
        '**Pagination:** list endpoints support `?cursor=` (keyset) or `?page=&pageSize=` (offset).',
      ].join('\n'),
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'API key (tp_live_… / tp_test_…) issued in Settings → API Keys' } },
      parameters: {
        cursor: { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Opaque keyset cursor from a prior response.' },
        limit: { name: 'pageSize', in: 'query', schema: { type: 'integer', maximum: 100, default: 25 } },
        page: { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
        idempotencyKey: { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' }, description: 'Retry-safety key (UUID recommended).' },
      },
      responses: {
        Problem: { description: 'Error (problem+json)', content: { 'application/problem+json': { schema: ref('Problem') } } },
      },
      schemas: T,
    },
    paths: {
      '/me': { get: op('Identity, workspace, and limits for the calling key', null, { tag: 'discovery' }) },
      '/meta': { get: op('Enumerations: priorities, statuses, ticket types', null, { tag: 'discovery' }) },
      '/tickets': {
        get: op('List tickets (cursor or offset; filters mirror the queue)', 'tickets:read', { tag: 'tickets', responseRef: ref('Ticket'), list: true }),
        post: op('Create a ticket', 'tickets:write', { tag: 'tickets', body: ref('CreateTicket'), responseRef: ref('Ticket'), status: 201 }),
      },
      '/tickets/{id}': {
        get: op('Get a ticket with its public conversation', 'tickets:read', { tag: 'tickets', responseRef: ref('Ticket') }),
        patch: op('Update a ticket (status/priority/assignee/fields)', 'tickets:write', { tag: 'tickets', body: ref('UpdateTicket'), responseRef: ref('Ticket') }),
      },
      '/tickets/{id}/merge': { post: op('Merge another ticket into this one', 'tickets:write', { tag: 'tickets', body: { type: 'object', required: ['targetTicketId'], properties: { targetTicketId: { type: 'integer' }, notifyRequester: { type: 'boolean' } } } }) },
      '/tickets/{id}/family': { get: op('Parent + children of a ticket', 'tickets:read', { tag: 'tickets' }) },
      '/tickets/{id}/parent': {
        put: op('Set this ticket’s parent', 'tickets:write', { tag: 'tickets', body: { type: 'object', required: ['parentTicketId'], properties: { parentTicketId: { type: 'integer' } } } }),
        delete: op('Detach from parent', 'tickets:write', { tag: 'tickets' }),
      },
      '/tickets/{id}/conversations': { get: op('Full conversation thread (incl. private notes)', 'conversations:read', { tag: 'conversations', responseRef: ref('ThreadEntry') }) },
      '/tickets/{id}/replies': { post: op('Add a public reply (emails the requester)', 'conversations:write', { tag: 'conversations', body: ref('Message'), status: 201 }) },
      '/tickets/{id}/notes': { post: op('Add a private internal note', 'conversations:write', { tag: 'conversations', body: ref('Message'), status: 201 }) },
      '/tickets/{id}/tasks': {
        get: op('List a ticket’s tasks', 'tasks:read', { tag: 'tasks', responseRef: ref('Task') }),
        post: op('Add a task', 'tasks:write', { tag: 'tasks', body: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, assignedTechId: { type: 'integer' }, dueAt: { type: 'string', format: 'date-time' }, notifyAgent: { type: 'boolean' } } }, responseRef: ref('Task'), status: 201 }),
      },
      '/tickets/{id}/tasks/{taskId}': {
        patch: op('Update a task (status/description/assignee)', 'tasks:write', { tag: 'tasks', body: ref('Task'), responseRef: ref('Task') }),
        delete: op('Delete a task', 'tasks:write', { tag: 'tasks' }),
      },
      '/tickets/{id}/attachments': { get: op('List attachments', 'attachments:read', { tag: 'attachments' }) },
      '/tickets/{id}/attachments/{attachmentId}': { get: op('Download an attachment', 'attachments:read', { tag: 'attachments' }) },
      '/tickets/{id}/approvals': {
        get: op('List approvals on a ticket', 'approvals:read', { tag: 'approvals' }),
        post: op('Request approval against a category', 'approvals:write', { tag: 'approvals', body: { type: 'object', required: ['approvalCategoryId'], properties: { approvalCategoryId: { type: 'integer' }, note: { type: 'string' } } }, status: 201 }),
      },
      '/tags': { get: op('List the workspace tag palette', 'tags:read', { tag: 'taxonomy' }) },
      '/tickets/{id}/tags': { put: op('Replace a ticket’s tag set', 'tags:write', { tag: 'taxonomy', body: { type: 'object', properties: { tagIds: { type: 'array', items: { type: 'integer' } } } } }) },
      '/contacts': { get: op('List/search requesters', 'contacts:read', { tag: 'directory', responseRef: ref('Contact') }) },
      '/contacts/{id}': { get: op('Get a requester', 'contacts:read', { tag: 'directory', responseRef: ref('Contact') }) },
      '/agents': { get: op('List agents/technicians', 'agents:read', { tag: 'directory' }) },
      '/groups': { get: op('List groups', 'groups:read', { tag: 'directory' }) },
      '/categories': { get: op('List categories & subcategories', 'categories:read', { tag: 'taxonomy' }) },
      '/types': { get: op('List ticket types', 'types:read', { tag: 'taxonomy' }) },
      '/search/tickets': { get: op('Search tickets (?query=…)', 'search:read', { tag: 'tickets', responseRef: ref('Ticket'), list: true }) },
    },
  };
}

// ------------------------------------------------ self-contained docs page

export function renderDocsPage(baseUrl) {
  const spec = buildOpenApiSpec(baseUrl);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const byTag = {};
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, o] of Object.entries(methods)) {
      const tag = o.tags?.[0] || 'other';
      (byTag[tag] ||= []).push({ method, path, summary: o.summary, scope: o['x-required-scope'] });
    }
  }
  const sections = Object.entries(byTag).map(([tag, rows]) => `
    <h2>${esc(tag)}</h2>
    <table><tbody>${rows.map((r) => `<tr>
      <td class="m ${r.method}">${r.method.toUpperCase()}</td>
      <td class="p">${esc(r.path)}</td>
      <td>${esc(r.summary)}</td>
      <td class="s">${esc(r.scope || '—')}</td></tr>`).join('')}</tbody></table>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ticket Pulse API</title>
<style>:root{color-scheme:light dark}body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a;background:#f8fafc;max-width:920px;margin:0 auto;padding:2rem 1rem;line-height:1.55}
h1{font-size:1.5rem;margin:0 0 .3rem}h2{font-size:1rem;text-transform:uppercase;letter-spacing:.06em;color:#2563eb;margin:1.6rem 0 .4rem}
p{color:#475569}code{background:#eef2f7;border-radius:4px;padding:1px 5px;font-family:ui-monospace,monospace;font-size:.85em}
table{border-collapse:collapse;width:100%;font-size:.85rem;margin-bottom:.5rem}td{padding:.45rem .55rem;border-bottom:1px solid #e2e8f0;vertical-align:top}
.m{font-weight:700;font-size:.7rem;width:52px}.get{color:#0369a1}.post{color:#047857}.put{color:#b45309}.patch{color:#7c3aed}.delete{color:#dc2626}
.p{font-family:ui-monospace,monospace;font-size:.8rem;white-space:nowrap}.s{font-family:ui-monospace,monospace;font-size:.72rem;color:#64748b;white-space:nowrap}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:1rem 1.2rem;margin:1rem 0}
@media(prefers-color-scheme:dark){body{background:#0b1220;color:#e6edf7}code{background:#1e293b}.card{background:#111a2b;border-color:#1f2c3f}td{border-color:#1f2c3f}p{color:#94a3b8}}</style></head>
<body>
<h1>Ticket Pulse Integration API <span style="font-size:.7rem;color:#64748b">v${spec.info.version}</span></h1>
<p>Key-authenticated, workspace-scoped. Machine-readable spec: <a href="openapi.json">openapi.json</a>.</p>
<div class="card">
<b>Authentication</b><br>Send every request with <code>Authorization: Bearer tp_live_…</code>. Issue keys per workspace in <b>Settings → API Keys</b>, each scoped to exactly what an integration needs. Use <code>tp_test_…</code> keys while building.
<br><br><b>Conventions</b><br>
• Errors are <code>application/problem+json</code> (RFC 9457) with a stable <code>code</code>.<br>
• Every response carries <code>X-Request-Id</code> and <code>X-RateLimit-Limit/Remaining/Reset</code>; <code>429</code> includes <code>Retry-After</code>.<br>
• Send <code>Idempotency-Key: &lt;uuid&gt;</code> on writes so a retry never double-applies.<br>
• Lists page by <code>?cursor=</code> (keyset, use the returned <code>next_cursor</code>) or <code>?page=&amp;pageSize=</code>.
</div>
${sections}
<h2>Outbound webhooks</h2>
<p>Subscribe in <b>Settings → API Keys → Outbound webhooks</b>. Deliveries follow the <a href="https://www.standardwebhooks.com">Standard Webhooks</a> spec — headers <code>webhook-id</code>, <code>webhook-timestamp</code>, <code>webhook-signature</code> (<code>v1,&lt;base64 HMAC-SHA256 of id.timestamp.body&gt;</code>, secret <code>whsec_…</code>). Verify with a constant-time compare and a timestamp tolerance; treat <code>webhook-id</code> as an idempotency key. Legacy <code>X-TicketPulse-Signature</code> headers are sent in parallel during migration. Failed deliveries retry with exponential backoff and are visible (with a redeliver action) in the webhook’s delivery log.</p>
</body></html>`;
}

export default { buildOpenApiSpec, renderDocsPage };
