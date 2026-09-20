/**
 * Reply greeting + sign-off (QA 09-18 #4) — the client-side half of
 * backend/src/services/replyGreetingService.js: fill the placeholders and
 * wrap a reply body with the workspace's two lines.
 *
 * Placeholders: {{requester.firstName}} {{requester.name}} {{agent.firstName}}
 * {{agent.name}} {{ticket.ref}} {{ticket.subject}}. Unknown tokens are dropped
 * rather than mailed literally.
 */
import { escapeHtml } from './plainTextToHtml';

export const GREETING_PLACEHOLDERS = [
  { token: '{{requester.firstName}}', hint: "the requester's first name" },
  { token: '{{requester.name}}', hint: "the requester's full name" },
  { token: '{{agent.firstName}}', hint: 'your first name' },
  { token: '{{agent.name}}', hint: 'your full name' },
  { token: '{{ticket.ref}}', hint: 'the ticket reference' },
  { token: '{{ticket.subject}}', hint: 'the ticket subject' },
];

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const nameFromEmail = (email) => String(email || '').split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function fillGreetingPlaceholders(text, { requester = null, agent = null, ticket = null } = {}) {
  const map = {
    'requester.firstName': firstName(requester?.name) || firstName(nameFromEmail(requester?.email)) || 'there',
    'requester.name': String(requester?.name || '').trim() || nameFromEmail(requester?.email) || 'there',
    'agent.firstName': firstName(agent?.name) || '',
    'agent.name': String(agent?.name || '').trim(),
    'ticket.ref': String(ticket?.displayRef || ticket?.ref || '').trim(),
    'ticket.subject': String(ticket?.subject || '').trim(),
  };
  return String(text || '').replace(/\{\{\s*([a-zA-Z.]+)\s*\}\}/g, (_, key) => (key in map ? map[key] : ''));
}

/** One paragraph per line group; blank lines inside a block become <br>. */
function linesToHtml(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  if (!lines.some((l) => l.trim())) return '';
  return `<p>${lines.map((l) => escapeHtml(l)).join('<br>')}</p>`;
}

const stripTags = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Greeting above, sign-off below, one empty paragraph between each and the
 * body so the caret lands in the middle. Idempotent: a body that already
 * opens with the greeting is left alone.
 */
export function wrapWithGreeting(bodyHtml, settings, ctx) {
  const greeting = fillGreetingPlaceholders(settings?.greeting, ctx).trim();
  const signoff = fillGreetingPlaceholders(settings?.signoff, ctx).trim();
  const body = String(bodyHtml || '').trim();
  const bodyText = stripTags(body);
  const alreadyGreeted = greeting && bodyText.toLowerCase().startsWith(stripTags(greeting).toLowerCase());
  if (alreadyGreeted) return body;
  const head = greeting ? `${linesToHtml(greeting)}<p><br></p>` : '';
  const tail = signoff ? `<p><br></p>${linesToHtml(signoff)}` : '';
  const middle = bodyText ? body : '<p><br></p>';
  return `${head}${middle}${tail}`;
}
