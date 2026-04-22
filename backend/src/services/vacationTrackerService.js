import VacationTrackerClient from '../integrations/vacationTracker.js';
import vtRepo from './vacationTrackerRepository.js';
import technicianRepository from './technicianRepository.js';
import logger from '../utils/logger.js';

const syncState = {
  running: false,
  progress: null,
};

function normalizeName(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(part => part.length > 1)
    .join(' ');
}

function expandDateRange(startDate, endDate) {
  const dates = [];
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');

  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(new Date(d));
  }
  return dates;
}

function formatDateUTC(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Derive the half-day metadata for a single VT leave record.
 *
 * Returns { isFullDay, halfDayPart, startMinute, endMinute }.
 *
 * Rules (verified against live IT-workspace VT data 2026-04-21):
 *   - VT only marks a leave partial when isFullDayLeave === false. If the
 *     flag is missing or true → treat as full day.
 *   - Partial leaves always carry startHour/endHour (and startMinute/endMinute,
 *     which can be 0 or 30 in practice).
 *   - We never observed multi-day partial leaves in live data, but if VT ever
 *     returns one we conservatively treat *every* day in the range as full
 *     except the boundary (caller decides via `isBoundaryDay`). Today only the
 *     single-day path is exercised.
 *   - AM vs PM is decided by where the window's MIDPOINT falls relative to
 *     12:00 noon. This handles edge cases like 09:00–13:00 (midpoint 11:00 →
 *     AM) and 12:30–16:30 (midpoint 14:30 → PM).
 */
export function deriveHalfDayMeta(leave, isBoundaryDay = true) {
  const fullDay = leave.isFullDayLeave !== false;
  if (fullDay || !isBoundaryDay) {
    return { isFullDay: true, halfDayPart: null, startMinute: null, endMinute: null };
  }

  const startMinute = (leave.startHour ?? 0) * 60 + (leave.startMinute ?? 0);
  const endMinute = (leave.endHour ?? 0) * 60 + (leave.endMinute ?? 0);

  // Defensive: if VT gave us a zero-length or inverted window, fall back to
  // treating it as a full-day leave so we don't silently drop the row.
  if (endMinute <= startMinute) {
    return { isFullDay: true, halfDayPart: null, startMinute: null, endMinute: null };
  }

  const midpoint = (startMinute + endMinute) / 2;
  const halfDayPart = midpoint < 12 * 60 ? 'AM' : 'PM';

  return { isFullDay: false, halfDayPart, startMinute, endMinute };
}

class VacationTrackerService {
  _getClient(apiKey) {
    return new VacationTrackerClient(apiKey);
  }

  async _getClientForWorkspace(workspaceId) {
    const config = await vtRepo.getConfig(workspaceId);
    if (!config?.apiKey) {
      throw new Error('Vacation Tracker is not configured for this workspace');
    }
    return this._getClient(config.apiKey);
  }

  async testConnection(apiKey) {
    try {
      const client = this._getClient(apiKey);
      const ok = await client.testConnection();
      return { success: ok };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async syncLeaveTypes(workspaceId) {
    const client = await this._getClientForWorkspace(workspaceId);
    const vtLeaveTypes = await client.fetchLeaveTypes();

    const results = [];
    for (const lt of vtLeaveTypes) {
      const existing = (await vtRepo.getLeaveTypes(workspaceId))
        .find(e => e.vtLeaveTypeId === lt.id);

      const result = await vtRepo.upsertLeaveType(workspaceId, lt.id, {
        vtLeaveTypeName: lt.name,
        color: lt.color || null,
        isActive: lt.isActive !== false,
        ...(existing ? {} : { category: guessCategory(lt.name) }),
      });
      results.push(result);
    }

    logger.info(`Synced ${results.length} leave types for workspace ${workspaceId}`);
    return results;
  }

  async syncUsers(workspaceId) {
    const client = await this._getClientForWorkspace(workspaceId);
    const vtUsers = await client.fetchUsers();
    const technicians = await technicianRepository.getAllActive(workspaceId);

    const techByEmail = new Map();
    const techByName = new Map();
    for (const tech of technicians) {
      if (tech.email) techByEmail.set(tech.email.toLowerCase(), tech);
      techByName.set(normalizeName(tech.name), tech);
    }

    const results = [];
    for (const user of vtUsers) {
      const existing = (await vtRepo.getUserMappings(workspaceId))
        .find(m => m.vtUserId === user.id);

      let technicianId = existing?.technicianId || null;
      let matchStatus = existing?.matchStatus || 'unmatched';

      if (!technicianId || matchStatus === 'unmatched') {
        const emailMatch = user.email ? techByEmail.get(user.email.toLowerCase()) : null;
        if (emailMatch) {
          technicianId = emailMatch.id;
          matchStatus = 'auto_matched';
        } else {
          const nameMatch = techByName.get(normalizeName(user.name));
          if (nameMatch) {
            technicianId = nameMatch.id;
            matchStatus = 'auto_matched';
          }
        }
      }

      const result = await vtRepo.upsertUserMapping(workspaceId, user.id, {
        vtUserName: user.name,
        vtUserEmail: user.email || '',
        technicianId,
        matchStatus,
      });
      results.push(result);
    }

    const matched = results.filter(r => r.matchStatus !== 'unmatched').length;
    logger.info(`Synced ${results.length} VT users for workspace ${workspaceId} (${matched} matched)`);
    return results;
  }

  async syncLeaves(workspaceId, startDate, endDate) {
    if (syncState.running) {
      throw new Error('A vacation tracker sync is already in progress');
    }

    syncState.running = true;
    syncState.progress = { step: 'starting', pct: 0 };

    try {
      const client = await this._getClientForWorkspace(workspaceId);
      const leaveTypes = await vtRepo.getLeaveTypes(workspaceId);
      const userMappings = await vtRepo.getMappedUsersByWorkspace(workspaceId);

      const leaveTypeMap = new Map(leaveTypes.map(lt => [lt.vtLeaveTypeId, lt]));
      const userMap = new Map(userMappings.map(m => [m.vtUserId, m]));

      syncState.progress = { step: 'fetching leaves', pct: 10 };
      const leaves = await client.fetchLeaves(startDate, endDate);

      syncState.progress = { step: 'processing leaves', pct: 40 };
      const leaveRows = [];
      // Track every (vtLeaveId, leaveDate) tuple that should exist post-sync.
      // Any row in the window that isn't in this set is stale and gets removed.
      const validKeys = new Set();

      for (const leave of leaves) {
        const mapping = userMap.get(leave.userId);
        if (!mapping) continue;

        const ltInfo = leaveTypeMap.get(leave.leaveTypeId);
        if (!ltInfo || ltInfo.category === 'IGNORED') continue;

        const dates = expandDateRange(leave.startDate, leave.endDate);
        const isMultiDay = dates.length > 1;

        for (const date of dates) {
          // Multi-day partial leaves haven't been seen in live data, but to
          // avoid lying about midweek dates we only stamp half-day metadata
          // on single-day partial leaves. Anything spanning multiple days is
          // treated as full on every day.
          const meta = deriveHalfDayMeta(leave, /*isBoundaryDay=*/!isMultiDay);
          leaveRows.push({
            workspaceId,
            technicianId: mapping.technicianId,
            vtLeaveId: leave.id,
            leaveDate: date,
            leaveTypeName: ltInfo.vtLeaveTypeName,
            category: ltInfo.category,
            status: leave.status || 'APPROVED',
            isFullDay: meta.isFullDay,
            halfDayPart: meta.halfDayPart,
            startMinute: meta.startMinute,
            endMinute: meta.endMinute,
          });
          validKeys.add(`${leave.id}|${date.toISOString().slice(0, 10)}`);
        }
      }

      syncState.progress = { step: 'saving to database', pct: 70 };
      await vtRepo.bulkUpsertLeaves(leaveRows);

      syncState.progress = { step: 'cleaning stale data', pct: 90 };
      const startDt = new Date(startDate + 'T00:00:00Z');
      const endDt = new Date(endDate + 'T00:00:00Z');
      const deleted = await vtRepo.deleteStaleLeaves(workspaceId, startDt, endDt, validKeys);

      await vtRepo.updateLastSyncAt(workspaceId);

      syncState.progress = { step: 'done', pct: 100 };
      logger.info(`VT leave sync complete for workspace ${workspaceId}: ${leaveRows.length} leave-days upserted, ${deleted.count || 0} stale removed`);

      return {
        leavesProcessed: leaves.length,
        leaveDaysCreated: leaveRows.length,
        staleRemoved: deleted.count || 0,
      };
    } finally {
      syncState.running = false;
    }
  }

  async fullSync(workspaceId) {
    await this.syncLeaveTypes(workspaceId);
    await this.syncUsers(workspaceId);

    const today = new Date();
    const startDate = formatDateUTC(new Date(today.getTime() - 7 * 86400000));
    const endDate = formatDateUTC(new Date(today.getTime() + 30 * 86400000));
    return this.syncLeaves(workspaceId, startDate, endDate);
  }

  getSyncStatus() {
    return {
      running: syncState.running,
      progress: syncState.progress,
    };
  }

  async getLeaveInfoForDashboard(workspaceId, startDate, endDate) {
    const leaves = await vtRepo.getLeavesByDateRange(
      workspaceId,
      new Date(startDate + 'T00:00:00Z'),
      new Date(endDate + 'T00:00:00Z'),
    );

    const byTechAndDate = {};
    for (const leave of leaves) {
      const dateKey = formatDateUTC(leave.leaveDate);
      const techId = leave.technicianId;
      if (!byTechAndDate[techId]) byTechAndDate[techId] = {};
      byTechAndDate[techId][dateKey] = {
        category: leave.category,
        typeName: leave.leaveTypeName,
        // Half-day fields. Always present (defaults: full day) so the frontend
        // can branch without null-checking the nested shape.
        isFullDay: leave.isFullDay !== false,
        halfDayPart: leave.halfDayPart || null,
        startMinute: leave.startMinute ?? null,
        endMinute: leave.endMinute ?? null,
      };
    }
    return byTechAndDate;
  }
}

function guessCategory(leaveTypeName) {
  const name = leaveTypeName.toLowerCase();
  if (name.includes('wfh') || name.includes('work from home') || name.includes('remote')) {
    return 'WFH';
  }
  if (name.includes('vacation') || name.includes('pto') || name.includes('personal time')
      || name.includes('sick') || name.includes('bereavement') || name.includes('jury')) {
    return 'OFF';
  }
  return 'OTHER';
}

export default new VacationTrackerService();
