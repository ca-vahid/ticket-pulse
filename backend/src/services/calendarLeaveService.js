import crypto from 'crypto';
import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import prisma from './prisma.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import anthropicService from './anthropicService.js';
import vtRepo from './vacationTrackerRepository.js';

const VALID_CATEGORIES = new Set(['OFF', 'WFH', 'OTHER', 'IGNORED']);
const VALID_HALF_DAY = new Set(['AM', 'PM', 'INFER', null, undefined, '']);
const CLASSIFICATION_VERSION = 'calendar-v2';

const DEFAULT_RULES = [
  { name: 'Ignore statutory holidays', priority: 10, pattern: '\\b(stat|holiday|family day|canada day|thanksgiving|christmas|boxing day|new year)\\b', category: 'IGNORED', notes: 'Calendar-wide holidays are not individual technician leave.' },
  { name: 'WFH / remote', priority: 20, pattern: '\\b(wfh|work from home|working from home|remote)\\b', category: 'WFH' },
  { name: 'Explicit AM off', priority: 30, pattern: '\\b(off\\s*am|off morning|starting late|dentist in the am)\\b', category: 'OFF', halfDayPart: 'AM' },
  { name: 'Explicit PM off', priority: 31, pattern: '\\b(off\\s*pm|afternoon off|early[- ]off|leaving early|working in am)\\b', category: 'OFF', halfDayPart: 'PM' },
  { name: 'Appointment / medical / class', priority: 40, pattern: '\\b(appointment|appt|dentist|doctor|medical|blood donation|class)\\b', category: 'OFF', halfDayPart: 'INFER' },
  { name: 'Vacation / off / away', priority: 50, pattern: '\\b(vacation|\\boff\\b|ooo|away|time[- ]off|taking a week off|mostly off)\\b', category: 'OFF' },
];

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function parseGraphDate(value) {
  if (!value) return null;
  return new Date(value.endsWith('Z') ? value : `${value}Z`);
}

function minuteFromGraphLocal(value) {
  if (!value) return null;
  const match = String(value).match(/T(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatDateUTC(date) {
  return date.toISOString().slice(0, 10);
}

function expandDateRange(startDateTime, endDateTime, isAllDay) {
  const start = parseGraphDate(startDateTime);
  const end = parseGraphDate(endDateTime);
  if (!start || !end) return [];

  if (!isAllDay) return [new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()))];

  const dates = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const exclusiveEnd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cursor < exclusiveEnd) {
    dates.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function firstSubjectChunk(subject) {
  const cleaned = String(subject || '')
    .replace(/^fw:\s*/i, '')
    .replace(/^re:\s*/i, '')
    .trim();
  const beforeSeparator = cleaned.split(/\s*[-–—]\s*/)[0];
  const stop = beforeSeparator.search(/\s+off\b|\s+vacation\b|\s+appt\b|\s+appointment\b|\s+doctor\b|\s+dentist\b|\s+early\b|\s+working\b|\s+on\b|\s+\(/i);
  const head = (stop >= 0 ? beforeSeparator.slice(0, stop) : beforeSeparator).trim();
  return head.split(/\s+/).slice(0, 2).join(' ');
}

function eventFingerprint(event) {
  const raw = [
    event.id,
    event.lastModifiedDateTime,
    event.subject,
    event.start?.dateTime,
    event.end?.dateTime,
    event.isAllDay,
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function compileRule(rule) {
  try {
    return new RegExp(rule.pattern, 'i');
  } catch {
    return null;
  }
}

function inferHalfDay(subject, event) {
  const s = normalize(subject);
  if (/\b(off am|off morning|starting late|dentist in the am)\b/.test(s) && !/\bworking in am\b/.test(s)) return 'AM';
  if (/\b(off pm|afternoon off|early off|leaving early|working in am)\b/.test(s)) return 'PM';
  if (!event.isAllDay) {
    const startMinute = minuteFromGraphLocal(event.start?.dateTime);
    if (startMinute === null) return null;
    return startMinute < 12 * 60 ? 'AM' : 'PM';
  }
  return null;
}

function deriveMinutes(event, halfDayPart) {
  if (!event.isAllDay) {
    return {
      isFullDay: false,
      halfDayPart: halfDayPart || inferHalfDay(event.subject, event),
      startMinute: minuteFromGraphLocal(event.start?.dateTime),
      endMinute: minuteFromGraphLocal(event.end?.dateTime),
    };
  }

  if (halfDayPart === 'AM') {
    return { isFullDay: false, halfDayPart: 'AM', startMinute: 0, endMinute: 12 * 60 };
  }
  if (halfDayPart === 'PM') {
    return { isFullDay: false, halfDayPart: 'PM', startMinute: 12 * 60, endMinute: 24 * 60 };
  }
  return { isFullDay: true, halfDayPart: null, startMinute: null, endMinute: null };
}

class CalendarLeaveService {
  constructor() {
    this._graphClient = null;
  }

  _getGraphClient() {
    if (this._graphClient) return this._graphClient;
    const { tenantId, clientId, clientSecret } = config.graph;
    if (!tenantId || !clientId || !clientSecret) {
      throw new Error('Azure Graph API credentials not configured');
    }
    const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ['https://graph.microsoft.com/.default'],
    });
    this._graphClient = Client.initWithMiddleware({ authProvider });
    return this._graphClient;
  }

  async getConfig(workspaceId) {
    return prisma.calendarLeaveSourceConfig.findUnique({ where: { workspaceId } });
  }

  async upsertConfig(workspaceId, data) {
    return prisma.calendarLeaveSourceConfig.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        mailbox: data.mailbox,
        graphGroupId: data.graphGroupId,
        timezone: data.timezone || 'America/Vancouver',
        syncEnabled: data.syncEnabled ?? false,
        lookbackDays: data.lookbackDays ?? 7,
        horizonDays: data.horizonDays ?? 90,
      },
      update: {
        ...(data.mailbox !== undefined ? { mailbox: data.mailbox } : {}),
        ...(data.graphGroupId !== undefined ? { graphGroupId: data.graphGroupId } : {}),
        ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
        ...(data.syncEnabled !== undefined ? { syncEnabled: data.syncEnabled } : {}),
        ...(data.lookbackDays !== undefined ? { lookbackDays: data.lookbackDays } : {}),
        ...(data.horizonDays !== undefined ? { horizonDays: data.horizonDays } : {}),
      },
    });
  }

  async seedDefaults(workspaceId) {
    const existing = await prisma.calendarLeaveRule.count({ where: { workspaceId } });
    if (existing === 0) {
      await prisma.calendarLeaveRule.createMany({
        data: DEFAULT_RULES.map((rule) => ({ workspaceId, ...rule })),
      });
    }

    const technicians = await prisma.technician.findMany({
      where: { workspaceId, email: { not: 'ticketpulse@bgcengineering.ca' } },
      select: { id: true, name: true, email: true },
    });

    for (const tech of technicians) {
      const firstName = tech.name.split(/\s+/)[0];
      const aliases = [tech.name, firstName];
      for (const alias of aliases) {
        const normalizedAlias = normalize(alias);
        if (!normalizedAlias) continue;
        await prisma.calendarLeaveAlias.upsert({
          where: { workspaceId_normalizedAlias: { workspaceId, normalizedAlias } },
          create: { workspaceId, alias, normalizedAlias, technicianId: tech.id },
          update: {},
        });
      }
    }
    await prisma.calendarLeaveClassification.deleteMany({ where: { workspaceId } });
  }

  async getRules(workspaceId) {
    return prisma.calendarLeaveRule.findMany({ where: { workspaceId }, orderBy: [{ priority: 'asc' }, { id: 'asc' }] });
  }

  async upsertRule(workspaceId, data) {
    if (!VALID_CATEGORIES.has(data.category)) throw new Error('Invalid category');
    if (!VALID_HALF_DAY.has(data.halfDayPart)) throw new Error('Invalid halfDayPart');
    new RegExp(data.pattern, 'i');
    if (data.id) {
      return prisma.calendarLeaveRule.update({
        where: { id: data.id },
        data: {
          name: data.name,
          priority: data.priority,
          pattern: data.pattern,
          category: data.category,
          halfDayPart: data.halfDayPart || null,
          isActive: data.isActive !== false,
          notes: data.notes || null,
        },
      });
    }
    return prisma.calendarLeaveRule.create({
      data: {
        workspaceId,
        name: data.name,
        priority: data.priority ?? 100,
        pattern: data.pattern,
        category: data.category,
        halfDayPart: data.halfDayPart || null,
        isActive: data.isActive !== false,
        notes: data.notes || null,
      },
    });
  }

  async deleteRule(workspaceId, id) {
    return prisma.calendarLeaveRule.deleteMany({ where: { id, workspaceId } });
  }

  async getAliases(workspaceId) {
    return prisma.calendarLeaveAlias.findMany({
      where: { workspaceId },
      include: { technician: { select: { id: true, name: true, email: true } } },
      orderBy: { alias: 'asc' },
    });
  }

  async upsertAlias(workspaceId, data) {
    const normalizedAlias = normalize(data.alias);
    if (!normalizedAlias) throw new Error('Alias is required');
    const alias = await prisma.calendarLeaveAlias.upsert({
      where: { workspaceId_normalizedAlias: { workspaceId, normalizedAlias } },
      create: {
        workspaceId,
        alias: data.alias,
        normalizedAlias,
        technicianId: data.isIgnored ? null : data.technicianId || null,
        isIgnored: data.isIgnored === true,
      },
      update: {
        alias: data.alias,
        technicianId: data.isIgnored ? null : data.technicianId || null,
        isIgnored: data.isIgnored === true,
      },
    });
    await prisma.calendarLeaveClassification.deleteMany({ where: { workspaceId } });
    return alias;
  }

  async deleteAlias(workspaceId, id) {
    const result = await prisma.calendarLeaveAlias.deleteMany({ where: { id, workspaceId } });
    if (result.count > 0) {
      await prisma.calendarLeaveClassification.deleteMany({ where: { workspaceId } });
    }
    return result;
  }

  async fetchEvents(workspaceId, { startDate, endDate, top = 500 } = {}) {
    const cfg = await this.getConfig(workspaceId);
    if (!cfg) throw new Error('Calendar leave source is not configured');
    const client = this._getGraphClient();
    const start = startDate || formatDateUTC(new Date(Date.now() - cfg.lookbackDays * 86400000));
    const end = endDate || formatDateUTC(new Date(Date.now() + cfg.horizonDays * 86400000));
    let request = client
      .api(`/groups/${cfg.graphGroupId}/calendarView`)
      .header('Prefer', `outlook.timezone="${cfg.timezone}"`)
      .query({
        startDateTime: `${start}T00:00:00`,
        endDateTime: `${end}T23:59:59`,
        $top: Math.min(top, 100),
        $select: 'id,subject,start,end,isAllDay,showAs,organizer,categories,type,location,lastModifiedDateTime',
      });

    const events = [];
    while (request && events.length < top) {
      const response = await request.get();
      events.push(...(response.value || []));
      request = response['@odata.nextLink'] && events.length < top
        ? client.api(response['@odata.nextLink'])
        : null;
    }
    return events.slice(0, top);
  }

  _matchAlias(subject, aliases) {
    const head = normalize(firstSubjectChunk(subject));
    const full = normalize(subject);
    const matches = aliases.filter((alias) => {
      if (alias.isIgnored) return head === alias.normalizedAlias || full.includes(alias.normalizedAlias);
      return head === alias.normalizedAlias
        || head.split(' ').includes(alias.normalizedAlias)
        || full.startsWith(`${alias.normalizedAlias} `);
    });
    const ignored = matches.find((m) => m.isIgnored);
    if (ignored) return { status: 'ignored_alias', alias: ignored };

    const byTech = new Map();
    for (const m of matches.filter((item) => item.technicianId)) byTech.set(m.technicianId, m);
    if (byTech.size === 1) {
      const alias = [...byTech.values()][0];
      return { status: 'matched', alias, technicianId: alias.technicianId };
    }
    if (byTech.size > 1) {
      return { status: 'ambiguous', candidates: [...byTech.values()].map((m) => m.alias) };
    }
    return { status: 'unmatched' };
  }

  _applyRules(event, rules) {
    for (const rule of rules) {
      if (!rule.isActive) continue;
      const regex = compileRule(rule);
      if (!regex) continue;
      if (regex.test(event.subject || '')) {
        return {
          category: rule.category,
          halfDayPart: rule.halfDayPart === 'INFER' ? inferHalfDay(event.subject, event) : rule.halfDayPart,
          confidence: 0.9,
          source: 'rule',
          ruleId: rule.id,
          ruleName: rule.name,
          reason: `Matched rule: ${rule.name}`,
        };
      }
    }
    return null;
  }

  async _classifyWithLlm(workspaceId, event, technicians, aliases, fingerprint) {
    const cached = await prisma.calendarLeaveClassification.findUnique({
      where: { workspaceId_eventFingerprint: { workspaceId, eventFingerprint: fingerprint } },
    });
    if (cached?.classification?.version === CLASSIFICATION_VERSION) {
      return { ...cached.classification, source: cached.source, cached: true };
    }

    if (!anthropicService.isConfigured()) {
      return { category: 'OTHER', isLeave: false, confidence: 0, source: 'none', cached: false, reason: 'ANTHROPIC_API_KEY is not configured' };
    }

    const systemPrompt = 'You classify shared Accounting calendar entries into technician availability records. Return only JSON. Categories: OFF, WFH, OTHER, IGNORED. Use IGNORED for statutory holidays, meetings, reminders, pension/admin events, or entries that are not a person\'s leave/appointment. If an entry looks like a person\'s leave but the person is not in the technician/alias list, keep the leave category with technicianId null so it can be reviewed. Use halfDayPart AM or PM only when the subject/time clearly indicates it.';
    const userMessage = JSON.stringify({
      event: {
        subject: event.subject,
        start: event.start,
        end: event.end,
        isAllDay: event.isAllDay,
        showAs: event.showAs,
        categories: event.categories || [],
        location: event.location?.displayName || '',
      },
      technicians: technicians.map((t) => ({ id: t.id, name: t.name, email: t.email, isActive: t.isActive })),
      aliases: aliases.map((a) => ({ alias: a.alias, technicianId: a.technicianId, technicianName: a.technician?.name || null, isIgnored: a.isIgnored })),
      requiredJsonShape: {
        isLeave: true,
        personAlias: 'name or null',
        technicianId: 'number or null',
        category: 'OFF|WFH|OTHER|IGNORED',
        halfDayPart: 'AM|PM|null',
        confidence: '0..1',
        reason: 'short explanation',
      },
    });

    let parsed;
    try {
      const result = await anthropicService.sendMessage({
        systemPrompt,
        userMessage,
        model: config.anthropic.calendarModel,
        maxTokens: 500,
        temperature: 0,
      });
      parsed = result.parsed || {};
    } catch (error) {
      logger.warn('Calendar leave LLM classification failed', { workspaceId, subject: event.subject, error: error.message });
      parsed = { isLeave: false, category: 'OTHER', confidence: 0, reason: error.message };
    }

    const classification = {
      isLeave: parsed.isLeave === true,
      personAlias: typeof parsed.personAlias === 'string' ? parsed.personAlias : null,
      technicianId: Number.isInteger(parsed.technicianId) ? parsed.technicianId : null,
      category: VALID_CATEGORIES.has(parsed.category) ? parsed.category : 'OTHER',
      halfDayPart: ['AM', 'PM'].includes(parsed.halfDayPart) ? parsed.halfDayPart : null,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.4,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 500) : 'LLM classified calendar entry',
      version: CLASSIFICATION_VERSION,
    };

    await prisma.calendarLeaveClassification.upsert({
      where: { workspaceId_eventFingerprint: { workspaceId, eventFingerprint: fingerprint } },
      create: {
        workspaceId,
        graphEventId: event.id,
        lastModifiedAt: event.lastModifiedDateTime ? new Date(event.lastModifiedDateTime) : null,
        eventFingerprint: fingerprint,
        source: 'llm',
        classification,
        confidence: classification.confidence,
      },
      update: {
        graphEventId: event.id,
        lastModifiedAt: event.lastModifiedDateTime ? new Date(event.lastModifiedDateTime) : null,
        classification,
        confidence: classification.confidence,
      },
    });
    return { ...classification, source: 'llm', cached: false };
  }

  async classifyEvents(workspaceId, events, { useLlm = true, llmLimit = null } = {}) {
    const [rules, aliases, technicians] = await Promise.all([
      this.getRules(workspaceId),
      this.getAliases(workspaceId),
      prisma.technician.findMany({ where: { workspaceId }, select: { id: true, name: true, email: true, isActive: true } }),
    ]);

    const rows = [];
    let llmApplied = 0;
    let llmSkipped = 0;
    let llmCacheHits = 0;
    let llmFreshCalls = 0;
    let llmFailures = 0;
    for (const event of events) {
      const fingerprint = eventFingerprint(event);
      const aliasMatch = this._matchAlias(event.subject, aliases);
      const ruleMatch = this._applyRules(event, rules);
      let classification = null;
      let technicianId = aliasMatch.technicianId || null;
      let requiresReview = false;

      if (aliasMatch.status === 'ignored_alias') {
        classification = { category: 'IGNORED', halfDayPart: null, confidence: 1, source: 'alias', reason: `Ignored alias: ${aliasMatch.alias.alias}` };
      } else if (ruleMatch && aliasMatch.status === 'matched') {
        classification = ruleMatch;
      } else if (ruleMatch?.category === 'IGNORED') {
        classification = ruleMatch;
      } else if (useLlm && (llmLimit === null || llmApplied < llmLimit)) {
        llmApplied++;
        classification = await this._classifyWithLlm(workspaceId, event, technicians, aliases, fingerprint);
        if (classification.cached) llmCacheHits++;
        else if (classification.source === 'llm') llmFreshCalls++;
        else llmFailures++;
        technicianId = classification.technicianId || technicianId;
        if (classification.category === 'IGNORED' && ruleMatch && ruleMatch.category !== 'IGNORED') {
          classification = {
            ...ruleMatch,
            confidence: Math.min(ruleMatch.confidence ?? 0.7, 0.7),
            source: 'rule',
            reason: `${ruleMatch.reason}; no matching technician alias`,
          };
        }
      } else {
        if (useLlm) llmSkipped++;
        classification = ruleMatch || { category: 'OTHER', halfDayPart: null, confidence: 0.2, source: 'unmatched', reason: 'No alias/rule match' };
      }

      if (!technicianId && classification.personAlias) {
        const llmAlias = this._matchAlias(classification.personAlias, aliases);
        technicianId = llmAlias.technicianId || null;
      }

      const technician = technicians.find((t) => t.id === technicianId) || null;
      const isLeave = classification.category !== 'IGNORED'
        && (classification.isLeave !== false)
        && !!technicianId;

      if (!technicianId && classification.category !== 'IGNORED') requiresReview = true;
      if ((classification.confidence ?? 0) < 0.75 && classification.category !== 'IGNORED') requiresReview = true;
      if (technician?.isActive === false && classification.category !== 'IGNORED') requiresReview = true;

      rows.push({
        event,
        eventFingerprint: fingerprint,
        subject: event.subject || '',
        nameGuess: firstSubjectChunk(event.subject),
        personAlias: classification.personAlias || null,
        technicianId,
        technician,
        technicianIsActive: technician?.isActive ?? null,
        category: classification.category,
        halfDayPart: classification.halfDayPart || inferHalfDay(event.subject, event),
        confidence: classification.confidence ?? 0,
        source: classification.source,
        llmCached: classification.cached === true,
        reason: classification.reason,
        aliasStatus: aliasMatch.status,
        isLeave,
        requiresReview,
      });
    }
    return { rows, llmApplied, llmSkipped, llmCacheHits, llmFreshCalls, llmFailures };
  }

  async preview(workspaceId, { startDate, endDate, useLlm = false, top = 200, llmLimit = null } = {}) {
    const startedAt = Date.now();
    const events = await this.fetchEvents(workspaceId, { startDate, endDate, top });
    const {
      rows,
      llmApplied,
      llmSkipped,
      llmCacheHits,
      llmFreshCalls,
      llmFailures,
    } = await this.classifyEvents(workspaceId, events, { useLlm, llmLimit });
    const result = {
      total: rows.length,
      matched: rows.filter((r) => r.isLeave && !r.requiresReview).length,
      reviewNeeded: rows.filter((r) => r.requiresReview).length,
      ignored: rows.filter((r) => r.category === 'IGNORED').length,
      llmApplied,
      llmSkipped,
      llmCacheHits,
      llmFreshCalls,
      llmFailures,
      durationMs: Date.now() - startedAt,
      rows: rows.map((r) => ({
        eventFingerprint: r.eventFingerprint,
        subject: r.subject,
        start: r.event.start,
        end: r.event.end,
        isAllDay: r.event.isAllDay,
        technicianId: r.technicianId,
        technicianName: r.technician?.name || null,
        technicianIsActive: r.technicianIsActive,
        nameGuess: r.nameGuess,
        personAlias: r.personAlias,
        category: r.category,
        halfDayPart: r.halfDayPart,
        confidence: r.confidence,
        source: r.source,
        llmCached: r.llmCached,
        reason: r.reason,
        requiresReview: r.requiresReview,
      })),
    };
    logger.info('Calendar leave preview completed', {
      workspaceId,
      useLlm,
      top,
      llmLimit,
      total: result.total,
      reviewNeeded: result.reviewNeeded,
      ignored: result.ignored,
      llmApplied,
      llmSkipped,
      llmCacheHits,
      llmFreshCalls,
      llmFailures,
      durationMs: result.durationMs,
    });
    return result;
  }

  async sync(workspaceId, { startDate, endDate, useLlm = true } = {}) {
    const cfg = await this.getConfig(workspaceId);
    if (!cfg) throw new Error('Calendar leave source is not configured');
    const start = startDate || formatDateUTC(new Date(Date.now() - cfg.lookbackDays * 86400000));
    const end = endDate || formatDateUTC(new Date(Date.now() + cfg.horizonDays * 86400000));
    const events = await this.fetchEvents(workspaceId, { startDate: start, endDate: end, top: 1000 });
    const { rows } = await this.classifyEvents(workspaceId, events, { useLlm });
    const leaveRows = [];
    const validKeys = new Set();

    for (const row of rows) {
      if (!row.isLeave || row.requiresReview) continue;
      const dates = expandDateRange(row.event.start?.dateTime, row.event.end?.dateTime, row.event.isAllDay);
      const minutes = deriveMinutes(row.event, row.halfDayPart);
      for (const date of dates) {
        const vtLeaveId = `graph:${row.eventFingerprint}:${row.technicianId}`;
        leaveRows.push({
          workspaceId,
          technicianId: row.technicianId,
          vtLeaveId,
          leaveDate: date,
          leaveTypeName: row.subject.slice(0, 255),
          category: row.category,
          status: 'APPROVED',
          isFullDay: minutes.isFullDay,
          halfDayPart: minutes.halfDayPart,
          startMinute: minutes.startMinute,
          endMinute: minutes.endMinute,
        });
        validKeys.add(`${vtLeaveId}|${normalizeDateOnly(date)}`);
      }
    }

    await vtRepo.bulkUpsertLeaves(leaveRows);
    const existingGraphLeaves = await prisma.technicianLeave.findMany({
      where: {
        workspaceId,
        leaveDate: { gte: new Date(`${start}T00:00:00Z`), lte: new Date(`${end}T00:00:00Z`) },
        vtLeaveId: { startsWith: 'graph:' },
      },
      select: { id: true, vtLeaveId: true, leaveDate: true },
    });
    const staleGraphLeaves = existingGraphLeaves.filter((row) => {
      const key = `${row.vtLeaveId}|${normalizeDateOnly(row.leaveDate)}`;
      return !validKeys.has(key);
    });
    const deleted = staleGraphLeaves.length > 0
      ? await prisma.technicianLeave.deleteMany({ where: { id: { in: staleGraphLeaves.map((row) => row.id) } } })
      : { count: 0 };
    await prisma.calendarLeaveSourceConfig.update({
      where: { workspaceId },
      data: { lastSyncAt: new Date() },
    });

    return {
      eventsProcessed: rows.length,
      leaveDaysCreated: leaveRows.length,
      staleRemoved: deleted.count || 0,
      reviewNeeded: rows.filter((r) => r.requiresReview).length,
      ignored: rows.filter((r) => r.category === 'IGNORED').length,
    };
  }
}

export default new CalendarLeaveService();
export { normalize, DEFAULT_RULES };
