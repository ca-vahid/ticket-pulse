/**
 * Auto-help tool registry v1 (plans/AUTO_HELP_PLAN.md → Tools).
 *
 * Every tool is READ-ONLY and scoped to the run's workspace, ticket and
 * playbook. Tool output is evidence, not instructions. Each executor records
 * the sources it showed the model into ctx.sources (so the runner can verify
 * that every cited id was actually seen) and their text into ctx.evidence
 * (for the output guard and the draft's link allowlist).
 *
 * Leak rules (25 Sep 2026 audit): nothing here returns internal/private
 * notes or FreshService resolution notes — only agent-VERIFIED solution
 * notes; other tickets are resolved/closed tickets of the same workspace,
 * found from THIS ticket's text only (the model cannot steer the search, and
 * TP-1234 / #241406 references in the text are stripped so a requester cannot
 * pull a named ticket); other requesters' names and e-mail addresses are
 * redacted from everything returned.
 *
 * Source ids the model cites:
 *   article:<id>   a knowledge article
 *   ticket:<id>    a resolved ticket (verified solution or similar ticket)
 *   playbook:<id>  the playbook's own instructions (admin-written guidance)
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';

export const SUBMIT_AUTO_HELP_TOOL = Object.freeze({
  name: 'submit_auto_help_reply',
  description: 'Submit the final result. Required, exactly once. Set answerable=false (and leave steps empty) when the sources do not clearly answer the request. It does not send anything.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['answerable'],
    properties: {
      answerable: { type: 'boolean', description: 'True only when the cited sources clearly answer this request.' },
      subject: { type: 'string', maxLength: 200, description: 'Reply subject line (short).' },
      intro: { type: 'string', maxLength: 1000, description: 'One or two plain sentences before the steps (optional). No greeting boilerplate, no signature.' },
      steps: {
        type: 'array',
        maxItems: 12,
        description: 'The answer as numbered steps. EVERY step names the source ids it comes from; a step you cannot source must not be written.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'sourceIds'],
          properties: {
            text: { type: 'string', maxLength: 1000, description: 'One step, requester-facing. Plain text; a link only when the exact URL appears in a cited source.' },
            sourceIds: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Source ids this step comes from (article:<id>, ticket:<id>, playbook:<id>).' },
          },
        },
      },
      outro: { type: 'string', maxLength: 1000, description: 'An optional closing sentence (not the "reply if you need help" line — that is added for you).' },
      confidence: { type: 'number', minimum: 0, maximum: 1, description: 'How sure you are this fully answers the request (0..1).' },
      reason: { type: 'string', description: 'When not answerable: one line on why (internal, never shown to the requester).' },
    },
  },
});

/** Tools a playbook may enable, with the one-line description the editor shows. */
export const AUTO_HELP_TOOLS = Object.freeze([
  {
    name: 'search_knowledge',
    label: 'Search knowledge',
    summary: 'Searches the published articles in this playbook\'s knowledge scope.',
    schema: {
      name: 'search_knowledge',
      description: 'Search the workspace knowledge articles this playbook may quote. Returns ids, titles and snippets.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to look for.' }, limit: { type: 'integer', minimum: 1, maximum: 5 } },
        required: ['query'],
      },
    },
  },
  {
    name: 'get_article',
    label: 'Read an article',
    summary: 'Reads the full text of one article found by search.',
    schema: {
      name: 'get_article',
      description: 'Read one knowledge article in full by id (the number in article:<id>).',
      input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    },
  },
  {
    name: 'find_similar_resolved_tickets',
    label: 'Similar resolved tickets',
    summary: 'Finds resolved tickets like this one that have an agent-verified solution.',
    schema: {
      name: 'find_similar_resolved_tickets',
      description: 'Find resolved tickets similar to THIS request that carry an agent-verified solution. Takes no input: it always searches with this ticket\'s own text.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    name: 'get_ticket_details',
    label: 'Ticket details',
    summary: 'Reads this ticket\'s subject, description and category (never internal notes).',
    schema: {
      name: 'get_ticket_details',
      description: 'Read the current ticket: subject, description, category, priority. Internal notes are never included.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    name: 'get_requester_profile',
    label: 'Requester profile',
    summary: 'Office, department, country and time zone from the stored directory profile.',
    schema: {
      name: 'get_requester_profile',
      description: 'Read the requester\'s stored directory profile: office, city, country, department, job title, time zone. No contact details.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
  },
]);

export const AUTO_HELP_TOOL_NAMES = Object.freeze(AUTO_HELP_TOOLS.map((t) => t.name));
export const ALL_AUTO_HELP_TOOL_NAMES = Object.freeze([...AUTO_HELP_TOOL_NAMES, SUBMIT_AUTO_HELP_TOOL.name]);

/** Provider tool schemas for a playbook: its allowed tools + the required terminal tool. */
export function toolSchemasFor(allowedTools = []) {
  const allowed = new Set(allowedTools || []);
  return [
    ...AUTO_HELP_TOOLS.filter((t) => allowed.has(t.name)).map((t) => t.schema),
    SUBMIT_AUTO_HELP_TOOL,
  ];
}

/** Public list for the editor (no schemas). */
export function toolCatalog() {
  return AUTO_HELP_TOOLS.map(({ name, label, summary }) => ({ name, label, summary }));
}

const MAX_ARTICLE_CHARS = 6000;
const MAX_NOTE_CHARS = 1200;
const MAX_SECTION_CHARS = 2500;
const EVIDENCE_KEEP = 8000;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const RESOLVED_BASES = ['Resolved', 'Closed'];

function clip(text, max) {
  const s = String(text || '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function remember(ctx, id, meta, text = null) {
  if (!ctx.sources.has(id)) ctx.sources.set(id, meta);
  if (text && ctx.evidence) {
    const prev = ctx.evidence.get(id) || '';
    if (String(text).length > prev.length) ctx.evidence.set(id, String(text).slice(0, EVIDENCE_KEEP));
  }
}

/** TP-1234 / #241406 references out of a text (so a search cannot be pointed at a named ticket). */
export function stripTicketRefs(text) {
  return String(text || '')
    .replace(/\bTP-\d{1,7}\b/gi, ' ')
    .replace(/(^|[^\w])#\d{4,12}\b/g, '$1 ');
}

/**
 * Another requester's identity out of a text: their name (and its parts of
 * 3+ letters) and e-mail, plus any e-mail address at all.
 */
export function redactPeople(text, people = []) {
  let out = String(text || '');
  for (const p of people || []) {
    const parts = [p?.email, p?.name, ...String(p?.name || '').split(/\s+/)]
      .map((x) => String(x || '').trim())
      .filter((x) => x.length >= 3)
      .sort((a, b) => b.length - a.length);
    for (const part of parts) {
      const esc = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'giu'), 'the requester');
    }
  }
  return out.replace(EMAIL_RE, '[e-mail removed]');
}

async function searchKnowledge(input, ctx) {
  const { default: knowledgeArticleService } = await import('./knowledgeArticleService.js');
  const scope = ctx.playbook.kbScope || {};
  const hits = await knowledgeArticleService.search(ctx.workspaceId, String(input.query || '').slice(0, 500), {
    limit: Math.min(Number(input.limit) || 5, 5),
    tags: scope.mode === 'tags' ? scope.tags : null,
    categoryId: ctx.ticket.internalCategoryId,
    subcategoryId: ctx.ticket.internalSubcategoryId,
  });
  // R2: the model reads the best-matching SECTION (+ title), not whole bodies.
  for (const h of hits) {
    remember(ctx, `article:${h.id}`, {
      type: 'article', id: h.id, title: h.title, section: h.section?.heading || null, stale: h.stale === true,
    }, `${h.title}\n${h.section?.heading || ''}\n${h.section?.text || h.snippet || ''}`);
  }
  return {
    results: hits.map((h) => ({
      sourceId: `article:${h.id}`,
      title: h.title,
      section: h.section?.heading || null,
      text: clip(h.section?.text || h.snippet, MAX_SECTION_CHARS),
      score: h.score,
    })),
  };
}

/** The best `take` sections of an article for this ticket (keyword overlap), in article order. */
async function bestSections(ctx, sections, take = 2) {
  const { queryTokens, keywordScore } = await import('./knowledgeArticleService.js');
  const tokens = queryTokens(`${ctx.ticket.subject || ''}\n${ctx.ticket.descriptionText || ''}`);
  return sections
    .map((sec, index) => ({ sec, index, score: keywordScore(tokens, { title: sec.heading || '', bodyText: sec.text || '' }) }))
    .sort((x, y) => (y.score - x.score) || (x.index - y.index))
    .slice(0, take)
    .sort((x, y) => x.index - y.index);
}

async function getArticle(input, ctx) {
  const id = Number(input.id);
  if (!Number.isInteger(id)) return { error: 'id must be the number in article:<id>' };
  const scope = ctx.playbook.kbScope || {};
  const row = await Promise.resolve()
    .then(() => prisma.knowledgeArticle.findFirst({
      where: { id, workspaceId: ctx.workspaceId, status: 'published', ...(scope.mode === 'tags' && scope.tags?.length ? { tags: { hasSome: scope.tags } } : {}) },
      select: { id: true, title: true, bodyText: true, tags: true, sections: true },
    }))
    .catch(() => null);
  if (!row) return { error: 'Article not found or not in this playbook\'s scope' };
  const sections = Array.isArray(row.sections) ? row.sections.filter((x) => x && x.text) : [];
  if (sections.length > 1) {
    const picked = await bestSections(ctx, sections);
    const shown = picked.map(({ sec }) => ({ heading: sec.heading || '', text: clip(sec.text, MAX_SECTION_CHARS) }));
    remember(ctx, `article:${row.id}`, { type: 'article', id: row.id, title: row.title, section: shown[0]?.heading || null },
      `${row.title}\n${shown.map((x) => `${x.heading}\n${x.text}`).join('\n\n')}`);
    return {
      sourceId: `article:${row.id}`,
      title: row.title,
      tags: row.tags,
      sections: shown,
      otherSections: sections.map((x, i) => ({ i, heading: x.heading || '' })).filter(({ i }) => !picked.some((p) => p.index === i)).map((x) => x.heading).filter(Boolean),
    };
  }
  remember(ctx, `article:${row.id}`, { type: 'article', id: row.id, title: row.title }, `${row.title}\n${row.bodyText || ''}`);
  return { sourceId: `article:${row.id}`, title: row.title, tags: row.tags, text: clip(row.bodyText, MAX_ARTICLE_CHARS) };
}

async function findSimilarResolved(_input, ctx) {
  // The model's input is ignored on purpose: the search text is this ticket's
  // own subject + description, with ticket references stripped.
  const { default: similarity } = await import('./ticketSimilaritySearchService.js');
  const { default: statusService } = await import('./statusService.js');
  const text = stripTicketRefs(`${ctx.ticket.subject || ''}\n${ctx.ticket.descriptionText || ''}`).replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (text.length < 3) return { results: [] };
  const out = await similarity.search(ctx.workspaceId, [{ key: 'q', text }], { status: ['resolved', 'closed'], limit: 5, minScore: 0.55 });
  const hitIds = (out?.results?.q || []).map((h) => Number(h.id)).filter((id) => id && id !== ctx.ticket.id);
  if (!hitIds.length) return { results: [] };
  const rows = await Promise.resolve()
    .then(() => prisma.ticket.findMany({
      where: { workspaceId: ctx.workspaceId, id: { in: hitIds }, solutionVerifiedAt: { not: null } },
      select: {
        id: true, workspaceId: true, subject: true, status: true, solutionNote: true, solutionVerifiedAt: true,
        origin: true, nativeNumber: true, freshserviceTicketId: true,
        requester: { select: { name: true, email: true } },
      },
    }))
    .catch(() => []);
  const scoreById = new Map((out?.results?.q || []).map((h) => [Number(h.id), h.score]));
  const results = [];
  for (const r of rows) {
    if (r.workspaceId !== ctx.workspaceId || r.id === ctx.ticket.id) continue;
    const note = String(r.solutionNote || '').trim();
    if (!note) continue;
    const base = await Promise.resolve().then(() => statusService.resolveBaseStatus(ctx.workspaceId, r.status)).catch(() => null);
    if (!RESOLVED_BASES.includes(base)) continue;
    const people = r.requester ? [r.requester] : [];
    const subject = redactPeople(r.subject || '', people);
    const solution = redactPeople(clip(note, MAX_NOTE_CHARS), people);
    remember(ctx, `ticket:${r.id}`, { type: 'ticket', id: r.id, title: subject }, `${subject}\n${solution}`);
    results.push({ sourceId: `ticket:${r.id}`, subject, score: scoreById.get(r.id) ?? null, verifiedSolution: solution });
  }
  results.sort((x, y) => (y.score || 0) - (x.score || 0));
  return { results };
}

/** The CURRENT ticket's public content only (subject, description, category) — never notes. */
function ticketDetails(_input, ctx) {
  const t = ctx.ticket;
  return {
    subject: t.subject || '',
    description: clip(t.descriptionText, 4000),
    category: t.internalCategory?.name || null,
    subcategory: t.internalSubcategory?.name || null,
    priority: t.priority ?? null,
    createdAt: t.createdAt || null,
    requesterName: t.requester?.name || null,
  };
}

function requesterProfile(_input, ctx) {
  const r = ctx.ticket.requester;
  if (!r) return { profile: null };
  return {
    profile: {
      name: r.name || null,
      department: r.entraDepartment || r.department || null,
      jobTitle: r.entraJobTitle || r.jobTitle || null,
      office: r.entraOfficeLocation || null,
      city: r.entraCity || null,
      state: r.entraState || null,
      country: r.entraCountry || null,
      timeZone: r.timeZone || null,
      language: r.entraPreferredLanguage || r.language || null,
    },
  };
}

const EXECUTORS = {
  search_knowledge: searchKnowledge,
  get_article: getArticle,
  find_similar_resolved_tickets: findSimilarResolved,
  get_ticket_details: ticketDetails,
  get_requester_profile: requesterProfile,
};

/**
 * Run one tool for the model. Unknown or disallowed tools return an error
 * object (the model sees it and can recover); nothing here throws.
 */
export async function executeAutoHelpTool(name, input, ctx) {
  const allowed = new Set(ctx.playbook.allowedTools || []);
  if (!EXECUTORS[name] || !allowed.has(name)) return { error: `Tool ${name} is not available for this playbook` };
  try {
    return await EXECUTORS[name](input || {}, ctx);
  } catch (err) {
    logger.warn(`Auto-help tool ${name} failed (ticket ${ctx.ticket?.id}): ${err.message}`);
    return { error: `Tool ${name} failed` };
  }
}
