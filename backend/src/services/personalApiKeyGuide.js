import { EMAIL_SANITIZE_OPTIONS } from './notificationWorkflowSignatureService.js';

/**
 * The API guide a person hands to their AI assistant (4.4.05). Self-contained
 * Markdown, personalised with the base URL, the workspace, the person and what
 * THEIR key can do today. Never the secret: `<YOUR_KEY>` stands in for it.
 *
 * Every route and field below is a real /api/v1 route (apiV1.routes.js); keep
 * them in step when the API changes. Pinned by personalApiKeyGuide.test.js.
 */

export const GUIDE_FILENAME = 'ticket-pulse-api-guide.md';

// The formatting tags worth using in a reply. The sanitizer keeps more
// (tables, headings, images by URL), but these are the ones that read well.
const RECOMMENDED_TAGS = ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'a', 'ul', 'ol', 'li', 'blockquote'];

export function keptTags() {
  const kept = new Set(EMAIL_SANITIZE_OPTIONS?.allowedTags || []);
  return {
    recommended: RECOMMENDED_TAGS.filter((t) => kept.has(t)),
    alsoKept: [...kept].filter((t) => !RECOMMENDED_TAGS.includes(t)).sort(),
  };
}

const ABILITY_WORDS = {
  read: 'read the tickets you can see in the app, their conversations (private notes included) and attachments, and the agents, groups, categories, types and tags lists',
  reply: 'reply to requesters and add private notes, as you',
  update: 'change status, priority, assignment, fields and tags, as far as your role allows in the app',
  tasks: 'add, change and finish tasks',
};

function fence(lang, body) {
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

/**
 * @param {object} input
 * @param {string} input.baseUrl        e.g. https://tickets.example.com (no trailing slash)
 * @param {{id:number,name:string}} input.workspace
 * @param {{name:string,email:string}} input.person
 * @param {string[]} input.abilities    the key's abilities ('read','reply','update','tasks')
 * @param {string[]} input.scopes       the scopes in force today (role-capped)
 * @param {boolean} [input.readOnly]    the person's role is read-only right now
 * @param {number} input.rateLimit      requests per minute
 * @param {{name:string,prefix:string,expiresAt:string|Date}|null} [input.key]
 */
export function buildPersonalKeyGuide({ baseUrl, workspace, person, abilities = ['read'], scopes = [], readOnly = false, rateLimit = 60, key = null }) {
  const api = `${String(baseUrl || '').replace(/\/+$/, '')}/api/v1`;
  const can = (id) => abilities.includes(id) && (!readOnly || id === 'read');
  const tags = keptTags();
  const T = 'TP-1234';
  const auth = '-H "Authorization: Bearer <YOUR_KEY>"';
  const json = '-H "Content-Type: application/json"';
  const lines = [];
  const push = (...l) => lines.push(...l);

  push(
    `# Ticket Pulse API guide for ${person.name || person.email}`,
    '',
    `You are helping ${person.name || person.email} (${person.email}) work their tickets in the Ticket Pulse workspace "${workspace.name}" through its API. Everything you do with this key is done AS ${person.name || 'them'}: replies go to real people under their name, and nothing can be undone.`,
    '',
    '## Connecting',
    '',
    `- Base URL: \`${api}\``,
    '- Every call sends the header `Authorization: Bearer <YOUR_KEY>`. The person gives you the key separately; never write it into files, tickets or replies.',
    '- Send and expect JSON (`Content-Type: application/json`).',
    `- Limit: ${rateLimit} requests a minute for this key. Over it you get \`429\` with a \`Retry-After\` header (seconds): wait that long, then go on.`,
    '- **No undo.** A reply is e-mailed to the requester the moment you send it. There is no draft and no undo-send window. If you are not sure, add a private note instead and let the person decide.',
    `- Check the key with \`GET ${api}/me\`: it says who the key acts as, what it can do and when it ends. \`GET ${api}/me/guide\` returns this guide.`,
  );
  if (key) push(`- This key: "${key.name}" (\`${key.prefix}…\`), ends ${new Date(key.expiresAt).toISOString().slice(0, 10)}.`);
  push('');

  push('## What this key can do', '');
  for (const id of ['read', 'reply', 'update', 'tasks']) {
    if (can(id)) push(`- Yes: ${ABILITY_WORDS[id]}.`);
  }
  for (const id of ['reply', 'update', 'tasks']) {
    if (!can(id)) push(`- No: ${ABILITY_WORDS[id].replace(', as you', '')}. Calls for it get \`403\`.`);
  }
  if (readOnly) push('- The person\'s access is read-only right now, so every change is refused with `403 read_only_role`.');
  push(
    '- This key can\'t create new tickets or new requesters, split tickets or add external references. It never handles approvals, custom-field changes, new tags, settings, keys or webhooks.',
    '',
    `Scopes in force today: ${scopes.length ? scopes.map((s) => `\`${s}\``).join(', ') : 'none'}. The person's role is checked on every call, so if it changes, what the key can do changes with it.`,
    '',
  );

  push(
    '## Tickets',
    '',
    'A ticket is named in the URL by its reference (`TP-1234` for tickets born in Ticket Pulse, `#123456` for FreshService ones) or by the `id` an earlier response gave you.',
    '',
    `### Find ${person.name ? `${person.name.split(' ')[0]}'s` : 'my'} open tickets`,
    '',
    fence('bash', `curl "${api}/tickets?assigneeEmail=${encodeURIComponent(person.email)}&status=Open,Pending&pageSize=25" \\\n  ${auth}`),
    '',
    'The answer is `{ "success": true, "data": { "items": [Ticket…], "pagination": { "next_cursor": "…", "limit": 25, "total": 12 } } }`. For the next page, send `cursor=<next_cursor>` with the same filters. Other filters: `q` (subject, requester or ticket number), `requesterEmail`, `priority`, `createdFrom`, `updatedFrom` (ISO dates).',
    '',
    'A Ticket has: `id`, `ref`, `url`, `subject`, `status`, `priority` (1 Low, 2 Medium, 3 High, 4 Urgent), `type`, `origin` (`ticketpulse` or `freshservice`), `requester` `{ id, name, email }`, `assignee` `{ id, name, email }`, `category`, `subcategory`, `tags`, `ccEmails`, `dueBy`, `createdAt`, `updatedAt`.',
    '',
    `To search words in the subject, description and conversations: \`GET ${api}/search/tickets?query=printer&in=subject,description,conversations\`.`,
    '',
    '### Read a ticket and its conversation',
    '',
    fence('bash', `curl "${api}/tickets/${T}" ${auth}\ncurl "${api}/tickets/${T}/conversations" ${auth}`),
    '',
    'The first gives the ticket, its `description` and its public conversation. The second gives the whole conversation, private notes included: a list of `{ id, type, author, authorType, isPrivate, body, at }` (sort by `at` if order matters). `authorType` is `requester` for the requester\'s messages.',
    '',
  );

  if (can('reply')) {
    push(
      '### Reply to the requester',
      '',
      fence('bash', `curl -X POST "${api}/tickets/${T}/replies" \\\n  ${auth} ${json} \\\n  -H "Idempotency-Key: 3f2b9c1e-reply-1" \\\n  -d '{ "body": "<p>Hi Dana,</p><p>The printer on floor 3 is back online. Could you try printing again and tell me if it works?</p>" }'`),
      '',
      'The answer is `{ "success": true, "data": { "entryId": 9001, "emailed": true }, "warnings": [] }`.',
      '',
      '### Add a private note (only agents see it)',
      '',
      fence('bash', `curl -X POST "${api}/tickets/${T}/notes" \\\n  ${auth} ${json} \\\n  -H "Idempotency-Key: 3f2b9c1e-note-1" \\\n  -d '{ "body": "Checked the print server: the queue was paused after the update. Resumed it at 10:40." }'`),
      '',
      '### Writing the body',
      '',
      `- Send \`body\` as simple HTML or as plain text. HTML tags that work well: ${tags.recommended.map((t) => `\`<${t}>\``).join(', ')}. Links need \`<a href="https://…">\`. Anything else is removed${tags.alsoKept.length ? ` except ${tags.alsoKept.map((t) => `\`<${t}>\``).join(', ')}` : ''}.`,
      '- In plain text, each line break is kept as a line break. Put one empty line between paragraphs.',
      '- **No Markdown.** `**bold**`, `# headings` or `- lists` arrive as the literal characters. Use the HTML tags above instead.',
      `- **Do not add a signature, a sign-off name, or the earlier e-mails.** Ticket Pulse adds ${person.name ? `${person.name.split(' ')[0]}'s` : 'the person\'s'} own signature, the company e-mail template and the quoted history itself. If a reply ends with their signature anyway, Ticket Pulse removes that copy and the answer says \`"warnings": ["signature_removed"]\`.`,
      '- A short greeting ("Hi Dana,") is fine. Keep replies short and plain: say what was done and what you need from the requester.',
      '- Send each reply once. Give every reply and note its own `Idempotency-Key` (any unique text, a UUID is best): if a call times out, send it again with the SAME key and you get the first answer back instead of a second e-mail. A key is remembered for 24 hours; the same key with a different body is refused with `422`.',
      '',
      '### Warnings on a reply',
      '',
      'A reply that went through can still carry `warnings`:',
      '- `signature_removed`: the body ended with the person\'s own signature; that copy was dropped (it is added once by Ticket Pulse).',
      '- `requester_unattended`: the requester is an automated system (an alert or integration mailbox) that doesn\'t read replies. Use a private note for this ticket next time.',
      '- `requester_automated`: the requester address is a no-reply or automated sender, so nobody reads the reply. Use a private note for this ticket next time.',
      '',
    );
  }

  if (can('update')) {
    push(
      '### Change status, priority or assignment',
      '',
      fence('bash', `curl -X PATCH "${api}/tickets/${T}" \\\n  ${auth} ${json} \\\n  -d '{ "status": "Resolved", "priority": 2, "assignedTechEmail": "${person.email}" }'`),
      '',
      `Statuses and priorities for this workspace: \`GET ${api}/meta\`. Agents (for \`assignedTechEmail\` or \`assignedTechId\`): \`GET ${api}/agents?active=true\`. Other fields: \`subject\`, \`category\` and \`subcategory\` (by name, see \`GET ${api}/categories\`), \`internalGroupId\`, \`ccEmails\`, and \`addNote\` (a private note written after the change, in the same call). Tags: \`POST ${api}/tickets/${T}/tags\` with \`{ "name": "vpn" }\` adds one; \`DELETE ${api}/tickets/${T}/tags/vpn\` removes one.`,
      '',
    );
  }

  if (can('tasks')) {
    push(
      '### Tasks',
      '',
      fence('bash', `curl "${api}/tickets/${T}/tasks" ${auth}\ncurl -X POST "${api}/tickets/${T}/tasks" ${auth} ${json} \\\n  -d '{ "title": "Order a replacement toner", "dueAt": "2026-12-01T17:00:00-08:00" }'\n# status: open, in_progress or done\ncurl -X PATCH "${api}/tickets/${T}/tasks/55" ${auth} ${json} -d '{ "status": "done" }'`),
      '',
      'Time entries are not in the API yet.',
      '',
    );
  }

  push(
    '## FreshService tickets',
    '',
    'Tickets with `origin: "freshservice"` (references like `#123456`) follow the same rules as in the app: you can read them, reply and add notes; their status, assignment and fields belong to FreshService, so changing them here is refused (`403 fs_status_write_not_enabled` for status, `400` for assignment and fields). Ask the person to change those in the app.',
    '',
    '## When something goes wrong',
    '',
    'Errors are JSON (`application/problem+json`) with a stable `code`, a `detail` sentence and a `request_id`. Branch on `code`.',
    '',
    '| Status | What it means | What to do |',
    '|---|---|---|',
    '| 401 `invalid_api_key` | The key is wrong, revoked, switched off by an admin, or has ended. | Stop and tell the person. Don\'t retry. |',
    '| 403 `read_only_role` | The person\'s access is read-only now; the key can only read. | Stop changing things; tell the person. |',
    '| 403 `insufficient_scope` | This key wasn\'t given that ability. | Tell the person; they can make a key that has it. |',
    '| 403 `personal_key_owner_has_no_access` / `personal_key_not_allowed` | The person lost access to the workspace or their API access was removed. | Stop and tell the person. |',
    '| 403 `ip_not_allowed` | The key is locked to other IP addresses. | Run from an allowed address, or ask the person. |',
    '| 404 `not_found` | No such ticket here, or one the person can\'t see. | Check the reference. |',
    '| 409 | It clashes with the ticket\'s current state, or the same Idempotency-Key is still being processed. | Read the ticket again; retry the same key after a few seconds. |',
    '| 422 | A field the ticket doesn\'t have, or an Idempotency-Key reused with a different body. | Fix the request; use a new key for a new message. |',
    '| 429 `rate_limited` | Over the limit. | Wait `Retry-After` seconds, then continue. |',
    '| 5xx | Ticket Pulse or FreshService had a problem. | Wait a minute and retry once with the same Idempotency-Key. |',
    '',
    `Full reference: ${api}/docs (machine-readable: ${api}/openapi.json).`,
    '',
  );
  return lines.join('\n');
}

export default { buildPersonalKeyGuide, keptTags, GUIDE_FILENAME };
