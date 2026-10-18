import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import prisma from './prisma.js';

export const AFTER_HOURS_CONTACT_MODES = Object.freeze(['manual', 'weekly_rotation']);

export function normalizeAfterHoursContactMode(value) {
  const mode = String(value || '').trim();
  return AFTER_HOURS_CONTACT_MODES.includes(mode) ? mode : 'manual';
}

export function normalizeRotationOrder(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0),
  )];
}

function preferredPhone(preference = {}) {
  const safePreference = preference || {};
  return safePreference.phoneOverride || safePreference.entraMobilePhone || safePreference.entraPhone || null;
}

function verifiedPhone(preference = {}) {
  const phone = preferredPhone(preference);
  return phone && preference?.phoneVerifiedAt ? phone : null;
}

function startOfWorkspaceWeek(date = new Date(), timezone = 'America/Vancouver') {
  const zoned = toZonedTime(date, timezone);
  const day = zoned.getDay();
  const daysSinceMonday = (day + 6) % 7;
  zoned.setDate(zoned.getDate() - daysSinceMonday);
  zoned.setHours(0, 0, 0, 0);
  return fromZonedTime(zoned, timezone);
}

export function defaultRotationAnchorDate(timezone = 'America/Vancouver', reference = new Date()) {
  return startOfWorkspaceWeek(reference, timezone);
}

function weeksSinceAnchor(anchorDate, at = new Date()) {
  const anchor = anchorDate ? new Date(anchorDate) : null;
  if (!anchor || Number.isNaN(anchor.getTime())) return 0;
  const diff = at.getTime() - anchor.getTime();
  if (diff <= 0) return 0;
  return Math.floor(diff / (7 * 24 * 60 * 60 * 1000));
}

function serializeTechnician(row, source, rotationLabel, phone, extra = {}) {
  if (!row?.technician) return null;
  return {
    technicianId: row.technician.id,
    name: row.technician.name,
    email: row.technician.email || null,
    photoUrl: row.technician.photoUrl || null,
    phone: phone || null,
    rotationLabel,
    source,
    phoneVerified: Boolean(phone),
    ...extra,
  };
}

function contactFromRow(row, source, rotationLabel, showPhone) {
  const phone = showPhone ? verifiedPhone(row?.technician?.notificationPreference || null) : null;
  return serializeTechnician(row, source, rotationLabel, phone, {
    phoneHidden: showPhone === false,
    warnings: showPhone === false
      ? ['phone_hidden_by_workspace_setting']
      : phone ? [] : ['selected_contact_phone_not_verified'],
  });
}

function fallbackFromRoster(rows, showPhone) {
  if (!showPhone) return null;
  for (const row of rows) {
    const phone = verifiedPhone(row?.technician?.notificationPreference || null);
    if (phone) {
      return serializeTechnician(row, 'roster_fallback', 'First roster member with a verified phone', phone, {
        warnings: ['active_contact_missing_verified_phone'],
      });
    }
  }
  return null;
}

function fallbackFromLegacy(policy, showPhone) {
  if (!showPhone) return null;
  const phone = Array.isArray(policy?.legacyPhones) ? policy.legacyPhones.find(Boolean) : null;
  if (!phone) return null;
  return {
    technicianId: null,
    name: 'After-hours support',
    email: null,
    photoUrl: null,
    phone,
    rotationLabel: 'Legacy phone fallback',
    source: 'legacy_fallback',
    phoneVerified: false,
    warnings: ['legacy_phone_fallback'],
  };
}

/**
 * The on-call person of the Urgent response rotation (Settings → Urgent
 * Response → On-call), which follows the handover time and the covers. Null
 * when no order is saved there, or on any failure — the caller then keeps the
 * legacy weekly rotation. Imported lazily: the on-call service is newer than
 * this file and must never be able to break the requester's e-mail.
 */
async function onCallRotationRow(workspaceId, at, byTechnicianId) {
  try {
    const { default: onCallService } = await import('./urgentResponse/onCallService.js');
    const current = await onCallService.current(workspaceId, at);
    if (!current?.configured || !current.technician?.id) return null;
    const id = current.technician.id;
    let row = byTechnicianId.get(id) || null;
    if (!row) {
      // On call but not on the escalation roster: read the person (never the photo).
      const technician = await prisma.technician.findFirst({
        where: { id, workspaceId, isActive: true },
        select: { id: true, name: true, email: true, notificationPreference: true },
      });
      row = technician ? { technicianId: id, technician } : null;
    }
    if (!row) return null;
    const label = current.cover && current.scheduled?.name ? `On call (covering for ${current.scheduled.name})` : 'On call this week';
    return { row, label };
  } catch {
    return null;
  }
}

export async function resolveAfterHoursActiveContact(workspaceId, options = {}) {
  const numericWorkspaceId = Number(workspaceId);
  if (!numericWorkspaceId) {
    return {
      technicianId: null,
      name: null,
      email: null,
      photoUrl: null,
      phone: null,
      rotationLabel: 'No workspace',
      source: 'none',
      phoneVerified: false,
      warnings: ['missing_workspace'],
    };
  }

  const [policy, workspace] = await Promise.all([
    prisma.urgentEscalationPolicy.findUnique({
      where: { workspaceId: numericWorkspaceId },
      include: {
        recipients: {
          where: { scope: 'base' },
          orderBy: { createdAt: 'asc' },
          include: {
            technician: {
              include: { notificationPreference: true },
            },
          },
        },
      },
    }),
    prisma.workspace.findUnique({
      where: { id: numericWorkspaceId },
      select: { defaultTimezone: true },
    }).catch(() => null),
  ]);

  if (!policy) {
    return {
      technicianId: null,
      name: null,
      email: null,
      photoUrl: null,
      phone: null,
      rotationLabel: 'Urgent escalation is not configured',
      source: 'none',
      phoneVerified: false,
      warnings: ['policy_missing'],
    };
  }

  const timezone = workspace?.defaultTimezone || options.timezone || 'America/Vancouver';
  const at = options.at ? new Date(options.at) : new Date();
  const showPhone = policy.showAfterHoursPhoneInEmail !== false;
  const rows = Array.isArray(policy.recipients) ? policy.recipients : [];
  const byTechnicianId = new Map(rows.map((row) => [row.technicianId, row]));
  const mode = normalizeAfterHoursContactMode(policy.afterHoursContactMode);
  let selected = null;

  const onCall = mode === 'weekly_rotation'
    ? await onCallRotationRow(numericWorkspaceId, Number.isNaN(at.getTime()) ? new Date() : at, byTechnicianId)
    : null;

  if (onCall) {
    selected = contactFromRow(onCall.row, 'weekly_rotation', onCall.label, showPhone);
  } else if (mode === 'weekly_rotation') {
    const rotationOrder = normalizeRotationOrder(policy.afterHoursRotationOrder).filter((id) => byTechnicianId.has(id));
    const effectiveOrder = rotationOrder.length ? rotationOrder : rows.map((row) => row.technicianId);
    if (effectiveOrder.length) {
      const anchor = policy.afterHoursRotationAnchorDate || defaultRotationAnchorDate(timezone);
      const weekIndex = weeksSinceAnchor(anchor, Number.isNaN(at.getTime()) ? new Date() : at);
      const activeId = effectiveOrder[weekIndex % effectiveOrder.length];
      selected = contactFromRow(
        byTechnicianId.get(activeId),
        'weekly_rotation',
        `Weekly rotation ${weekIndex + 1} of ${effectiveOrder.length}`,
        showPhone,
      );
    }
  } else if (policy.afterHoursManualTechnicianId) {
    selected = contactFromRow(
      byTechnicianId.get(policy.afterHoursManualTechnicianId),
      'manual',
      'Manual after-hours contact',
      showPhone,
    );
  }

  if (selected?.phone || selected?.phoneHidden) return selected;

  const rosterFallback = fallbackFromRoster(rows, showPhone);
  if (rosterFallback) return rosterFallback;

  const legacyFallback = fallbackFromLegacy(policy, showPhone);
  if (legacyFallback) return legacyFallback;

  return {
    technicianId: selected?.technicianId || null,
    name: selected?.name || null,
    email: selected?.email || null,
    photoUrl: selected?.photoUrl || null,
    phone: null,
    rotationLabel: selected?.rotationLabel || (mode === 'weekly_rotation' ? 'Weekly rotation' : 'Manual after-hours contact'),
    source: selected?.source || mode,
    phoneVerified: false,
    phoneHidden: showPhone === false,
    warnings: showPhone === false ? ['phone_hidden_by_workspace_setting'] : ['no_verified_after_hours_phone'],
  };
}

export default {
  AFTER_HOURS_CONTACT_MODES,
  normalizeAfterHoursContactMode,
  normalizeRotationOrder,
  defaultRotationAnchorDate,
  resolveAfterHoursActiveContact,
};
