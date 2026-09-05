import prisma from './prisma.js';
import logger from '../utils/logger.js';

const DEFAULT_NOISE_RULE_WORKSPACE_SLUG = 'it';

export const NOISE_RULE_MODES = ['noise', 'never_noise'];

// never_noise rules match against the first 2KB of the ticket description
// (subjects and category names are short; descriptions can be huge emails).
const NEVER_NOISE_DESCRIPTION_LIMIT = 2048;

// ---------------------------------------------------------------------------
// Human-sender guard (QA 09-04, phase A).
//
// A noise rule tests the SUBJECT only, and a subject cannot tell "Exchange sent
// this warning" apart from "a colleague forwarded that warning asking for help".
// Every ticket the Mailbox Full rule ever caught was the second kind. So before a
// rule may auto-close a ticket, the sender has to look like a machine.
//
// Two cheap signals decide it, and both were measured against a year of prod data
// before being chosen (100 of 3,705 rule-matched tickets are "a real person, and
// they forwarded it" — about one a week):
//   • the envelope: Outlook/Gmail forward and reply prefixes, incl. fr/de/es/nl.
//   • the address: no-reply/alert/automation mailboxes, and the known senders
//     behind the big detectors (Site24x7, Exchange, FortiCloud, M365 messaging).
// A requester who also files ordinary tickets is a person too, whatever they send
// from — that check needs the database, so it runs only on a rule match.
const HUMAN_SUBJECT_PREFIX = /^\s*(?:fw|fwd|re|tr|aw|sv|antw|rv|vs|enc)\s*:/i;
const MACHINE_ADDRESS = /(?:^|[._-])(?:noreply|no-reply|donotreply|do-not-reply|postmaster|mailer-daemon|notifications?|alerts?|monitoring|automat\w*|backup|scanner|helpdesk-bot)(?:[._-]|@)|@(?:site24x7|forticloud|messaging\.microsoft|engage\.mail\.microsoft|sync\.logitech)|microsoftexchange[0-9a-f]{6,}/i;

export const NOISE_SUPPRESS_REASONS = Object.freeze({
  FORWARDED: 'forwarded_by_person',
  PERSON: 'person_requester',
  SENDER_MISMATCH: 'sender_mismatch',
});

/** Envelope + address read of who sent this. No database access. */
export function classifySender({ subject = null, requesterEmail = null } = {}) {
  const email = String(requesterEmail || '').trim().toLowerCase();
  return {
    humanPrefix: HUMAN_SUBJECT_PREFIX.test(String(subject || '')),
    machineAddress: Boolean(email) && MACHINE_ADDRESS.test(email),
    hasAddress: Boolean(email),
  };
}

const DEFAULT_RULES = [
  {
    name: 'Synology NAS Alerts',
    pattern: '^\\[(?:BGC-|bgc-|10\\.2\\.\\d+\\.\\d+)',
    description: 'Replication failures, drive health reports, capacity warnings, drive compatibility, DSM updates, security risks, snapshot issues, power supply failures, volume repairs from Synology NAS devices',
    category: 'infrastructure',
  },
  {
    name: 'Veeam / Hyper-V Backup Errors',
    pattern: '^BGC-(?:FDR|COL|CAL|KAM|EDM|TOR)-HV\\d+ - Error:',
    description: 'Volume transfer failures, replication failures, push install errors, background job failures from Hyper-V hosts. Uses 7-day dedup window: first occurrence is actionable, repeats within 7 days are noise.',
    category: 'infrastructure',
    dedupWindowDays: 7,
  },
  {
    name: 'Defender for Identity Sensor Alerts',
    pattern: '^ibgcengineering Workspace:',
    description: 'Sensor stopped communicating, memory resource limits, unreachable domain controllers, outdated sensors, power settings, auditing configs',
    category: 'security',
  },
  {
    name: 'Server Monitoring Up/Down/Trouble',
    pattern: 'bgcengineering\\.ca is (?:Up|Down|in Trouble)',
    description: 'PRTG or similar monitoring alerts for BST servers, AAD, instrumentation servers going up, down, or into trouble state',
    category: 'monitoring',
  },
  {
    name: 'Root Cause Analysis Reports',
    pattern: '^Root Cause Analysis Report',
    description: 'Automated RCA reports from server monitoring (PRTG)',
    category: 'monitoring',
  },
  {
    name: 'Teams Rooms / AV Incidents',
    pattern: '^Incident 72750S-',
    description: 'USB power draining, offline devices, camera/microphone/speaker issues, console errors, HDMI ingest, bluetooth, time drift, calendar sync, Teams sign-in from meeting rooms',
    category: 'monitoring',
  },
  {
    name: 'Teams Rooms Sync Errors',
    pattern: '^\\[Sync\\]',
    description: 'Room errors and device errors from Teams Rooms sync process',
    category: 'monitoring',
  },
  {
    name: 'FreshService Digest / Trending',
    pattern: '^(?:BGC Engineering Inc\\. Daily Digest|IT, discover trending activity)',
    description: 'FreshService platform digest emails and trending activity notifications',
    category: 'vendor',
  },
  {
    name: 'Vendor Marketing & Spam',
    pattern: '(?:Your 3DF Zephyr|GoDaddy Renewal|Upgrade Your FortiGate|New 1Password sign-in|Try Microsoft 365 Copilot Chat|your chance to get vahid|Thank you for your recent payment|Product Failed Billing|Fortinet Security Services|Apple Developer Enterprise|FortiOS firmware|special offer just for|ActZero Service Satisfaction|your Cisco Webex subscription|Stream, work, and explore|FortiGate Cloud)',
    description: 'Marketing emails, renewal notices, billing notifications, and promotional spam from vendors',
    category: 'vendor',
  },
  {
    name: 'Training Enrollment Notifications',
    pattern: '(?:enrolled in Remedial Training|Enrollment confirmation for|complete your assigned training|finish your past due training)',
    description: 'Automated training enrollment and completion reminders',
    category: 'spam',
  },
  {
    name: 'Threat Intelligence Reports',
    pattern: '^Threat Intelligence$',
    description: 'Automated threat intelligence report notifications',
    category: 'security',
  },
  {
    name: 'Microsoft 365 Quarantine',
    pattern: 'messages in quarantine',
    description: 'Automated notifications about quarantined messages in Microsoft 365',
    category: 'security',
  },
  {
    name: 'Mailbox Full / Archive Warnings',
    pattern: '(?:mailbox is almost full|archive mailbox is almost full)',
    // QA 09-04: every ticket this rule had ever caught was an EMPLOYEE forwarding
    // their own warning to ask for help — the machine's notice arrives from the
    // Exchange system mailbox, so that is what the rule now requires.
    senderPattern: 'microsoftexchange[0-9a-f]{6,}@|^postmaster@',
    description: 'Automated mailbox capacity warnings sent by Exchange/M365 itself. A person forwarding their own warning is a real request and is left in the queue.',
    category: 'monitoring',
  },
  {
    name: 'Certificate Revocation Notices',
    pattern: '^Your Certificate Has Been Revoked$',
    description: 'Automated certificate revocation notifications',
    category: 'infrastructure',
  },
  {
    name: 'Defender for Cloud Apps Alerts',
    pattern: '^Defender for Cloud Apps alert',
    description: 'Microsoft Defender for Cloud Apps automated alerts',
    category: 'security',
  },
  {
    name: 'Azure Backup Alerts',
    pattern: 'Azure Backup (?:data will be|failure alert)',
    description: 'Azure Backup deletion warnings and failure alerts',
    category: 'infrastructure',
  },
  {
    name: 'FreshService Spanish Notifications',
    pattern: '^(?:Reconocimiento - Nueva ticket creada|El ticket N°|Su correo electrónico no se pudo procesar)',
    description: 'FreshService platform auto-notifications in Spanish (ticket created, closed, email processing failures)',
    category: 'spam',
  },
  {
    name: 'Fake Mailbox Phishing',
    pattern: 'Mailbox Pass Expires today',
    description: 'Phishing emails masquerading as mailbox password expiry notices',
    category: 'spam',
  },
  {
    name: 'BGCPT Auto-Confirmation',
    pattern: '^BGCPT Request Submitted$',
    description: 'Automated confirmation emails from BGCPT system',
    category: 'spam',
  },
  {
    name: 'Domain Verification Emails',
    pattern: '^\\[Action Required\\] Verify that you own',
    description: 'Automated domain ownership verification reminders',
    category: 'vendor',
  },
  {
    name: 'Vulnerability / Patch Alerts',
    pattern: '^Urgent: Action Required on Vulnerabilities',
    description: 'Automated vulnerability and missing patch reports',
    category: 'security',
  },
  {
    name: 'ActZero VM Restart',
    pattern: 'please restart ActZero VM',
    description: 'ActZero security VM restart requests',
    category: 'monitoring',
  },
  {
    name: 'Viva Engage / Yammer Updates',
    pattern: '^Updates from All Company',
    description: 'Automated Viva Engage (Yammer) activity digest notifications',
    category: 'spam',
  },
];

/** @type {Map<number, { rules: Array<object>, timestamp: number }>} */
const rulesCacheByWorkspace = new Map();
import('./memoryDiagnostics.js').then(({ registerGauge }) => registerGauge('noiseRules.cache', () => rulesCacheByWorkspace.size)).catch(() => {});
const CACHE_TTL_MS = 60_000;

function safeRegex(pattern, ruleName) {
  try {
    return new RegExp(pattern, 'i');
  } catch (err) {
    logger.warn(`Noise rule "${ruleName}" has an invalid sender pattern, ignoring it: ${err.message}`);
    return null;
  }
}

function notFoundError() {
  const err = new Error('Rule not found');
  err.code = 'P2025';
  return err;
}

class NoiseRuleService {
  async _getDefaultNoiseWorkspace() {
    const workspace = await prisma.workspace.findUnique({
      where: { slug: DEFAULT_NOISE_RULE_WORKSPACE_SLUG },
      select: { id: true, name: true, slug: true },
    });
    if (workspace) return workspace;

    const legacyWorkspace = await prisma.workspace.findUnique({
      where: { id: 1 },
      select: { id: true, name: true, slug: true },
    });
    if (
      legacyWorkspace
      && (
        legacyWorkspace.slug?.toLowerCase() === DEFAULT_NOISE_RULE_WORKSPACE_SLUG
        || legacyWorkspace.name?.toLowerCase() === DEFAULT_NOISE_RULE_WORKSPACE_SLUG
      )
    ) {
      return legacyWorkspace;
    }

    return null;
  }

  async _getRules(workspaceId) {
    const wsId = workspaceId ?? 1;
    const now = Date.now();
    const entry = rulesCacheByWorkspace.get(wsId);
    if (entry && now - entry.timestamp < CACHE_TTL_MS) {
      return entry.rules;
    }

    const rules = await prisma.noiseRule.findMany({
      where: { isEnabled: true, workspaceId: wsId },
      orderBy: { matchCount: 'desc' },
    });

    const mapped = rules.map(r => ({
      ...r,
      regex: new RegExp(r.pattern, 'i'),
      // A bad sender pattern must not take the rule (or the sync) down with it.
      senderRegex: r.senderPattern ? safeRegex(r.senderPattern, r.name) : null,
    }));
    rulesCacheByWorkspace.set(wsId, { rules: mapped, timestamp: now });
    return mapped;
  }

  /**
   * Does this requester behave like a person? One ordinary (non-noise) ticket in
   * the past year is enough — machine mailboxes never file those.
   */
  async _requesterLooksHuman(requesterId) {
    if (!requesterId) return false;
    try {
      const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
      const found = await prisma.ticket.findFirst({
        where: { requesterId: Number(requesterId), isNoise: false, createdAt: { gte: since } },
        select: { id: true },
      });
      return Boolean(found);
    } catch (err) {
      // Fail SAFE: an unavailable lookup must not license an auto-close.
      logger.warn(`Noise guard: requester lookup failed (treating as human): ${err.message}`);
      return true;
    }
  }

  /**
   * May a matched rule auto-close this ticket? (QA 09-04 phase A.)
   * @returns {Promise<{allowed: boolean, reason: string|null}>}
   */
  async canAutoClose(rule, { subject = null, requesterEmail = null, requesterId = null } = {}) {
    if (rule?.autoCloseFromPeople) return { allowed: true, reason: null };
    const sender = classifySender({ subject, requesterEmail });
    if (sender.machineAddress) return { allowed: true, reason: null };
    if (sender.humanPrefix) return { allowed: false, reason: NOISE_SUPPRESS_REASONS.FORWARDED };
    if (await this._requesterLooksHuman(requesterId)) {
      return { allowed: false, reason: NOISE_SUPPRESS_REASONS.PERSON };
    }
    return { allowed: true, reason: null };
  }

  invalidateCache() {
    rulesCacheByWorkspace.clear();
  }

  /**
   * Evaluate whether a ticket subject matches any enabled noise rule.
   * For rules with dedupWindowDays, checks if a same-subject ticket
   * already exists within the dedup window - if not, it's the "first"
   * occurrence and stays actionable.
   *
   * @param {string|null} subject - Ticket subject line
   * @param {Date|null} createdAt - Ticket creation date (needed for dedup check)
   * @returns {Promise<{isNoise: boolean, ruleId: string|null, category: string|null}>}
   */
  async evaluate(subject, createdAt = null, workspaceId = 1, context = {}) {
    if (!subject) return { isNoise: false, ruleId: null, category: null };
    const { requesterEmail = null, requesterId = null } = context || {};
    let nearMiss = null; // subject matched, sender did not

    const wsId = workspaceId ?? 1;
    const rules = await this._getRules(wsId);
    for (const rule of rules) {
      // never_noise rules are a veto (see evaluateNeverNoise), never a
      // "mark as noise" match — skip them here so existing noise-mode
      // behavior is unchanged.
      if (rule.mode === 'never_noise') continue;
      if (!rule.regex.test(subject)) continue;
      // (B) The rule may also require the mail to come FROM a specific sender. A
      // subject that matched on words alone is worth recording even so — that is
      // the exact shape of the mistake this work was built for.
      if (rule.senderRegex && !rule.senderRegex.test(String(requesterEmail || ''))) {
        if (!nearMiss) nearMiss = rule;
        continue;
      }

      if (rule.dedupWindowDays && createdAt) {
        const windowStart = new Date(createdAt);
        windowStart.setDate(windowStart.getDate() - rule.dedupWindowDays);

        const existingCount = await prisma.ticket.count({
          where: {
            workspaceId: wsId,
            subject,
            createdAt: { gte: windowStart, lt: createdAt },
          },
        });

        if (existingCount === 0) {
          // First occurrence in this window - keep as actionable
          return { isNoise: false, ruleId: null, category: null };
        }
        return this._matchResult(rule, { subject, requesterEmail, requesterId });
      }

      return this._matchResult(rule, { subject, requesterEmail, requesterId });
    }
    if (nearMiss) {
      logger.info(`Noise rule "${nearMiss.name}" skipped: the subject matched but the sender did not`);
      return {
        isNoise: false, ruleId: null, category: null,
        suppressedRule: nearMiss.name, suppressReason: NOISE_SUPPRESS_REASONS.SENDER_MISMATCH,
      };
    }
    return { isNoise: false, ruleId: null, category: null };
  }

  /**
   * A matched rule becomes a noise verdict only if the sender looks automated;
   * otherwise the match is recorded as SUPPRESSED and the ticket stays in the
   * queue, where the AI pipeline classifies it with the body and the requester
   * in hand (QA 09-04 phases A + C).
   */
  async _matchResult(rule, ctx) {
    const gate = await this.canAutoClose(rule, ctx);
    if (gate.allowed) {
      return { isNoise: true, ruleId: rule.name, category: rule.category, suppressedRule: null, suppressReason: null };
    }
    logger.info(`Noise rule "${rule.name}" suppressed (${gate.reason}) — ticket stays actionable for AI review`);
    return { isNoise: false, ruleId: null, category: null, suppressedRule: rule.name, suppressReason: gate.reason };
  }

  /**
   * Deterministic "never noise" veto (NT-1/NT-2). Checks enabled
   * mode='never_noise' rules against the ticket subject, the first 2KB of
   * the description, and the category name. When a rule matches, the AI
   * pipeline must NOT auto-dismiss the ticket as noise — regardless of what
   * the prompt or model said.
   *
   * Unlike noise-mode rules (subject-only, unchanged), veto rules look at
   * more of the ticket on purpose: a package-delivery request often only
   * mentions "courier"/"FedEx" in the body.
   *
   * @param {number} workspaceId
   * @param {{subject?: string|null, description?: string|null, category?: string|null}} ticket
   * @returns {Promise<{vetoed: boolean, ruleId: number|null, ruleName: string|null}>}
   */
  async evaluateNeverNoise(workspaceId, { subject = null, description = null, category = null } = {}) {
    const wsId = workspaceId ?? 1;
    const rules = (await this._getRules(wsId)).filter((r) => r.mode === 'never_noise');
    if (rules.length === 0) return { vetoed: false, ruleId: null, ruleName: null };

    const haystacks = [
      subject,
      typeof description === 'string' ? description.slice(0, NEVER_NOISE_DESCRIPTION_LIMIT) : null,
      category,
    ].filter((text) => typeof text === 'string' && text.length > 0);
    if (haystacks.length === 0) return { vetoed: false, ruleId: null, ruleName: null };

    for (const rule of rules) {
      if (haystacks.some((text) => rule.regex.test(text))) {
        return { vetoed: true, ruleId: rule.id, ruleName: rule.name };
      }
    }
    return { vetoed: false, ruleId: null, ruleName: null };
  }

  async getAllRules(workspaceId) {
    const wsId = workspaceId ?? 1;
    return prisma.noiseRule.findMany({
      where: { workspaceId: wsId },
      orderBy: { matchCount: 'desc' },
    });
  }

  /**
   * Recent noise activity for the audit panel (QA 09-04 phase F).
   *
   * A wrong auto-close used to leave no trace anyone would look at — 4,275 noise
   * tickets in IT against 17 manual corrections ever. This returns both halves of
   * the story: what the rules closed, and what the sender guard REFUSED to close.
   */
  async getRecentActivity(workspaceId, { days = 30, limit = 40 } = {}) {
    const wsId = workspaceId ?? 1;
    const since = new Date(Date.now() - Math.max(1, Math.min(Number(days) || 30, 180)) * 24 * 60 * 60 * 1000);
    const take = Math.max(1, Math.min(Number(limit) || 40, 200));
    const select = {
      id: true, subject: true, createdAt: true, status: true, isNoise: true,
      nativeNumber: true, freshserviceTicketId: true,
      noiseRuleMatched: true, noiseRuleSuppressed: true, noiseSuppressReason: true,
      requester: { select: { name: true, email: true } },
    };

    const [held, dismissed] = await Promise.all([
      prisma.ticket.findMany({
        where: { workspaceId: wsId, noiseRuleSuppressed: { not: null }, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' }, take, select,
      }),
      prisma.ticket.findMany({
        where: { workspaceId: wsId, isNoise: true, noiseRuleMatched: { not: null }, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' }, take, select,
      }),
    ]);

    const shape = (t) => ({
      id: t.id,
      ref: t.nativeNumber ? `TP-${t.nativeNumber}` : (t.freshserviceTicketId ? `#${t.freshserviceTicketId}` : `#${t.id}`),
      subject: t.subject,
      createdAt: t.createdAt,
      status: t.status,
      rule: t.noiseRuleSuppressed || t.noiseRuleMatched,
      reason: t.noiseSuppressReason || null,
      requesterName: t.requester?.name || null,
      requesterEmail: t.requester?.email || null,
    });

    return {
      days: Number(days) || 30,
      heldForReview: held.map(shape),
      autoClosed: dismissed.map(shape),
      counts: { heldForReview: held.length, autoClosed: dismissed.length },
    };
  }

  async createRule(data) {
    // Validate regex
    try {
      new RegExp(data.pattern, 'i');
    } catch (e) {
      throw new Error(`Invalid regex pattern: ${e.message}`);
    }
    if (data.senderPattern) {
      try {
        new RegExp(data.senderPattern, 'i');
      } catch (e) {
        throw new Error(`Invalid sender pattern: ${e.message}`);
      }
    }

    if (data.mode !== undefined && !NOISE_RULE_MODES.includes(data.mode)) {
      throw new Error(`Invalid mode: must be one of ${NOISE_RULE_MODES.join(', ')}`);
    }

    const rule = await prisma.noiseRule.create({
      data: {
        name: data.name,
        pattern: data.pattern,
        description: data.description || null,
        category: data.category || 'custom',
        isEnabled: data.isEnabled !== false,
        mode: data.mode || 'noise',
        dedupWindowDays: data.dedupWindowDays || null,
        senderPattern: data.senderPattern || null,
        autoCloseFromPeople: data.autoCloseFromPeople === true,
        workspaceId: data.workspaceId,
      },
    });
    this.invalidateCache();
    return rule;
  }

  async updateRule(id, data, workspaceId) {
    const wsId = workspaceId ?? 1;
    const existing = await prisma.noiseRule.findFirst({ where: { id, workspaceId: wsId } });
    if (!existing) {
      throw notFoundError();
    }

    if (data.pattern) {
      try {
        new RegExp(data.pattern, 'i');
      } catch (e) {
        throw new Error(`Invalid regex pattern: ${e.message}`);
      }
    }
    if (data.senderPattern) {
      try {
        new RegExp(data.senderPattern, 'i');
      } catch (e) {
        throw new Error(`Invalid sender pattern: ${e.message}`);
      }
    }

    if (data.mode !== undefined && !NOISE_RULE_MODES.includes(data.mode)) {
      throw new Error(`Invalid mode: must be one of ${NOISE_RULE_MODES.join(', ')}`);
    }

    const updateData = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.pattern !== undefined) updateData.pattern = data.pattern;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.category !== undefined) updateData.category = data.category;
    if (data.isEnabled !== undefined) updateData.isEnabled = data.isEnabled;
    if (data.mode !== undefined) updateData.mode = data.mode;
    if (data.dedupWindowDays !== undefined) updateData.dedupWindowDays = data.dedupWindowDays;
    if (data.senderPattern !== undefined) updateData.senderPattern = data.senderPattern || null;
    if (data.autoCloseFromPeople !== undefined) updateData.autoCloseFromPeople = data.autoCloseFromPeople === true;

    const rule = await prisma.noiseRule.update({
      where: { id },
      data: updateData,
    });
    this.invalidateCache();
    return rule;
  }

  async deleteRule(id, workspaceId) {
    const wsId = workspaceId ?? 1;
    const existing = await prisma.noiseRule.findFirst({ where: { id, workspaceId: wsId } });
    if (!existing) {
      throw notFoundError();
    }
    await prisma.noiseRule.delete({ where: { id } });
    this.invalidateCache();
  }

  async seedDefaults(workspaceId = null) {
    const defaultWorkspace = await this._getDefaultNoiseWorkspace();
    if (!defaultWorkspace) {
      logger.warn('Default IT noise rules were not seeded because the IT workspace could not be found');
      return 0;
    }

    if (workspaceId !== null && Number(workspaceId) !== defaultWorkspace.id) {
      logger.info(
        `Skipping default IT noise rules for workspace ${workspaceId}; non-IT workspaces start with empty noise rules`,
      );
      return 0;
    }

    const wsId = defaultWorkspace.id;
    const existing = await prisma.noiseRule.count({ where: { workspaceId: wsId } });
    if (existing > 0) {
      logger.info(`Noise rules already seeded for workspace ${wsId} (${existing} rules exist)`);
      return 0;
    }

    logger.info(`Seeding ${DEFAULT_RULES.length} default IT noise rules for workspace ${wsId}...`);
    await prisma.noiseRule.createMany({
      data: DEFAULT_RULES.map(r => ({
        name: r.name,
        pattern: r.pattern,
        description: r.description ?? null,
        category: r.category,
        isEnabled: true,
        dedupWindowDays: r.dedupWindowDays ?? null,
        workspaceId: wsId,
      })),
    });
    this.invalidateCache();
    return DEFAULT_RULES.length;
  }

  /**
   * Re-evaluate all tickets against current rules and update isNoise flag.
   * Processes chronologically (oldest first) so dedup window rules work correctly.
   * Returns { updated, noiseCount, totalProcessed }
   */
  async backfillAll(progressCallback = null, workspaceId = null) {
    const wsId = workspaceId ?? 1;
    // never_noise rules are a pipeline veto, not a "mark as noise" matcher —
    // they must never flag tickets during a backfill.
    const rules = (await this._getRules(wsId)).filter((r) => r.mode !== 'never_noise');
    const hasDedupRules = rules.some(r => r.dedupWindowDays);
    const batchSize = 500;
    let offset = 0;
    let totalProcessed = 0;
    let noiseCount = 0;
    let updated = 0;

    const totalTickets = await prisma.ticket.count({ where: { workspaceId: wsId } });

    // First pass: clear all noise flags so dedup windows evaluate cleanly
    if (hasDedupRules) {
      await prisma.ticket.updateMany({
        where: { workspaceId: wsId },
        data: { isNoise: false, noiseRuleMatched: null },
      });
    }

    let hasMore = true;
    while (hasMore) {
      // Order by createdAt ASC so dedup window checks see earlier tickets first
      const tickets = await prisma.ticket.findMany({
        where: { workspaceId: wsId },
        select: { id: true, subject: true, createdAt: true, isNoise: true, noiseRuleMatched: true },
        skip: offset,
        take: batchSize,
        orderBy: { createdAt: 'asc' },
      });

      if (tickets.length === 0) { hasMore = false; break; }

      // Process one at a time for dedup rules (need DB state to be committed)
      for (const ticket of tickets) {
        let isNoise = false;
        let ruleId = null;

        if (ticket.subject) {
          for (const rule of rules) {
            if (!rule.regex.test(ticket.subject)) continue;

            if (rule.dedupWindowDays) {
              const windowStart = new Date(ticket.createdAt);
              windowStart.setDate(windowStart.getDate() - rule.dedupWindowDays);

              const existingCount = await prisma.ticket.count({
                where: {
                  workspaceId: wsId,
                  subject: ticket.subject,
                  isNoise: false,
                  createdAt: { gte: windowStart, lt: ticket.createdAt },
                },
              });

              if (existingCount === 0) {
                // First occurrence in window - keep actionable
                break;
              }
            }

            isNoise = true;
            ruleId = rule.name;
            break;
          }
        }

        if (isNoise) noiseCount++;
        if (ticket.isNoise !== isNoise || ticket.noiseRuleMatched !== ruleId) {
          await prisma.ticket.update({
            where: { id: ticket.id },
            data: { isNoise, noiseRuleMatched: ruleId },
          });
          updated++;
        }
      }

      totalProcessed += tickets.length;
      offset += batchSize;

      if (progressCallback) {
        progressCallback({ totalProcessed, totalTickets, noiseCount, updated });
      }
    }

    // Update match counts per rule
    for (const rule of rules) {
      const count = await prisma.ticket.count({
        where: { workspaceId: wsId, noiseRuleMatched: rule.name },
      });
      await prisma.noiseRule.update({
        where: { id: rule.id },
        data: { matchCount: count },
      });
    }
    this.invalidateCache();

    return { updated, noiseCount, totalProcessed };
  }

  /**
   * Get statistics about noise tickets
   */
  async getStats(workspaceId) {
    const wsId = workspaceId ?? 1;
    const [total, noiseCount, rules] = await Promise.all([
      prisma.ticket.count({ where: { workspaceId: wsId } }),
      prisma.ticket.count({ where: { workspaceId: wsId, isNoise: true } }),
      prisma.noiseRule.findMany({
        where: { isEnabled: true, workspaceId: wsId },
        select: { id: true, name: true, category: true, matchCount: true },
        orderBy: { matchCount: 'desc' },
      }),
    ]);

    const byCategory = {};
    for (const rule of rules) {
      byCategory[rule.category] = (byCategory[rule.category] || 0) + rule.matchCount;
    }

    return {
      totalTickets: total,
      noiseTickets: noiseCount,
      actionableTickets: total - noiseCount,
      noisePercentage: total > 0 ? ((noiseCount / total) * 100).toFixed(1) : '0',
      byCategory,
      rules,
    };
  }

  /**
   * Test a pattern against existing tickets to see how many would match
   */
  async testPattern(pattern, workspaceId) {
    const wsId = workspaceId ?? 1;
    try {
      const regex = new RegExp(pattern, 'i');
      const tickets = await prisma.ticket.findMany({
        select: {
          freshserviceTicketId: true,
          subject: true,
          status: true,
          createdAt: true,
          requester: {
            select: {
              name: true,
              email: true,
            },
          },
        },
        where: { workspaceId: wsId, subject: { not: null } },
        orderBy: { createdAt: 'desc' },
      });

      const matches = tickets.filter(t => regex.test(t.subject));
      const sampleSubjects = [...new Set(matches.map(t => t.subject))].slice(0, 15);
      const sampleMatches = matches.slice(0, 15).map(t => ({
        ticketId: t.freshserviceTicketId?.toString() || null,
        subject: t.subject,
        status: t.status,
        createdAt: t.createdAt,
        requesterName: t.requester?.name || null,
        requesterEmail: t.requester?.email || null,
      }));

      return {
        matchCount: matches.length,
        totalTickets: tickets.length,
        percentage: tickets.length > 0 ? ((matches.length / tickets.length) * 100).toFixed(1) : '0',
        sampleSubjects,
        sampleMatches,
      };
    } catch (e) {
      throw new Error(`Invalid regex pattern: ${e.message}`);
    }
  }
}

export default new NoiseRuleService();
