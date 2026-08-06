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
      rejections: { type: 'integer', description: 'Times the ticket bounced back from an assignee' },
      categoryReviewNeeded: { type: 'boolean', description: 'AI flagged the category as a weak fit' },
      isNoise: { type: 'boolean' },
      assignedBy: { type: 'string', nullable: true },
      customFields: {
        type: 'object',
        additionalProperties: true,
        description: 'Workspace custom-field values keyed by definition key (snake_case). {} when none are set. See GET /custom-fields for this workspace’s definitions.',
        example: { client_name: 'ACME Inc', share_point_item_link: 'https://…/DispForm.aspx?ID=1260' },
      },
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
      category: {
        type: 'string',
        description: 'Category BY NAME, matched case-insensitively against the workspace taxonomy (GET /categories). Unknown names 400 with the allowed values listed. Omit to let AI triage classify.',
        example: 'Project Setup',
      },
      subcategory: {
        type: 'string',
        description: 'Subcategory BY NAME — must be a child of `category` (validated; a wrong parent 400s naming the valid children).',
        example: 'Quebec',
      },
      customFields: {
        type: 'object',
        additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
        description: 'Arbitrary structured intake metadata: an object of scalar values. Keys are normalized to snake_case; known keys validate against the workspace’s custom-field definitions; unknown keys AUTO-PROVISION a definition (type inferred, source “api”). Nothing is silently dropped — unusable entries are reported in the create response’s meta.rejectedCustomFields. Caps: ≤40 keys/request, ≤2000 chars per value, ≤200 definitions/workspace. Requires the customfields:write scope.',
        example: { clientName: 'ACME Inc', powerAppRecordId: '1260', sharePointItemLink: 'https://…/DispForm.aspx?ID=1260' },
      },
      ccEmails: {
        type: 'array', items: { type: 'string', format: 'email' },
        description: 'Addresses cc’d on the ticket (stored on the ticket and shown on the detail page).',
      },
      source: {
        type: 'integer',
        description: 'Arrival-channel override (1 Email, 2 Portal, 3 Phone, 9 Walk-up, 102 MS Teams, 103 Agent). Defaults to 100 (API) — only set this when relaying a request that reached you another way.',
      },
      ticketType: {
        type: 'string',
        description: 'Ticket type by name, validated against the workspace type registry (GET /types). Omitted → workspace default. `type` is accepted as an alias.',
      },
    },
    example: {
      subject: 'Coyote Landslide', description: 'Created from Power Automate', priority: 2,
      requesterEmail: 'jdoe@bgcengineering.ca', requesterName: 'Jane Doe',
      category: 'Project Setup', subcategory: 'Quebec',
      customFields: { clientName: 'ACME Inc', powerAppRecordId: '1260' },
    },
  },
  UpdateTicket: {
    type: 'object',
    properties: {
      status: { type: 'string', example: 'Pending' }, priority: { type: 'integer', enum: [1, 2, 3, 4] },
      subject: { type: 'string' }, assignedTechId: { type: 'integer', nullable: true },
      internalCategoryId: { type: 'integer' }, internalSubcategoryId: { type: 'integer' }, groupId: { type: 'integer' },
      category: {
        type: 'string', nullable: true,
        description: 'Category BY NAME (same resolution as create). Explicit internalCategoryId wins when both are sent; `category: null` clears the pair.',
      },
      subcategory: { type: 'string', nullable: true, description: 'Subcategory BY NAME — must be a child of the (new) category.' },
      customFields: {
        type: 'object',
        additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
        description: 'Merge custom-field values (a null value clears a key). NO auto-provisioning on update — unknown keys 422 `unknown_custom_fields` listing every offender. Requires the customfields:write scope.',
      },
    },
  },
  CustomFieldDefinition: {
    type: 'object',
    properties: {
      key: { type: 'string', example: 'client_name', description: 'Stable snake_case key — what `customFields` objects are keyed by.' },
      label: { type: 'string', example: 'Client Name' },
      type: { type: 'string', enum: ['text', 'number', 'select', 'boolean', 'date'] },
      options: { type: 'array', items: { type: 'string' }, description: 'Allowed values (select type only).' },
      source: { type: 'string', enum: ['manual', 'api'], description: '“api” = auto-provisioned by ticket-create intake; “manual” = created by an admin in Settings.' },
    },
  },
  Message: { type: 'object', required: ['body'], properties: { body: { type: 'string' }, bodyHtml: { type: 'string' } } },
  Contact: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, email: { type: 'string', nullable: true }, phone: { type: 'string', nullable: true }, department: { type: 'string', nullable: true }, location: { type: 'string', nullable: true } } },
  Task: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' }, description: { type: 'string', nullable: true }, status: { type: 'string', enum: ['open', 'in_progress', 'done'] }, assignee: { type: 'object', nullable: true }, dueAt: { type: 'string', format: 'date-time', nullable: true } } },
};

const ref = (n) => ({ $ref: `#/components/schemas/${n}` });

function op(summary, scope, { tag, body, responseRef, status = 200, list = false, meta, extraResponses } = {}) {
  const successSchema = list
    ? { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { items: { type: 'array', items: responseRef || {} }, pagination: { $ref: '#/components/schemas/Pagination' } } } } }
    : { type: 'object', properties: { success: { type: 'boolean' }, data: responseRef || { type: 'object' } } };
  if (meta) successSchema.properties.meta = meta;
  const responses = {
    [status]: {
      description: 'OK',
      content: { 'application/json': { schema: successSchema } },
    },
    400: { $ref: '#/components/responses/Problem' },
    401: { $ref: '#/components/responses/Problem' },
    403: { $ref: '#/components/responses/Problem' },
    404: { $ref: '#/components/responses/Problem' },
    429: { $ref: '#/components/responses/Problem' },
    ...(extraResponses || {}),
  };
  const o = { summary, tags: [tag], security: [{ apiKey: [] }], responses };
  if (scope) o['x-required-scope'] = scope;
  if (body) o.requestBody = { required: true, content: { 'application/json': { schema: body } } };
  return o;
}

// Intake-transparency meta on the create response (FR 08-05 #1): what didn't
// land, what got rejected inside customFields, and what auto-provisioned.
const CREATE_TICKET_META = {
  type: 'object',
  description: 'Intake transparency: what didn’t land and what was auto-provisioned.',
  properties: {
    ignoredFields: {
      type: 'array', items: { type: 'string' },
      description: 'Unknown TOP-LEVEL body keys that were dropped. Extra intake data belongs inside `customFields`, where it is stored and auto-provisioned.',
    },
    rejectedCustomFields: {
      type: 'array',
      items: { type: 'object', properties: { key: { type: 'string' }, reason: { type: 'string' } } },
      description: 'customFields entries that could not be stored, with a machine-readable reason (invalid_key, too_many_keys, value_too_long, definition_cap_reached, or a type-coercion message). The ticket is still created.',
    },
    provisionedCustomFields: {
      type: 'array', items: { type: 'string' },
      description: 'Keys for which a new custom-field definition was auto-provisioned (source “api”) by this request.',
    },
  },
};

// Worked 400 for a category name that doesn't resolve (docs promise the
// allowed values are listed so senders can self-correct).
const CATEGORY_VALIDATION_400 = {
  description: 'Validation error (problem+json). Unknown category/subcategory names list the allowed values.',
  content: {
    'application/problem+json': {
      schema: ref('Problem'),
      example: {
        type: 'about:blank', title: 'Validation failed', status: 400, code: 'validation_failed',
        detail: 'Unknown category "Acounts Payable" for this workspace. Allowed categories: Project Setup, Proposal Setup, Client Maintenance…',
        request_id: 'req_abc',
      },
    },
  },
};

const UNKNOWN_CUSTOM_FIELDS_422 = {
  description: 'Unknown custom-field key(s) on update (problem+json). PATCH never auto-provisions — definitions are created in Settings or at ticket creation.',
  content: {
    'application/problem+json': {
      schema: ref('Problem'),
      example: {
        type: 'about:blank', title: 'Unknown custom fields', status: 422, code: 'unknown_custom_fields',
        detail: 'Unknown custom field key(s): client_nane. Definitions are created in Settings or auto-provisioned at ticket creation — see GET /api/v1/custom-fields for this workspace\'s fields.',
        errors: [{ field: 'customFields.client_nane', code: 'unknown_field' }],
        request_id: 'req_abc',
      },
    },
  },
};

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
    security: [{ apiKey: [] }, { oauth2: [] }],
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', description: 'API key (tp_live_… / tp_test_…) issued in Settings → API Keys' },
        oauth2: { type: 'oauth2', description: 'Built-in OAuth2 client-credentials — exchange a client at /oauth/token for a bearer token.', flows: { clientCredentials: { tokenUrl: `${baseUrl}/api/v1/oauth/token`, scopes: {} } } },
      },
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
      '/oauth/token': {
        post: {
          summary: 'OAuth2 client-credentials token exchange',
          tags: ['auth'], security: [],
          requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', required: ['grant_type', 'client_id', 'client_secret'], properties: { grant_type: { type: 'string', enum: ['client_credentials'] }, client_id: { type: 'string' }, client_secret: { type: 'string' } } } } } },
          responses: {
            200: { description: 'Access token', content: { 'application/json': { schema: { type: 'object', properties: { access_token: { type: 'string' }, token_type: { type: 'string', example: 'Bearer' }, expires_in: { type: 'integer' }, scope: { type: 'string' } } } } } },
            400: { description: 'OAuth2 error', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' }, error_description: { type: 'string' } } } } } },
            401: { description: 'invalid_client' },
          },
        },
      },
      '/me': { get: op('Identity, workspace, and limits for the calling credential', null, { tag: 'discovery' }) },
      '/meta': { get: op('Enumerations: priorities, statuses, ticket types', null, { tag: 'discovery' }) },
      '/tickets': {
        get: op('List tickets (cursor or offset; filters mirror the queue)', 'tickets:read', { tag: 'tickets', responseRef: ref('Ticket'), list: true }),
        post: op('Create a ticket (category by name, custom fields, cc)', 'tickets:write', {
          tag: 'tickets', body: ref('CreateTicket'), responseRef: ref('Ticket'), status: 201,
          meta: CREATE_TICKET_META, extraResponses: { 400: CATEGORY_VALIDATION_400 },
        }),
      },
      '/tickets/{id}': {
        get: op('Get a ticket with its public conversation', 'tickets:read', { tag: 'tickets', responseRef: ref('Ticket') }),
        patch: op('Update a ticket (status/priority/assignee/fields/custom fields)', 'tickets:write', {
          tag: 'tickets', body: ref('UpdateTicket'), responseRef: ref('Ticket'),
          extraResponses: { 400: CATEGORY_VALIDATION_400, 422: UNKNOWN_CUSTOM_FIELDS_422 },
        }),
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
      '/custom-fields': { get: op('List active custom-field definitions (incl. API-provisioned)', 'customfields:read', { tag: 'taxonomy', responseRef: { type: 'array', items: ref('CustomFieldDefinition') } }) },
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
pre{background:#0f172a;color:#e2e8f0;border-radius:8px;padding:.7rem .9rem;overflow-x:auto;font-family:ui-monospace,monospace;font-size:.78rem;line-height:1.5;margin:.5rem 0}
@media(prefers-color-scheme:dark){body{background:#0b1220;color:#e6edf7}code{background:#1e293b}.card{background:#111a2b;border-color:#1f2c3f}td{border-color:#1f2c3f}p{color:#94a3b8}pre{background:#060b14;border:1px solid #1f2c3f}}</style></head>
<body>
<h1>Ticket Pulse Integration API <span style="font-size:.7rem;color:#64748b">v${spec.info.version}</span></h1>
<p>Key-authenticated, workspace-scoped. Machine-readable spec: <a href="openapi.json">openapi.json</a>.</p>
<div class="card">
<b>Authentication — two options, both workspace-scoped</b><br>
<b>1. API key</b> (simplest). Issue one per workspace in <b>Settings → API Keys</b>, scoped to exactly what the integration needs. A <code>tp_test_…</code> key is <b>read-only</b> — safe to build against; switch to a <code>tp_live_…</code> key to make changes (writes with a test key return <code>403 test_mode_read_only</code>).
<pre>curl ${baseUrl}/api/v1/me \\
  -H "Authorization: Bearer tp_live_xxx"</pre>
<b>2. OAuth2 client-credentials</b> (for apps). Create a client in <b>Settings → API Keys → OAuth clients</b>, then exchange it for a short-lived token:
<pre>curl -X POST ${baseUrl}/api/v1/oauth/token \\
  -d grant_type=client_credentials \\
  -d client_id=tpc_xxx -d client_secret=tps_xxx
# → { "access_token": "eyJ…", "token_type": "Bearer", "expires_in": 3600 }
curl ${baseUrl}/api/v1/tickets -H "Authorization: Bearer eyJ…"</pre>
Both resolve to a single workspace; a credential can never read or write another workspace's data.
<br><br><b>Conventions</b><br>
• Errors are <code>application/problem+json</code> (RFC 9457) with a stable <code>code</code>.<br>
• Every response carries <code>X-Request-Id</code> and <code>X-RateLimit-Limit/Remaining/Reset</code>; <code>429</code> includes <code>Retry-After</code>.<br>
• Send <code>Idempotency-Key: &lt;uuid&gt;</code> on writes so a retry never double-applies.<br>
• Lists page by <code>?cursor=</code> (keyset, use the returned <code>next_cursor</code>) or <code>?page=&amp;pageSize=</code>.
</div>
${sections}
<h2>Ticket intake enrichment</h2>
<p><code>POST /tickets</code> accepts more than the basics — senders can classify the ticket against the workspace
taxonomy <b>by name</b> and attach arbitrary structured metadata that Ticket Pulse keeps, displays, and can automate on.</p>
<div class="card">
<b>Create-body fields</b>
<table><tbody>
<tr><td class="p">subject</td><td><b>Required.</b> Short summary.</td></tr>
<tr><td class="p">description</td><td>Plain text or HTML body.</td></tr>
<tr><td class="p">priority</td><td>1 Low · 2 Medium (default) · 3 High · 4 Urgent.</td></tr>
<tr><td class="p">requesterEmail</td><td><b>Required.</b> The requester is found or created by this address.</td></tr>
<tr><td class="p">requesterName</td><td>Display name for a new requester.</td></tr>
<tr><td class="p">runAiTriage</td><td>Default <code>true</code> — AI classifies + recommends an assignee. Set <code>false</code> when your integration sets the category itself.</td></tr>
<tr><td class="p">category</td><td>Category <b>by name</b>, matched case-insensitively against the workspace taxonomy (<code>GET /categories</code>).</td></tr>
<tr><td class="p">subcategory</td><td>Subcategory <b>by name</b> — must be a child of <code>category</code>.</td></tr>
<tr><td class="p">customFields</td><td>Object of scalar values — your structured metadata. Stored on the ticket, shown on the ticket page, usable in workflow conditions. Needs the <code>customfields:write</code> scope.</td></tr>
<tr><td class="p">ccEmails</td><td>Array of addresses cc’d on the ticket.</td></tr>
<tr><td class="p">source</td><td>Arrival channel override (1 Email, 2 Portal, 3 Phone, 9 Walk-up, 102 MS Teams, 103 Agent). Defaults to 100 = API.</td></tr>
<tr><td class="p">ticketType</td><td>Type by name from the workspace registry (<code>GET /types</code>); omitted → workspace default.</td></tr>
</tbody></table>
Anything else at the top level is dropped and reported back in <code>meta.ignoredFields</code> —
extra intake data belongs <b>inside <code>customFields</code></b>, where it is kept.
</div>
<div class="card">
<b>Category validation</b><br>
Names resolve case-insensitively against the workspace's <b>active</b> taxonomy; a subcategory must belong to the
resolved category. An unknown name fails the whole request with a <code>400</code> problem+json that lists the
allowed values, so senders can self-correct:
<pre>{
  "title": "Validation failed", "status": 400, "code": "validation_failed",
  "detail": "Unknown category \\"Acounts Payable\\" for this workspace.
             Allowed categories: Project Setup, Proposal Setup, Client Maintenance…",
  "request_id": "req_abc"
}</pre>
Nothing is created on a validation failure — safe to retry after fixing the name.
</div>
<div class="card">
<b>Custom fields — semantics</b><br>
• <b>Keys normalize</b> to <code>snake_case</code> (<code>clientName</code> → <code>client_name</code>; spaces/hyphens/dots → underscores;
must then match <code>[a-z][a-z0-9_]{1,59}</code>).<br>
• <b>Known keys</b> validate against the definition's type (text / number / select / boolean / date).<br>
• <b>Unknown keys auto-provision</b> a definition on create: type inferred from the first value
(boolean / number / ISO-date / text), label prettified from the key, marked <code>source: "api"</code>, active immediately.
Admins curate these in <b>Settings → Ticket Ops → Custom fields</b> (relabel, retype, retire).<br>
• <b>Nothing is silently dropped</b> — entries that can't be stored come back in
<code>meta.rejectedCustomFields</code> as <code>{key, reason}</code>
(<code>invalid_key</code>, <code>too_many_keys</code>, <code>value_too_long</code>, <code>definition_cap_reached</code>, or a type-coercion message);
the ticket is still created.<br>
• <b>Caps:</b> ≤ 40 keys per request · ≤ 2,000 chars per value · ≤ 200 definitions per workspace.<br>
• <b>Updates:</b> <code>PATCH /tickets/{id}</code> merges values but <b>never auto-provisions</b> — unknown keys return
<code>422 unknown_custom_fields</code> naming every offender. Creation is the intake path.<br>
• <code>GET /custom-fields</code> lists the workspace's active definitions (<code>customfields:read</code>).
</div>
<div class="card">
<b>Worked example</b> — a Power App / SharePoint project-setup request:
<pre>curl -X POST ${baseUrl}/api/v1/tickets \\
  -H "Authorization: Bearer tp_live_xxx" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: sp-proposal-1260" \\
  -d '{
  "subject": "Coyote Landslide",
  "description": "Created from Power Automate",
  "priority": 2,
  "requesterEmail": "jdoe@bgcengineering.ca",
  "requesterName": "Jane Doe",
  "category": "Project Setup",
  "subcategory": "Quebec",
  "customFields": {
    "clientName": "ACME Inc",
    "clientLocation": "Quebec",
    "projectOrProposalName": "Coyote Landslide",
    "powerAppRecordId": "1260",
    "sharePointItemLink": "https://example.sharepoint.com/sites/ProjectProposalSetup/Lists/Project%20Requests/DispForm.aspx?ID=1260",
    "powerAppFormLink": "https://apps.powerapps.com/play/…",
    "sourceSystem": "Power App / Coreshack",
    "sourceRequestType": "Project Setup"
  }
}'</pre>
Response (<code>201</code>) — note the snake_cased keys and the intake transparency in <code>meta</code>:
<pre>{
  "success": true,
  "data": {
    "id": 501, "ref": "TP-1042", "origin": "ticketpulse",
    "subject": "Coyote Landslide", "status": "Open", "priority": 2,
    "category": "Project Setup", "subcategory": "Quebec",
    "customFields": {
      "client_name": "ACME Inc", "client_location": "Quebec",
      "project_or_proposal_name": "Coyote Landslide", "power_app_record_id": "1260",
      "share_point_item_link": "https://example.sharepoint.com/…?ID=1260",
      "power_app_form_link": "https://apps.powerapps.com/play/…",
      "source_system": "Power App / Coreshack", "source_request_type": "Project Setup"
    }, "…": "…"
  },
  "meta": {
    "ignoredFields": [],
    "rejectedCustomFields": [],
    "provisionedCustomFields": ["client_name", "client_location", "project_or_proposal_name",
      "power_app_record_id", "share_point_item_link", "power_app_form_link",
      "source_system", "source_request_type"]
  }
}</pre>
Want <code>sourceRequestType</code> to drive the category automatically? Build it as a workflow —
condition <code>custom:source_request_type is "Project Setup"</code> → update-ticket “Category by name”.
The installable <b>API intake router</b> template (Settings → Mail Workflows → Templates) is exactly this.
</div>
<h2>Calling from Power Apps / Power Automate</h2>
<p>The recommended shape: a cloud flow (SharePoint trigger or Power Apps V2 trigger) with the built-in
<b>HTTP</b> action. <b>The HTTP connector is Premium</b> — covered by Power Automate Premium / Process or
Power Apps Premium licenses (flows running in context of a premium-licensed canvas app are covered by it).
The free “Send an HTTP request” actions (SharePoint, Office 365) only reach Microsoft endpoints and cannot call this API.</p>
<div class="card">
<b>HTTP action configuration</b>
<table><tbody>
<tr><td class="p">Method</td><td><code>POST</code></td></tr>
<tr><td class="p">URI</td><td><code>${baseUrl}/api/v1/tickets</code></td></tr>
<tr><td class="p">Headers</td><td><code>Content-Type: application/json</code><br><code>Authorization: Bearer tp_live_…</code> (a plain header row — leave the action's “Authentication” dropdown on <b>None</b>; it has no API-key mode)<br><code>Idempotency-Key: concat('sp-', triggerOutputs()?['body/ID'])</code></td></tr>
<tr><td class="p">Settings → Secure Inputs</td><td><b>On</b> once the flow works — hides the key (and body) from run history.</td></tr>
<tr><td class="p">Settings → Retry policy</td><td>Default is fine — see the retry note below.</td></tr>
</tbody></table>
Body — insert dynamic content where marked <code>«»</code>:
<pre>{
  "subject": "New project request: «Title»",
  "description": "Submitted by «Created By DisplayName» («Created By Email»).",
  "priority": 2,
  "requesterEmail": "«Created By Email»",
  "requesterName": "«Created By DisplayName»",
  "category": "Project Setup",
  "subcategory": "«Region choice value»",
  "customFields": {
    "clientName": "«Client column»",
    "powerAppRecordId": "«ID»",
    "sharePointItemLink": "«Link to item»",
    "sourceSystem": "Power App / SharePoint",
    "sourceRequestType": "«Request type choice value»"
  }
}</pre>
<b>Escaping gotcha:</b> dynamic tokens dropped into a hand-typed JSON string are <b>not</b> escaped — a title
containing <code>"</code> or a newline produces invalid JSON and a 400. Keep free text out of hand-built strings
(compose the body as an object / <code>setProperty()</code> chain), or run risky fields through
<code>replace(replace(«v», '\\', '\\\\'), '"', '\\"')</code>. Constrained fields (choice columns, emails, IDs) are safe as-is.
</div>
<div class="card">
<b>Retries &amp; idempotency</b><br>
Power Automate auto-retries an action on 408, 429 and 5xx (up to 12 times on most plans) — each retry
<b>re-sends the POST</b>. The <code>Idempotency-Key</code> header is what makes that safe: same key + same body → the
cached response replays, no duplicate ticket. Key it per <b>source record</b>
(<code>concat('sp-', triggerOutputs()?['body/ID'])</code>) rather than per run — a resubmitted run then still can't
double-create. Same key with a <i>different</i> body → <code>422 idempotency_key_reused</code>. Our <code>429</code>s carry
<code>Retry-After</code>, which the retry runtime honors.
</div>
<div class="card">
<b>Reading the response</b> — add a <b>Parse JSON</b> action over <code>body('HTTP')</code>:
<pre>{ "type": "object", "properties": {
  "success": { "type": "boolean" },
  "data": { "type": "object", "properties": {
    "id": { "type": "integer" }, "ref": { "type": "string" },
    "subject": { "type": "string" }, "status": { "type": "string" },
    "category": { "type": ["string", "null"] }, "createdAt": { "type": "string" } } },
  "meta": { "type": "object", "properties": {
    "ignoredFields": { "type": "array" },
    "rejectedCustomFields": { "type": "array" },
    "provisionedCustomFields": { "type": "array" } } } } }</pre>
Write <code>ref</code> / <code>id</code> back to the source item (SharePoint “Update item”) so the record links to its ticket.
<br><br>
<b>Failures (4xx):</b> add a Parse JSON on the error branch (<b>Configure run after → has failed</b>) with the
problem+json shape — <code>{ "title", "status", "code", "detail", "request_id" }</code> — then alert on
<code>code</code>/<code>detail</code>. Quote <code>request_id</code> when contacting us. Watch for: <code>api_key_required</code> /
<code>invalid_api_key</code> (401), <code>insufficient_scope</code> (403 — the key needs <code>customfields:write</code> for
custom fields), <code>validation_failed</code> (400 — check <code>detail</code> for the allowed category values),
<code>test_mode_read_only</code> (403 — swap the <code>tp_test_</code> key for a live one).
</div>
<div class="card">
<b>Storing the key</b> — best: a Power Platform <b>environment variable of type Secret</b> backed by Azure Key Vault
(retrieved in-flow via the Dataverse <code>RetrieveEnvironmentVariableSecretValue</code> unbound action, with Secure
Outputs on). Acceptable: a plain-text environment variable + Secure Inputs on the HTTP action. Never paste the key
into many flows by hand — rotation becomes guesswork.
<br><br>
<b>Custom connector instead of HTTP?</b> Worth it when several flows/makers call Ticket Pulse (the key is entered
once per connection, never visible in flow definitions) or you want the API as a canvas-app data source. Note the
connector wizard requires <b>OpenAPI 2.0 (Swagger)</b> — it does not import our 3.1 <a href="openapi.json">openapi.json</a>
as-is; hand-build a minimal 2.0 file with just <code>POST /tickets</code> (+ <code>GET /tickets/{id}</code>), auth type
<b>API Key</b>, parameter name <code>Authorization</code>, location <code>Header</code> — and users must paste
<code>Bearer tp_live_…</code> <b>including the “Bearer ” prefix</b> when creating a connection. Same premium licensing as HTTP.
</div>
<h2>Outbound webhooks</h2>
<p>Subscribe in <b>Settings → API Keys → Outbound webhooks</b>. Deliveries follow the <a href="https://www.standardwebhooks.com">Standard Webhooks</a> spec — headers <code>webhook-id</code>, <code>webhook-timestamp</code>, <code>webhook-signature</code> (<code>v1,&lt;base64 HMAC-SHA256 of id.timestamp.body&gt;</code>, secret <code>whsec_…</code>). Verify with a constant-time compare and a timestamp tolerance; treat <code>webhook-id</code> as an idempotency key. Legacy <code>X-TicketPulse-Signature</code> headers are sent in parallel during migration. Failed deliveries retry with exponential backoff and are visible (with a redeliver action) in the webhook’s delivery log.</p>
</body></html>`;
}

export default { buildOpenApiSpec, renderDocsPage };
