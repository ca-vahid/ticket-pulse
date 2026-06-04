export const NOTIFICATION_GUARD_POLICY_TIERS = Object.freeze({
  HARD_BLOCK: 'hard_block',
  AUTO_REPAIR: 'auto_repair',
  AUDIT_ONLY: 'audit_only',
});

export const HARD_BLOCK_GUARD_CHECKS = Object.freeze([
  'internal_tool_names',
  'provider_model_internals',
  'workflow_audit_identifiers',
  'private_internal_notes',
  'direct_email_address',
  'direct_phone_number',
  'base64_image_data',
  'inline_image_or_avatar',
  'unsafe_html_or_script',
]);

export const AUTO_REPAIR_GUARD_CHECKS = Object.freeze([
  'unsupported_outage_claims',
  'unsupported_timing_claims',
  'similar_report_claim_without_evidence',
  'unknown_cited_evidence_ids',
]);

export const AUDIT_ONLY_GUARD_CHECKS = Object.freeze([
  'emoji',
  'playful_tone',
]);

const GUARD_RULE_TIERS = Object.freeze(Object.fromEntries([
  ...HARD_BLOCK_GUARD_CHECKS.map((id) => [id, NOTIFICATION_GUARD_POLICY_TIERS.HARD_BLOCK]),
  ...AUTO_REPAIR_GUARD_CHECKS.map((id) => [id, NOTIFICATION_GUARD_POLICY_TIERS.AUTO_REPAIR]),
  ...AUDIT_ONLY_GUARD_CHECKS.map((id) => [id, NOTIFICATION_GUARD_POLICY_TIERS.AUDIT_ONLY]),
]));

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
const EMAIL_ADDRESS_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_CONTEXT_PATTERN = /\b(?:phone|mobile|cell|call|text|sms)\s*(?:number|at|is|:)?\s*(?:\+?\d[\d\s().-]{7,}\d)\b/i;
const BASE64_IMAGE_PATTERN = /data:image\/[a-z0-9.+-]+;base64,/i;
const INLINE_IMAGE_PATTERN = /<img\b|\b(?:avatar|photo)\s*(?:url|image|link)?\s*[:=]/i;
const UNSAFE_HTML_PATTERN = /<script\b|javascript:/i;
const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const PLAYFUL_COPY_PATTERN = /\b(?:bedrock|rock solid|launchpad|launch pad|blast off|mission control|magic|sparkle|sprinkle|wizard|core sample|loose colluvium|good ground)\b/i;
const SENSITIVE_CONTEXT_PATTERN = /\b(?:security|identity|access|password|mfa|sso|vpn|urgent|high|onboarding|new hire|hardware|laptop|desktop|workstation|failure|failed|executive|vip)\b/i;
const COPY_REPAIR_GUARDRAILS = new Set([
  'unsupported_outage_claims',
  'unsupported_timing_claims',
  'similar_report_claim_without_evidence',
  'emoji',
  'playful_tone',
]);

function guardError(message, issues = [message], issueDetails = []) {
  const error = new Error(message);
  error.guardRejected = true;
  error.guard = {
    accepted: false,
    issues: Array.isArray(issues) ? issues : [String(issues)],
    issueDetails,
    blockedBy: issueDetails.map((issue) => issue.ruleId || issue.id).filter(Boolean),
  };
  return error;
}

function defaultActionForTier(policyTier) {
  if (policyTier === NOTIFICATION_GUARD_POLICY_TIERS.AUTO_REPAIR) return 'repair';
  if (policyTier === NOTIFICATION_GUARD_POLICY_TIERS.AUDIT_ONLY) return 'warn';
  return 'block';
}

function normalizeActionTaken(action) {
  if (action === 'block') return 'blocked';
  if (action === 'repair') return 'repaired';
  if (action === 'warn') return 'warned';
  return action;
}

function guardIssue(id, message, action = null, extra = {}) {
  const policyTier = extra.policyTier || GUARD_RULE_TIERS[id] || NOTIFICATION_GUARD_POLICY_TIERS.HARD_BLOCK;
  const actionValue = action || defaultActionForTier(policyTier);
  return {
    id,
    ruleId: id,
    policyTier,
    action: actionValue,
    actionTaken: normalizeActionTaken(actionValue),
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
  const ticket = contextBundle.ticket || {};
  if (ticket.dueBy || ticket.frDueBy) return true;
  const candidates = [
    contextBundle.timingEvidence,
    contextBundle.sla,
    contextBundle.slaEvidence,
    contextBundle.historicalTiming,
    ticket.timingEvidence,
  ].filter(Boolean);
  return candidates.some((item) => {
    if (item.supported === true && (item.deterministic === true || item.source === 'freshservice_sla_due_dates')) return true;
    if (item.deterministic === true && (item.dueBy || item.firstResponseDueBy || item.frDueBy)) return true;
    if (item.dueBy || item.firstResponseDueBy || item.frDueBy) return true;
    const sampleSize = Number(item.sampleSize || item.samples || 0);
    const confidence = String(item.confidence || item.confidenceLevel || '').toLowerCase();
    return Number.isFinite(sampleSize) && sampleSize >= 30 && item.metric && confidence !== 'low';
  });
}

function deterministicTimingSentence(contextBundle = {}) {
  const timingEvidence = contextBundle.timingEvidence || contextBundle.ticket?.timingEvidence || {};
  const firstResponseDueBy = contextBundle.ticket?.frDueBy || timingEvidence.firstResponseDueBy || timingEvidence.frDueBy;
  const dueBy = contextBundle.ticket?.dueBy || timingEvidence.dueBy;
  if (firstResponseDueBy) return `FreshService lists the first-response due time as ${firstResponseDueBy}.`;
  if (dueBy) return `FreshService lists the ticket due time as ${dueBy}.`;
  return 'The team has the ticket and will follow up from the ticket.';
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

function contentMentionsAny(value = '', candidates = []) {
  const content = String(value || '');
  return candidates.filter((candidate) => {
    const text = String(candidate || '').trim();
    return text && content.includes(text);
  });
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

function replaceHtmlBlocks(value = '', pattern, replacement = null) {
  const html = String(value || '');
  if (!html.trim()) return { changed: false, removed: [], html };

  let changed = false;
  const removed = [];
  let insertedReplacement = false;
  const hasParagraphLikeBlocks = /<\/?(p|li)\b/i.test(html);
  const blockPattern = hasParagraphLikeBlocks
    ? /<(p|li)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi
    : /<(p|li|div)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  const nextHtml = html.replace(blockPattern, (match, tag, attrs = '', inner) => {
    const originalText = stripHtml(inner);
    const repaired = removeMatchingSentences(originalText, pattern, null);
    if (!repaired.changed) return match;
    changed = true;
    removed.push(...repaired.removed);
    if (!repaired.text) return '';
    return `<${tag}${attrs}>${escapeHtml(repaired.text)}</${tag}>`;
  });

  if (changed && replacement && !stripHtml(nextHtml).includes(replacement)) {
    insertedReplacement = true;
  }

  return {
    changed,
    removed,
    html: insertedReplacement
      ? `${nextHtml}<p>${escapeHtml(replacement)}</p>`
      : nextHtml,
  };
}

function repairSentencePayload(payload, pattern, replacement = null) {
  const sourceText = String(payload.text || payload.body || '').trim();
  const sourceHtml = String(payload.html || payload.bodyHtml || '').trim();
  const fallbackText = sourceText || stripHtml(sourceHtml);
  const repairedText = removeMatchingSentences(fallbackText, pattern, replacement);
  const repairedHtml = sourceHtml
    ? replaceHtmlBlocks(sourceHtml, pattern, replacement)
    : { changed: false, removed: [], html: '' };
  const repairedSubject = removeMatchingSentences(payload.subject || '', pattern, null);
  if (!repairedText.changed && !repairedHtml.changed && !repairedSubject.changed) {
    return { payload, removed: [] };
  }
  const nextText = repairedText.text || fallbackText;
  const sourceHtmlHasIssue = sourceHtml ? pattern.test(stripHtml(sourceHtml)) : false;
  const nextHtml = repairedHtml.changed
    ? repairedHtml.html
    : (sourceHtml && !sourceHtmlHasIssue ? sourceHtml : textToHtml(nextText));
  return {
    payload: {
      ...payload,
      subject: repairedSubject.changed
        ? (repairedSubject.text || String(payload.subject || '').replace(pattern, '').trim() || 'Ticket update')
        : payload.subject,
      html: nextHtml,
      text: nextText,
    },
    removed: [...new Set([...repairedText.removed, ...repairedHtml.removed, ...repairedSubject.removed])],
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

function repairFailed(issue, content) {
  if (issue.id === 'unsupported_timing_claims') return UNSUPPORTED_TIMING_PATTERN.test(content);
  if (issue.id === 'unsupported_outage_claims') return /\b(global|company-wide|confirmed)\s+outage\b/i.test(content);
  if (issue.id === 'similar_report_claim_without_evidence') return /\bmultiple similar reports\b/i.test(content);
  if (issue.id === 'emoji') return EMOJI_PATTERN.test(content);
  if (issue.id === 'playful_tone') return PLAYFUL_COPY_PATTERN.test(content);
  return false;
}

function repairSummary(issue, removed = []) {
  if (issue.id === 'unsupported_timing_claims') return 'Removed unsupported response or resolution-time wording; preserved the remaining generated copy.';
  if (issue.id === 'unsupported_outage_claims') return 'Removed unsupported outage wording; preserved the remaining generated copy.';
  if (issue.id === 'similar_report_claim_without_evidence') return 'Removed unsupported multiple-similar-report wording; preserved the remaining generated copy.';
  if (issue.id === 'emoji') return 'Removed emoji because this workflow uses a stricter tone mode.';
  if (issue.id === 'playful_tone') return 'Replaced playful wording because this workflow uses a stricter tone mode.';
  if (removed.length > 0) return `Removed ${removed.length} unsupported item${removed.length === 1 ? '' : 's'}; preserved the remaining generated copy.`;
  return 'Applied targeted copy repair before rendering.';
}

function auditOnlySummary(issue) {
  if (issue.id === 'emoji') return 'Emoji was allowed as an audit-only tone finding; no content changed.';
  if (issue.id === 'playful_tone') return 'Playful wording was allowed as an audit-only tone finding; no content changed.';
  return 'Finding recorded for audit only; no content changed.';
}

function hasHardLeak(content) {
  const issues = [];
  const add = (id, message) => issues.push(guardIssue(id, message));
  if (UNSAFE_HTML_PATTERN.test(content)) {
    add('unsafe_html_or_script', 'Requester-facing email cannot include script or javascript content.');
  }
  if (BASE64_IMAGE_PATTERN.test(content)) {
    add('base64_image_data', 'Requester-facing email cannot include embedded base64 image data.');
  }
  if (INLINE_IMAGE_PATTERN.test(content)) {
    add('inline_image_or_avatar', 'Requester-facing email cannot include inline image, avatar, or photo references from generated content.');
  }
  const emailMatch = content.match(EMAIL_ADDRESS_PATTERN);
  if (emailMatch) {
    add('direct_email_address', 'Requester-facing email cannot include direct email addresses from generated content.');
  }
  if (PHONE_CONTEXT_PATTERN.test(content)) {
    add('direct_phone_number', 'Requester-facing email cannot include direct phone numbers from generated content.');
  }
  return issues;
}

export function guardNotificationEmailPayload(payload, {
  contextBundle = null,
  extraEvidenceIds = [],
  strictCitations = false,
  allowEmoji = false,
  allowPlayfulTone = false,
  disabledGuardrails = [],
  repairGuardrails = [],
  auditOnlyGuardrails = [],
  toneMode = null,
  toneStyleAction = 'audit',
} = {}) {
  const disabled = new Set(disabledGuardrails || []);
  const repairable = new Set(repairGuardrails || []);
  const auditOnly = new Set(auditOnlyGuardrails || []);
  const normalizedToneMode = String(toneMode || '').trim().toLowerCase() || (allowEmoji || allowPlayfulTone ? 'custom' : 'friendly');
  const shouldAuditTone = toneStyleAction !== 'ignore';
  let nextPayload = { ...(payload || {}) };
  let content = textFields(nextPayload);
  const issueDetails = [];
  const repairedIssues = [];
  const auditOnlyIssues = [];
  const skippedChecks = [...disabled];
  const handleIssue = (issue) => {
    if (disabled.has(issue.id)) return;
    if (
      issue.policyTier === NOTIFICATION_GUARD_POLICY_TIERS.AUDIT_ONLY
      && (auditOnly.has(issue.id) || shouldAuditTone)
      && !repairable.has(issue.id)
    ) {
      const auditIssue = {
        ...issue,
        action: 'warn',
        actionTaken: 'warned',
        beforeAfterSummary: issue.beforeAfterSummary || auditOnlySummary(issue),
        toneMode: normalizedToneMode,
      };
      issueDetails.push(auditIssue);
      auditOnlyIssues.push(auditIssue);
      return;
    }
    if (repairable.has(issue.id)) {
      const repaired = repairGuardrailPayload(nextPayload, issue, contextBundle || {});
      nextPayload = repaired.payload;
      content = textFields(nextPayload);
      if (repairFailed(issue, content)) {
        const failedIssue = {
          ...issue,
          action: 'block',
          actionTaken: 'blocked',
          repairFailed: true,
          beforeAfterSummary: 'Targeted repair was attempted but unsafe wording remained.',
        };
        issueDetails.push(failedIssue);
        throw guardError(failedIssue.message, [failedIssue.message], [failedIssue]);
      }
      const repairedIssue = {
        ...issue,
        action: 'repaired',
        actionTaken: 'repaired',
        removed: repaired.removed || [],
        beforeAfterSummary: issue.beforeAfterSummary || repairSummary(issue, repaired.removed || []),
      };
      issueDetails.push(repairedIssue);
      repairedIssues.push(repairedIssue);
      return;
    }
    const blockedIssue = {
      ...issue,
      action: 'block',
      actionTaken: 'blocked',
      beforeAfterSummary: issue.beforeAfterSummary || 'Blocked generated copy before rendering or delivery.',
    };
    issueDetails.push(blockedIssue);
    throw guardError(blockedIssue.message, [blockedIssue.message], [blockedIssue]);
  };
  const allowedPublicPhrases = (contextBundle?.outageSignals?.allowedPublicPhrases || [])
    .map((phrase) => String(phrase || '').toLowerCase());

  for (const guard of STRICT_FORBIDDEN_PUBLIC_PATTERNS) {
    if (!guard.pattern.test(content)) continue;
    handleIssue(guardIssue(guard.id, guard.message));
  }

  for (const issue of hasHardLeak(content)) {
    handleIssue(issue);
  }

  const providerIssues = providerLeakIssues(content, contextBundle);
  if (providerIssues.length > 0) {
    handleIssue(guardIssue('provider_model_internals', 'Requester-facing email cannot mention model/provider/audit internals.', null, {
      issues: providerIssues,
    }));
  }

  if (EMOJI_PATTERN.test(content)) {
    handleIssue(guardIssue('emoji', 'Requester-facing workflow email includes emoji.'));
  }

  if (PLAYFUL_COPY_PATTERN.test(content)) {
    const sensitiveContext = sensitiveRequesterContext(contextBundle);
    handleIssue(guardIssue(
      'playful_tone',
      sensitiveContext
        ? 'Requester-facing workflow email uses playful wording in a sensitive or high-priority ticket context.'
        : 'Requester-facing workflow email uses playful wording.',
      null,
      { sensitiveContext },
    ));
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
      const publicMentions = contentMentionsAny(content, unknown);
      if (publicMentions.length > 0) {
        const issue = guardIssue('unknown_cited_evidence_ids', `LLM cited unknown evidence id(s) in requester-facing copy: ${publicMentions.join(', ')}`, 'block', { unknown, publicMentions });
        issueDetails.push(issue);
        throw guardError(issue.message, [issue.message], [issue]);
      }
      const repairedIssue = guardIssue('unknown_cited_evidence_ids', `Unknown cited evidence id(s) removed from citation metadata: ${unknown.join(', ')}`, 'repaired', {
        unknown,
        removed: unknown,
        kept: citedSignals.filter((id) => allowedIds.has(id)),
        beforeAfterSummary: 'Removed unknown citation metadata; email body formatting was unchanged.',
      });
      nextPayload = {
        ...nextPayload,
        citedSignals: repairedIssue.kept,
      };
      issueDetails.push(repairedIssue);
      repairedIssues.push(repairedIssue);
    }
  }
  const acceptedCitedSignals = Array.isArray(nextPayload?.citedSignals)
    ? nextPayload.citedSignals.map((item) => String(item || '').trim()).filter(Boolean)
    : citedSignals;

  return {
    accepted: true,
    citedSignals: acceptedCitedSignals,
    allowedPublicPhrases,
    payload: nextPayload,
    issueDetails,
    repairedIssues,
    auditOnlyIssues,
    policyTiers: {
      hardBlock: [...HARD_BLOCK_GUARD_CHECKS],
      autoRepair: [...AUTO_REPAIR_GUARD_CHECKS],
      auditOnly: [...AUDIT_ONLY_GUARD_CHECKS],
    },
    toneMode: normalizedToneMode,
    skippedChecks,
    issues: [],
  };
}

export { collectEvidenceIds, collectEvidenceIdsFromContext };
