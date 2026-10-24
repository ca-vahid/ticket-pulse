import prisma from './prisma.js';

/**
 * The after-hours contact shown to requesters: the "Can't wait until morning?"
 * card in e-mails and the immediate-support page.
 *
 * QA 10-23 #2: it is the on-call person of Settings → Urgent response →
 * On-call, which follows the handover time and the covers. The old "manual
 * contact" and "weekly rotation" of the Requester escalation page, and their
 * fallbacks (first roster phone, legacy phone), are gone: they printed the
 * same person's number every week whoever was on call. Their columns are left
 * as they are (nothing reads them now).
 *
 * A phone number is shown only when the on-call person verified it in their
 * notification preferences, and only while the workspace shows numbers at
 * all. With no number, the e-mail keeps the "Request immediate support"
 * button, which pages whoever is on call.
 */

function preferredPhone(preference = {}) {
  const safePreference = preference || {};
  return safePreference.phoneOverride || safePreference.entraMobilePhone || safePreference.entraPhone || null;
}

function verifiedPhone(preference = {}) {
  const phone = preferredPhone(preference);
  return phone && preference?.phoneVerifiedAt ? phone : null;
}

function noContact(rotationLabel, warnings, extra = {}) {
  return {
    technicianId: null,
    name: null,
    email: null,
    photoUrl: null,
    phone: null,
    rotationLabel,
    source: 'none',
    phoneVerified: false,
    warnings,
    ...extra,
  };
}

/** The on-call service is imported lazily: it must never be able to break a requester's e-mail. */
async function currentOnCall(workspaceId, at) {
  try {
    const { default: onCallService } = await import('./urgentResponse/onCallService.js');
    return await onCallService.current(workspaceId, at);
  } catch {
    return null;
  }
}

export async function resolveAfterHoursActiveContact(workspaceId, options = {}) {
  const numericWorkspaceId = Number(workspaceId);
  if (!numericWorkspaceId) return noContact('No workspace', ['missing_workspace']);

  const policy = await prisma.urgentEscalationPolicy.findUnique({
    where: { workspaceId: numericWorkspaceId },
    select: { showAfterHoursPhoneInEmail: true },
  });
  if (!policy) return noContact('Urgent escalation is not configured', ['policy_missing']);

  const showPhone = policy.showAfterHoursPhoneInEmail !== false;
  const requested = options.at ? new Date(options.at) : new Date();
  const at = Number.isNaN(requested.getTime()) ? new Date() : requested;

  const onCall = await currentOnCall(numericWorkspaceId, at);
  if (!onCall?.configured) {
    return noContact('Nobody is on call yet: set the order on the On-call tab', ['on_call_not_configured'], { phoneHidden: !showPhone });
  }
  if (!onCall.technician?.id) {
    return noContact('Nobody is on call right now', ['no_one_on_call'], { phoneHidden: !showPhone });
  }

  const id = onCall.technician.id;
  // The person, never the photo (photoUrl is a data URL; see the analytics perf rule).
  const technician = await prisma.technician.findFirst({
    where: { id, workspaceId: numericWorkspaceId, isActive: true },
    select: { id: true, name: true, email: true, notificationPreference: true },
  }).catch(() => null);
  const name = technician?.name || onCall.technician.name || null;
  const rotationLabel = onCall.cover && onCall.scheduled?.name
    ? `On call (covering for ${onCall.scheduled.name})`
    : 'On call this week';
  const until = onCall.until ? new Date(onCall.until).toISOString() : null;

  if (!technician) {
    return noContact(rotationLabel, ['on_call_person_not_found'], { name, source: 'on_call', until, phoneHidden: !showPhone });
  }

  const base = {
    technicianId: technician.id,
    name,
    email: technician.email || null,
    photoUrl: null,
    rotationLabel,
    source: 'on_call',
    until,
    phoneHidden: !showPhone,
  };
  if (!showPhone) return { ...base, phone: null, phoneVerified: false, warnings: ['phone_hidden_by_workspace_setting'] };
  // Away all day with nobody covering: the urgent engine holds rather than texting them,
  // so the e-mail doesn't print their number either.
  if (onCall.onLeaveNoCover) return { ...base, phone: null, phoneVerified: false, warnings: ['on_call_person_away_no_cover'] };
  const phone = verifiedPhone(technician.notificationPreference);
  return phone
    ? { ...base, phone, phoneVerified: true, warnings: [] }
    : { ...base, phone: null, phoneVerified: false, warnings: ['on_call_phone_not_verified'] };
}

export default { resolveAfterHoursActiveContact };
