import prisma from './prisma.js';
import { ValidationError } from '../utils/errors.js';
import ticketTypeService from './ticketTypeService.js';
import businessCalendarService from './businessCalendarService.js';

/**
 * Ticket Pulse's own SLA targets for TP-born tickets: per-priority first-
 * response / resolution windows applied at creation (FS-born tickets keep
 * FreshService's SLA fields untouched). Escalation LADDERS are built as
 * workflows on the sla_pre_breach / sla_breach triggers with assignment and
 * priority actions — policy here only sets the clocks.
 *
 * Policies are keyed (workspace, priority, ticketTypeId) where a NULL
 * ticketTypeId is the "all types" fallback row. Matching walks: exact
 * type-specific policy -> fallback policy -> no clocks. Type-less tickets
 * (FS allows them) always use the fallback.
 *
 * Calendar-aware clocks (Phase SLA, QA 08-17 #9): when the workspace opts in
 * (Workspace.slaCalendarAware) weekends, disabled days and holidays don't
 * burn SLA time. Workspace.slaCalendarStyle picks WHAT is skipped (QA 09-17
 * #1): 'business_hours' counts only the hours inside the business-hours
 * window, 'business_days' keeps a 24-hour clock and skips non-working days
 * whole (Friday 2 pm + 24 h = Monday 2 pm). Per-policy calendarMode overrides
 * in either direction ('calendar' / 'business_days' force one on, 'always_on'
 * is the 24/7 escape hatch). The calendar is baked into the STORED dueBy here
 * at write time, so every downstream `dueBy < now` comparison stays unchanged.
 */
const CALENDAR_MODES = ['inherit', 'calendar', 'business_days', 'always_on'];
// Workspace-level meaning of "calendar-aware" (QA 09-17 #1). 'business_hours'
// is the original behaviour (only the hours inside the business-hours window
// burn SLA time); 'business_days' keeps a 24-hour clock but skips non-working
// days whole, which is what teams on a "1 business day" target expect:
// Friday 2 pm + 24 h = Monday 2 pm, not Wednesday morning.
export const CALENDAR_STYLES = ['business_hours', 'business_days'];
const DEFAULT_CALENDAR_STYLE = 'business_hours';
const FLAG_CACHE_TTL_MS = 60 * 1000;

class SlaPolicyService {
  constructor() {
    // Tiny TTL cache for the per-workspace calendar flag + style — dueDatesFor
    // runs on every TP-born create and both change only via the Settings
    // toggle (which clears this cache).
    this._calendarFlagCache = new Map(); // workspaceId -> { value, expiresAt }
  }

  clearCalendarFlagCache() {
    this._calendarFlagCache.clear();
  }

  /** { aware, style } for a workspace — one cached read for both. */
  async _workspaceCalendarSettings(workspaceId) {
    const cached = this._calendarFlagCache.get(workspaceId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    let value = { aware: false, style: DEFAULT_CALENDAR_STYLE };
    try {
      const ws = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { slaCalendarAware: true, slaCalendarStyle: true },
      });
      value = {
        aware: ws?.slaCalendarAware === true,
        // An unmigrated column reads back undefined — keep the old meaning.
        style: CALENDAR_STYLES.includes(ws?.slaCalendarStyle) ? ws.slaCalendarStyle : DEFAULT_CALENDAR_STYLE,
      };
    } catch { /* missing column / transient DB hiccup → wall-clock behavior */ }
    this._calendarFlagCache.set(workspaceId, { value, expiresAt: Date.now() + FLAG_CACHE_TTL_MS });
    return value;
  }

  /** Back-compat shim — the boolean half of _workspaceCalendarSettings. */
  async _workspaceCalendarAware(workspaceId) {
    return (await this._workspaceCalendarSettings(workspaceId)).aware;
  }
  async list(workspaceId) {
    return prisma.slaPolicy.findMany({
      where: { workspaceId },
      include: { ticketType: { select: { id: true, name: true, color: true, abbreviation: true, isActive: true } } },
      orderBy: [{ priority: 'desc' }, { ticketTypeId: { sort: 'asc', nulls: 'first' } }],
    });
  }

  async upsert(workspaceId, { priority, ticketTypeId = null, firstResponseMinutes, resolveMinutes, isActive = true, calendarMode = undefined }, actor) {
    const prio = Number(priority);
    if (!Number.isInteger(prio) || prio < 1 || prio > 4) throw new ValidationError('Priority must be 1–4');
    const fr = normalizedMinutes(firstResponseMinutes, 'First-response');
    const resolve = normalizedMinutes(resolveMinutes, 'Resolution');
    if (fr === null && resolve === null) throw new ValidationError('Set at least one SLA window');
    if (calendarMode !== undefined && !CALENDAR_MODES.includes(calendarMode)) {
      throw new ValidationError(`calendarMode must be one of ${CALENDAR_MODES.join(', ')}`);
    }

    // Product rule: SLAs are defined PER TYPE — no generic rows anymore
    // (existing generic rows were replicated per-type and removed).
    if (ticketTypeId === null || ticketTypeId === undefined || ticketTypeId === '') {
      throw new ValidationError('SLA policies are per ticket type — pick a type');
    }
    const typeId = Number(ticketTypeId);
    const type = await prisma.ticketTypeDefinition.findFirst({ where: { id: typeId, workspaceId } });
    if (!type) throw new ValidationError('Unknown ticket type for this workspace');

    // The composite unique treats NULL type as distinct rows in Postgres, so
    // fallback-row upserts go through findFirst+update instead of upsert().
    const existing = await prisma.slaPolicy.findFirst({
      where: { workspaceId, priority: prio, ticketTypeId: typeId },
    });
    const fields = {
      firstResponseMinutes: fr,
      resolveMinutes: resolve,
      isActive: isActive !== false,
      updatedBy: actor?.email || null,
      ...(calendarMode !== undefined ? { calendarMode } : {}),
    };
    if (existing) {
      return prisma.slaPolicy.update({ where: { id: existing.id }, data: fields });
    }
    return prisma.slaPolicy.create({
      data: { workspaceId, priority: prio, ticketTypeId: typeId, ...fields },
    });
  }

  async remove(workspaceId, priority, ticketTypeId = null) {
    const typeId = ticketTypeId === null || ticketTypeId === undefined || ticketTypeId === ''
      ? null
      : Number(ticketTypeId);
    await prisma.slaPolicy.deleteMany({ where: { workspaceId, priority: Number(priority), ticketTypeId: typeId } });
    return { deleted: true };
  }

  /**
   * Due dates for a new TP-born ticket, or nulls when no active policy.
   * Pass the ticket's type via { typeName } (canonical string) or
   * { ticketTypeId }; omitted/unknown types use the fallback row.
   */
  async dueDatesFor(workspaceId, priority, from = new Date(), { typeName = null, ticketTypeId = null } = {}) {
    let typeId = ticketTypeId === null || ticketTypeId === undefined ? null : Number(ticketTypeId);
    if (typeId === null && typeName) {
      const def = await ticketTypeService.resolveType(workspaceId, typeName);
      typeId = def?.id ?? null;
    }

    const prio = Number(priority) || 2;
    let policy = null;
    if (typeId !== null) {
      policy = await prisma.slaPolicy.findFirst({
        where: { workspaceId, priority: prio, ticketTypeId: typeId, isActive: true },
      });
    }
    if (!policy) {
      policy = await prisma.slaPolicy.findFirst({
        where: { workspaceId, priority: prio, ticketTypeId: null, isActive: true },
      });
    }
    if (!policy) return { frDueBy: null, dueBy: null };

    // Wall-clock helper stays THE fallback path — 'always_on' policies,
    // opted-out workspaces and calendar failures all land here.
    const wallClockAt = (minutes) => (minutes ? new Date(from.getTime() + minutes * 60 * 1000) : null);

    // Effective mode: per-policy override wins; 'inherit' follows the
    // workspace flag AND its style (cached lookup — this runs on every
    // TP-born create).
    const workspaceCalendar = await this._workspaceCalendarSettings(workspaceId);
    const inheritedMode = workspaceCalendar.aware
      ? (workspaceCalendar.style === 'business_days' ? 'business_days' : 'calendar')
      : 'always_on';
    const mode = policy.calendarMode && policy.calendarMode !== 'inherit'
      ? policy.calendarMode
      : inheritedMode;
    if (mode !== 'calendar' && mode !== 'business_days') {
      return { frDueBy: wallClockAt(policy.firstResponseMinutes), dueBy: wallClockAt(policy.resolveMinutes) };
    }

    try {
      // One calendar load covers both targets. loadCalendar returns null for
      // workspaces with zero enabled days → the walkers wall-clock.
      const calendar = await businessCalendarService.loadCalendar(workspaceId);
      const walk = mode === 'business_days'
        ? businessCalendarService.addBusinessDayMinutes.bind(businessCalendarService)
        : businessCalendarService.addBusinessMinutes.bind(businessCalendarService);
      const at = async (minutes) => (minutes
        ? walk(from, minutes, { workspaceId, calendar })
        : null);
      return { frDueBy: await at(policy.firstResponseMinutes), dueBy: await at(policy.resolveMinutes) };
    } catch {
      // Calendar math must never block ticket creation.
      return { frDueBy: wallClockAt(policy.firstResponseMinutes), dueBy: wallClockAt(policy.resolveMinutes) };
    }
  }
}

function normalizedMinutes(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 60 * 24 * 60) {
    throw new ValidationError(`${label} window must be between 5 minutes and 60 days`);
  }
  return minutes;
}

const slaPolicyService = new SlaPolicyService();
export default slaPolicyService;
