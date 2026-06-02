const STRICT_FORBIDDEN_PUBLIC_PATTERNS = [
  {
    id: 'unsupported_outage_claims',
    pattern: /\b(global|company-wide|confirmed)\s+outage\b/i,
    message: 'Requester-facing email cannot claim a global/company-wide/confirmed outage without confirmed evidence.',
  },
  {
    id: 'internal_tool_names',
    pattern: /\b(get_notification_context|get_ticket_thread_summary|find_similar_tickets|detect_related_ticket_spike|search_recent_tickets|submit_notification_email)\b/i,
    message: 'Requester-facing email cannot mention internal tool names.',
  },
  {
    id: 'workflow_audit_identifiers',
    pattern: /\baudit\s+id\b|\btp-nwf-\d*\b/i,
    message: 'Requester-facing email cannot mention workflow audit identifiers.',
  },
  {
    id: 'private_internal_notes',
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
const COPY_REPAIR_GUARDRAILS = new Set([
  'unsupported_outage_claims',
  'unsupported_timing_claims',
  'emoji',
  'playful_tone',
  'similar_report_claim_without_evidence',
]);

function guardError(message, issues = [message], issueDetails = []) {
  const error = new Error(message);
  error.guardRejected = true;
  error.guard = {
    accepted: false,
    issues: Array.isArray(issues) ? issues : [String(issues)],
    issueDetails,
    blockedBy: issueDetails.map((issue) => issue.id).filter(Boolean),
  };
  return error;
}

function guardIssue(id, message, action = 'block', extra = {}) {
  return {
    id,
    action,
    message,
    ...extra,
  };
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
  const businessWindow = contextBundle.businessWindow || contextBundle.availability || {};
  if (businessWindow.nextBusinessTime || businessWindow.nextBusinessTimeLocal) return true;
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

function deterministicTimingSentence(contextBundle = {}) {
  const businessWindow = contextBundle.businessWindow || contextBundle.availability || {};
  if (businessWindow.nextBusinessTimeLocal) {
    return `Our next scheduled business-hours window starts ${businessWindow.nextBusinessTimeLocal}.`;
  }
  return null;
}

function sensitiveRequesterContext(contextBundle = {}) {
  const bundle = contextBundle || {};
  const ticket = bundle.ticket || {};
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

function stripHtml(value = '') {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#128640;/g, '🚀')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function textToHtml(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph.trim())}</p>`)
    .join('');
}

function splitSentences(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function removeMatchingSentences(value, pattern, replacement = null) {
  const sentences = splitSentences(value);
  const removed = [];
  const kept = [];
  for (const sentence of sentences) {
    if (pattern.test(sentence)) {
      removed.push(sentence);
    } else {
      kept.push(sentence);
    }
  }
  if (removed.length > 0 && replacement && !kept.some((sentence) => sentence === replacement)) {
    kept.push(replacement);
  }
  return {
    changed: removed.length > 0,
    removed,
    text: kept.join(' ').replace(/\s+/g, ' ').trim(),
  };
}

function repairSentencePayload(payload, pattern, replacement = null) {
  const sourceText = String(payload.text || payload.body || '').trim()
    || stripHtml(payload.html || payload.bodyHtml || '');
  const repairedText = removeMatchingSentences(sourceText, pattern, replacement);
  const repairedSubject = removeMatchingSentences(payload.subject || '', pattern, null);
  if (!repairedText.changed && !repairedSubject.changed) {
    return { payload, removed: [] };
  }
  const nextText = repairedText.text || sourceText;
  return {
    payload: {
      ...payload,
      subject: repairedSubject.changed
        ? (repairedSubject.text || String(payload.subject || '').replace(pattern, '').trim() || 'Ticket update')
        : payload.subject,
      html: textToHtml(nextText),
      text: nextText,
    },
    removed: [...repairedText.removed, ...repairedSubject.removed],
  };
}

function repairEmojiPayload(payload) {
  const repair = (value) => String(value || '').replace(EMOJI_PATTERN, '').replace(/\s+/g, ' ').trim();
  return {
    payload: {
      ...payload,
      subject: repair(payload.subject),
      html: repair(payload.html || payload.bodyHtml),
      text: repair(payload.text || payload.body),
    },
    removed: ['emoji'],
  };
}

function repairPlayfulPayload(payload) {
  const repair = (value) => String(value || '')
    .replace(PLAYFUL_COPY_PATTERN, 'stable')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    payload: {
      ...payload,
      subject: repair(payload.subject),
      html: repair(payload.html || payload.bodyHtml),
      text: repair(payload.text || payload.body),
    },
    removed: ['playful wording'],
  };
}

function repairGuardrailPayload(payload, issue, contextBundle) {
  if (!COPY_REPAIR_GUARDRAILS.has(issue.id)) return { payload, removed: [] };
  if (issue.id === 'emoji') return repairEmojiPayload(payload);
  if (issue.id === 'playful_tone') return repairPlayfulPayload(payload);
  if (issue.id === 'unsupported_timing_claims') {
    return repairSentencePayload(payload, UNSUPPORTED_TIMING_PATTERN, deterministicTimingSentence(contextBundle));
  }
  if (issue.id === 'unsupported_outage_claims') {
    return repairSentencePayload(payload, /\b(global|company-wide|confirmed)\s+outage\b/i, null);
  }
  if (issue.id === 'similar_report_claim_without_evidence') {
    return repairSentencePayload(payload, /\bmultiple similar reports\b/i, null);
  }
  return { payload, removed: [] };
}

export function guardNotificationEmailPayload(payload, {
  contextBundle = null,
  extraEvidenceIds = [],
  strictCitations = false,
  allowEmoji = false,
  allowPlayfulTone = false,
  disabledGuardrails = [],
  repairGuardrails = [],
} = {}) {
  const disabled = new Set(disabledGuardrails || []);
  const repairable = new Set(repairGuardrails || []);
  let nextPayload = { ...(payload || {}) };
  let content = textFields(nextPayload);
  const issueDetails = [];
  const repairedIssues = [];
  const skippedChecks = [...disabled];
  const handleIssue = (issue) => {
    if (disabled.has(issue.id)) return;
    if (repairable.has(issue.id)) {
      const repaired = repairGuardrailPayload(nextPayload, issue, contextBundle || {});
      nextPayload = repaired.payload;
      content = textFields(nextPayload);
      const repairedIssue = {
        ...issue,
        action: 'repaired',
        removed: repaired.removed || [],
      };
      issueDetails.push(repairedIssue);
      repairedIssues.push(repairedIssue);
      return;
    }
    issueDetails.push(issue);
    throw guardError(issue.message, [issue.message], [issue]);
  };
  const allowedPublicPhrases = (contextBundle?.outageSignals?.allowedPublicPhrases || [])
    .map((phrase) => String(phrase || '').toLowerCase());

  for (const guard of STRICT_FORBIDDEN_PUBLIC_PATTERNS) {
    if (!guard.pattern.test(content)) continue;
    handleIssue(guardIssue(guard.id, guard.message));
  }

  const providerIssues = providerLeakIssues(content, contextBundle);
  if (providerIssues.length > 0 && !disabled.has('provider_model_internals')) {
    const issue = guardIssue('provider_model_internals', 'Requester-facing email cannot mention model/provider/audit internals.', 'block', {
      issues: providerIssues,
    });
    issueDetails.push(issue);
    throw guardError(issue.message, providerIssues, [issue]);
  }

  if (!allowEmoji && EMOJI_PATTERN.test(content)) {
    handleIssue(guardIssue('emoji', 'Requester-facing workflow emails cannot include emoji unless explicitly allowed.'));
  }

  if (!allowPlayfulTone && sensitiveRequesterContext(contextBundle) && PLAYFUL_COPY_PATTERN.test(content)) {
    handleIssue(guardIssue('playful_tone', 'Requester-facing workflow emails cannot use playful metaphors for sensitive or high-priority ticket contexts.'));
  }

  if (UNSUPPORTED_TIMING_PATTERN.test(content) && !hasTimingEvidence(contextBundle || {})) {
    handleIssue(guardIssue('unsupported_timing_claims', 'Requester-facing email cannot include response-time or resolution-time claims without deterministic timing evidence.'));
  }

  if (/\bmultiple similar reports\b/i.test(content)
    && !allowedPublicPhrases.includes('we are seeing multiple similar reports')) {
    handleIssue(guardIssue('similar_report_claim_without_evidence', '"Multiple similar reports" wording requires deterministic related-ticket evidence.'));
  }

  const citedSignals = Array.isArray(payload?.citedSignals)
    ? payload.citedSignals.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (strictCitations && citedSignals.length > 0) {
    const allowedIds = collectEvidenceIdsFromContext(contextBundle || {});
    for (const id of extraEvidenceIds || []) allowedIds.add(String(id));
    const unknown = citedSignals.filter((id) => !allowedIds.has(id));
    if (unknown.length > 0) {
      const issue = guardIssue('unknown_cited_evidence_ids', `LLM cited unknown evidence id(s): ${unknown.join(', ')}`, 'block', { unknown });
      issueDetails.push(issue);
      throw guardError(issue.message, [issue.message], [issue]);
    }
  }

  return {
    accepted: true,
    citedSignals,
    allowedPublicPhrases,
    payload: nextPayload,
    issueDetails,
    repairedIssues,
    skippedChecks,
    issues: [],
  };
}

export { collectEvidenceIds, collectEvidenceIdsFromContext };
