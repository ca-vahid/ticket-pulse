const STRICT_FORBIDDEN_PUBLIC_PATTERNS = [
  {
    pattern: /\b(global|company-wide|confirmed)\s+outage\b/i,
    message: 'Requester-facing email cannot claim a global/company-wide/confirmed outage without confirmed evidence.',
  },
  {
    pattern: /\b(get_notification_context|get_ticket_thread_summary|find_similar_tickets|detect_related_ticket_spike|search_recent_tickets|submit_notification_email)\b/i,
    message: 'Requester-facing email cannot mention internal tool names.',
  },
  {
    pattern: /\baudit\s+id\b|\btp-nwf-\d*\b/i,
    message: 'Requester-facing email cannot mention workflow audit identifiers.',
  },
  {
    pattern: /\bprivate note\b|\binternal note\b/i,
    message: 'Requester-facing email cannot quote or mention private/internal notes.',
  },
];

const AI_PRODUCT_PATTERN = /\b(openai|anthropic|claude|gpt(?:-[a-z0-9._-]+)?)\b/gi;
const PROVIDER_PLUMBING_PATTERN = /\b(?:openai|anthropic|claude|gpt(?:-[a-z0-9._-]+)?)\s+(?:provider|model|fallback|attempt|gateway|api|token|prompt|llm)\b|\b(?:provider|model|fallback|attempt|gateway|api|token|prompt|llm)\s+(?:openai|anthropic|claude|gpt(?:-[a-z0-9._-]+)?)\b/gi;
const UNSUPPORTED_TIMING_PATTERN = /\b(?:within\s+\d+\s+(?:business\s+)?(?:minute|hour|day|week)s?|by\s+(?:end of day|tomorrow|the next business day)|typically|usually|often\s+(?:resolved|completed|handled|addressed)|estimated\s+(?:response|resolution)|expected\s+(?:response|resolution))\b/i;
const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const PLAYFUL_COPY_PATTERN = /\b(?:bedrock|rock solid|launchpad|launch pad|blast off|mission control|magic|sparkle|sprinkle|wizard|core sample|loose colluvium|good ground)\b/i;
const SENSITIVE_CONTEXT_PATTERN = /\b(?:security|identity|access|password|mfa|sso|vpn|urgent|high|onboarding|new hire|hardware|laptop|desktop|workstation|failure|failed|executive|vip)\b/i;

function guardError(message, issues = [message]) {
  const error = new Error(message);
  error.guardRejected = true;
  error.guard = {
    accepted: false,
    issues: Array.isArray(issues) ? issues : [String(issues)],
  };
  return error;
}

function textFields(payload = {}) {
  return [payload.subject, payload.html, payload.text]
    .map((value) => String(value || ''))
    .join('\n');
}

function normalizeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^a-z0-9._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function contextEvidenceText(bundle = {}) {
  const parts = [
    bundle.ticket?.subject,
    bundle.ticket?.descriptionText,
    bundle.ticket?.category,
    bundle.ticket?.subCategory,
    bundle.ticket?.ticketCategory,
    bundle.ticket?.tpSkill,
    bundle.ticket?.tpSubskill,
    bundle.ticket?.internalCategory?.name,
    bundle.ticket?.internalSubcategory?.name,
  ];
  for (const entry of bundle.threadSummary?.entries || []) {
    parts.push(entry?.title, entry?.content);
  }
  for (const window of bundle.recentSimilarTickets?.windows || []) {
    for (const item of window.items || []) {
      parts.push(item?.subject, item?.category, item?.subCategory, item?.ticketCategory);
    }
  }
  return normalizeText(parts.filter(Boolean).join(' '));
}

function contextContains(evidenceText, value) {
  const normalized = normalizeText(value);
  if (!normalized) return false;
  return evidenceText.includes(normalized);
}

function providerLeakIssues(content, contextBundle) {
  const issues = [];
  const evidence = contextEvidenceText(contextBundle || {});

  for (const match of content.matchAll(PROVIDER_PLUMBING_PATTERN)) {
    const phrase = match[0];
    if (!contextContains(evidence, phrase)) {
      issues.push(`Model/provider plumbing phrase is not supported by ticket evidence: ${phrase}`);
    }
  }

  for (const match of content.matchAll(AI_PRODUCT_PATTERN)) {
    const term = match[0];
    if (!contextContains(evidence, term)) {
      issues.push(`AI provider/model term is not supported by ticket evidence: ${term}`);
    }
  }

  return [...new Set(issues)];
}

function hasTimingEvidence(contextBundle = {}) {
  const candidates = [
    contextBundle.timingEvidence,
    contextBundle.sla,
    contextBundle.slaEvidence,
    contextBundle.historicalTiming,
    contextBundle.ticket?.timingEvidence,
  ].filter(Boolean);
  return candidates.some((item) => {
    if (item.supported === true || item.deterministic === true) return true;
    const sampleSize = Number(item.sampleSize || item.samples || 0);
    return Number.isFinite(sampleSize) && sampleSize >= 30 && item.metric;
  });
}

function sensitiveRequesterContext(contextBundle = {}) {
  const ticket = contextBundle.ticket || {};
  const text = [
    ticket.priorityLabel,
    ticket.assessedPriority,
    ticket.category,
    ticket.subCategory,
    ticket.ticketCategory,
    ticket.tpSkill,
    ticket.tpSubskill,
    ticket.internalCategory?.name,
    ticket.internalSubcategory?.name,
    ticket.subject,
  ].filter(Boolean).join(' ');
  const priority = String(ticket.priorityLabel || ticket.assessedPriority || '').toLowerCase();
  return ['high', 'urgent'].includes(priority) || SENSITIVE_CONTEXT_PATTERN.test(text);
}

function collectEvidenceIdsFromContext(bundle = {}) {
  const ids = new Set([
    'notification_context',
    'ticket',
    'requester',
    'assigned_agent',
    'recipients',
    'business_window',
    'outage_signals',
    'priority_signals',
    'action_links',
  ]);
  for (const entry of bundle.threadSummary?.entries || []) {
    if (entry?.evidenceId) ids.add(entry.evidenceId);
  }
  for (const window of bundle.recentSimilarTickets?.windows || []) {
    for (const item of window.items || []) {
      if (item?.evidenceId) ids.add(item.evidenceId);
    }
  }
  return ids;
}

function collectEvidenceIds(value, ids = new Set()) {
  if (!value || typeof value !== 'object') return ids;
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceIds(item, ids);
    return ids;
  }
  if (typeof value.evidenceId === 'string' && value.evidenceId.trim()) {
    ids.add(value.evidenceId.trim());
  }
  for (const child of Object.values(value)) collectEvidenceIds(child, ids);
  return ids;
}

export function guardNotificationEmailPayload(payload, {
  contextBundle = null,
  extraEvidenceIds = [],
  strictCitations = false,
  allowEmoji = false,
  allowPlayfulTone = false,
} = {}) {
  const content = textFields(payload);
  const allowedPublicPhrases = (contextBundle?.outageSignals?.allowedPublicPhrases || [])
    .map((phrase) => String(phrase || '').toLowerCase());

  for (const guard of STRICT_FORBIDDEN_PUBLIC_PATTERNS) {
    if (!guard.pattern.test(content)) continue;
    throw guardError(guard.message);
  }

  const providerIssues = providerLeakIssues(content, contextBundle);
  if (providerIssues.length > 0) {
    throw guardError('Requester-facing email cannot mention model/provider/audit internals.', providerIssues);
  }

  if (!allowEmoji && EMOJI_PATTERN.test(content)) {
    throw guardError('Requester-facing workflow emails cannot include emoji unless explicitly allowed.');
  }

  if (!allowPlayfulTone && sensitiveRequesterContext(contextBundle) && PLAYFUL_COPY_PATTERN.test(content)) {
    throw guardError('Requester-facing workflow emails cannot use playful metaphors for sensitive or high-priority ticket contexts.');
  }

  if (UNSUPPORTED_TIMING_PATTERN.test(content) && !hasTimingEvidence(contextBundle || {})) {
    throw guardError('Requester-facing email cannot include response-time or resolution-time claims without deterministic timing evidence.');
  }

  if (/\bmultiple similar reports\b/i.test(content)
    && !allowedPublicPhrases.includes('we are seeing multiple similar reports')) {
    throw guardError('"Multiple similar reports" wording requires deterministic related-ticket evidence.');
  }

  const citedSignals = Array.isArray(payload?.citedSignals)
    ? payload.citedSignals.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (strictCitations && citedSignals.length > 0) {
    const allowedIds = collectEvidenceIdsFromContext(contextBundle || {});
    for (const id of extraEvidenceIds || []) allowedIds.add(String(id));
    const unknown = citedSignals.filter((id) => !allowedIds.has(id));
    if (unknown.length > 0) {
      throw guardError(`LLM cited unknown evidence id(s): ${unknown.join(', ')}`);
    }
  }

  return {
    accepted: true,
    citedSignals,
    allowedPublicPhrases,
    issues: [],
  };
}

export { collectEvidenceIds, collectEvidenceIdsFromContext };
