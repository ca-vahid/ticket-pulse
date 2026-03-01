import prisma from './prisma.js';
import logger from '../utils/logger.js';

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
    description: 'Automated mailbox capacity warnings from Exchange/M365',
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

let cachedRules = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000;

class NoiseRuleService {
  async _getRules() {
    const now = Date.now();
    if (cachedRules && now - cacheTimestamp < CACHE_TTL_MS) {
      return cachedRules;
    }

    const rules = await prisma.noiseRule.findMany({
      where: { isEnabled: true },
      orderBy: { matchCount: 'desc' },
    });

    cachedRules = rules.map(r => ({
      ...r,
      regex: new RegExp(r.pattern, 'i'),
    }));
    cacheTimestamp = now;
    return cachedRules;
  }

  invalidateCache() {
    cachedRules = null;
    cacheTimestamp = 0;
  }

  /**
   * Evaluate whether a ticket subject matches any enabled noise rule.
   * For rules with dedupWindowDays, checks if a same-subject ticket
   * already exists within the dedup window - if not, it's the "first"
   * occurrence and stays actionable.
   *
   * @param {string|null} subject - Ticket subject line
   * @param {Date|null} createdAt - Ticket creation date (needed for dedup check)
   * @returns {Promise<{isNoise: boolean, ruleId: string|null}>}
   */
  async evaluate(subject, createdAt = null) {
    if (!subject) return { isNoise: false, ruleId: null };

    const rules = await this._getRules();
    for (const rule of rules) {
      if (!rule.regex.test(subject)) continue;

      if (rule.dedupWindowDays && createdAt) {
        const windowStart = new Date(createdAt);
        windowStart.setDate(windowStart.getDate() - rule.dedupWindowDays);

        const existingCount = await prisma.ticket.count({
          where: {
            subject,
            createdAt: { gte: windowStart, lt: createdAt },
          },
        });

        if (existingCount === 0) {
          // First occurrence in this window - keep as actionable
          return { isNoise: false, ruleId: null };
        }
        return { isNoise: true, ruleId: rule.name };
      }

      return { isNoise: true, ruleId: rule.name };
    }
    return { isNoise: false, ruleId: null };
  }

  async getAllRules() {
    return prisma.noiseRule.findMany({ orderBy: { matchCount: 'desc' } });
  }

  async createRule(data) {
    // Validate regex
    try {
      new RegExp(data.pattern, 'i');
    } catch (e) {
      throw new Error(`Invalid regex pattern: ${e.message}`);
    }

    const rule = await prisma.noiseRule.create({
      data: {
        name: data.name,
        pattern: data.pattern,
        description: data.description || null,
        category: data.category || 'custom',
        isEnabled: data.isEnabled !== false,
        dedupWindowDays: data.dedupWindowDays || null,
      },
    });
    this.invalidateCache();
    return rule;
  }

  async updateRule(id, data) {
    if (data.pattern) {
      try {
        new RegExp(data.pattern, 'i');
      } catch (e) {
        throw new Error(`Invalid regex pattern: ${e.message}`);
      }
    }

    const updateData = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.pattern !== undefined) updateData.pattern = data.pattern;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.category !== undefined) updateData.category = data.category;
    if (data.isEnabled !== undefined) updateData.isEnabled = data.isEnabled;
    if (data.dedupWindowDays !== undefined) updateData.dedupWindowDays = data.dedupWindowDays;

    const rule = await prisma.noiseRule.update({
      where: { id },
      data: updateData,
    });
    this.invalidateCache();
    return rule;
  }

  async deleteRule(id) {
    await prisma.noiseRule.delete({ where: { id } });
    this.invalidateCache();
  }

  async seedDefaults() {
    const existing = await prisma.noiseRule.count();
    if (existing > 0) {
      logger.info(`Noise rules already seeded (${existing} rules exist)`);
      return existing;
    }

    logger.info(`Seeding ${DEFAULT_RULES.length} default noise rules...`);
    await prisma.noiseRule.createMany({ data: DEFAULT_RULES });
    this.invalidateCache();
    return DEFAULT_RULES.length;
  }

  /**
   * Re-evaluate all tickets against current rules and update isNoise flag.
   * Processes chronologically (oldest first) so dedup window rules work correctly.
   * Returns { updated, noiseCount, totalProcessed }
   */
  async backfillAll(progressCallback = null) {
    const rules = await this._getRules();
    const hasDedupRules = rules.some(r => r.dedupWindowDays);
    const batchSize = 500;
    let offset = 0;
    let totalProcessed = 0;
    let noiseCount = 0;
    let updated = 0;

    const totalTickets = await prisma.ticket.count();

    // First pass: clear all noise flags so dedup windows evaluate cleanly
    if (hasDedupRules) {
      await prisma.ticket.updateMany({
        data: { isNoise: false, noiseRuleMatched: null },
      });
    }

    while (true) {
      // Order by createdAt ASC so dedup window checks see earlier tickets first
      const tickets = await prisma.ticket.findMany({
        select: { id: true, subject: true, createdAt: true, isNoise: true, noiseRuleMatched: true },
        skip: offset,
        take: batchSize,
        orderBy: { createdAt: 'asc' },
      });

      if (tickets.length === 0) break;

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
        where: { noiseRuleMatched: rule.name },
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
  async getStats() {
    const [total, noiseCount, rules] = await Promise.all([
      prisma.ticket.count(),
      prisma.ticket.count({ where: { isNoise: true } }),
      prisma.noiseRule.findMany({
        where: { isEnabled: true },
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
  async testPattern(pattern) {
    try {
      const regex = new RegExp(pattern, 'i');
      const tickets = await prisma.ticket.findMany({
        select: { subject: true },
        where: { subject: { not: null } },
      });

      const matches = tickets.filter(t => regex.test(t.subject));
      const sampleSubjects = [...new Set(matches.map(t => t.subject))].slice(0, 15);

      return {
        matchCount: matches.length,
        totalTickets: tickets.length,
        percentage: ((matches.length / tickets.length) * 100).toFixed(1),
        sampleSubjects,
      };
    } catch (e) {
      throw new Error(`Invalid regex pattern: ${e.message}`);
    }
  }
}

export default new NoiseRuleService();
