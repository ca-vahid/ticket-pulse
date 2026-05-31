const FORBIDDEN_PUBLIC_PATTERNS = [
  {
    pattern: /\b(global|company-wide|confirmed)\s+outage\b/i,
    message: 'Requester-facing email cannot claim a global/company-wide/confirmed outage without confirmed evidence.',
  },
  {
    pattern: /\b(get_notification_context|get_ticket_thread_summary|find_similar_tickets|detect_related_ticket_spike|search_recent_tickets|submit_notification_email)\b/i,
    message: 'Requester-facing email cannot mention internal tool names.',
  },
  {
    pattern: /\b(openai|anthropic|claude|gpt-|model|provider|audit id|tp-nwf-)\b/i,
    message: 'Requester-facing email cannot mention model/provider/audit internals.',
  },
  {
    pattern: /\bprivate note\b|\binternal note\b/i,
    message: 'Requester-facing email cannot quote or mention private/internal notes.',
  },
];

function textFields(payload = {}) {
  return [payload.subject, payload.html, payload.text]
    .map((value) => String(value || ''))
    .join('\n');
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
} = {}) {
  const content = textFields(payload);
  const allowedPublicPhrases = (contextBundle?.outageSignals?.allowedPublicPhrases || [])
    .map((phrase) => String(phrase || '').toLowerCase());

  for (const guard of FORBIDDEN_PUBLIC_PATTERNS) {
    if (!guard.pattern.test(content)) continue;
    throw new Error(guard.message);
  }

  if (/\bmultiple similar reports\b/i.test(content)
    && !allowedPublicPhrases.includes('we are seeing multiple similar reports')) {
    throw new Error('"Multiple similar reports" wording requires deterministic related-ticket evidence.');
  }

  const citedSignals = Array.isArray(payload?.citedSignals)
    ? payload.citedSignals.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (strictCitations && citedSignals.length > 0) {
    const allowedIds = collectEvidenceIdsFromContext(contextBundle || {});
    for (const id of extraEvidenceIds || []) allowedIds.add(String(id));
    const unknown = citedSignals.filter((id) => !allowedIds.has(id));
    if (unknown.length > 0) {
      throw new Error(`LLM cited unknown evidence id(s): ${unknown.join(', ')}`);
    }
  }

  return {
    accepted: true,
    citedSignals,
    allowedPublicPhrases,
  };
}

export { collectEvidenceIds, collectEvidenceIdsFromContext };
