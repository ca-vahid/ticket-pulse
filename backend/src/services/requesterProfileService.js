import prisma from './prisma.js';
import azureAdService from './azureAdService.js';
import graphMailClient from '../integrations/graphMailClient.js';
import logger from '../utils/logger.js';

const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const REQUESTER_PROFILE_SELECT = Object.freeze({
  id: true,
  name: true,
  email: true,
  phone: true,
  mobile: true,
  department: true,
  jobTitle: true,
  timeZone: true,
  language: true,
  entraOfficeLocation: true,
  entraCity: true,
  entraState: true,
  entraCountry: true,
  entraCountryCode: true,
  entraDepartment: true,
  entraJobTitle: true,
  entraPreferredLanguage: true,
  entraProfileSyncedAt: true,
});

const COUNTRY_CODE_BY_NAME = new Map([
  ['canada', 'CA'],
  ['united states', 'US'],
  ['united states of america', 'US'],
  ['chile', 'CL'],
  ['dominican republic', 'DO'],
  ['australia', 'AU'],
  ['united kingdom', 'GB'],
  ['uk', 'GB'],
]);

const REGION_LABELS = new Map([
  ['CA-BC', 'British Columbia'],
  ['CA-AB', 'Alberta'],
  ['CA-ON', 'Ontario'],
  ['CA-QC', 'Quebec'],
  ['CA-NB', 'New Brunswick'],
  ['CA-NS', 'Nova Scotia'],
  ['US-CO', 'Colorado'],
  ['US-TN', 'Tennessee'],
  ['MET', 'Santiago Metropolitan Region'],
  ['SDO', 'Santo Domingo'],
]);

const FRESHSERVICE_TIMEZONE_TO_IANA = new Map([
  ['Pacific Time (US & Canada)', 'America/Vancouver'],
  ['Mountain Time (US & Canada)', 'America/Edmonton'],
  ['Central Time (US & Canada)', 'America/Winnipeg'],
  ['Eastern Time (US & Canada)', 'America/Toronto'],
  ['Atlantic Time (Canada)', 'America/Halifax'],
  ['Santiago', 'America/Santiago'],
  ['Brisbane', 'Australia/Brisbane'],
  ['American Samoa', 'Pacific/Pago_Pago'],
]);

const REGION_TIMEZONE = new Map([
  ['CA-BC', 'America/Vancouver'],
  ['CA-AB', 'America/Edmonton'],
  ['CA-ON', 'America/Toronto'],
  ['CA-QC', 'America/Toronto'],
  ['CA-NB', 'America/Halifax'],
  ['CA-NS', 'America/Halifax'],
  ['US-CO', 'America/Denver'],
  ['US-TN', 'America/Chicago'],
  ['MET', 'America/Santiago'],
  ['SDO', 'America/Santo_Domingo'],
]);

const CITY_TIMEZONE = new Map([
  ['brisbane', 'Australia/Brisbane'],
  ['calgary', 'America/Edmonton'],
  ['colorado', 'America/Denver'],
  ['edmonton', 'America/Edmonton'],
  ['fredericton', 'America/Halifax'],
  ['halifax', 'America/Halifax'],
  ['kamloops', 'America/Vancouver'],
  ['kelowna', 'America/Vancouver'],
  ['kingston', 'America/Toronto'],
  ['london', 'Europe/London'],
  ['montreal', 'America/Toronto'],
  ['ottawa', 'America/Toronto'],
  ['quebec city', 'America/Toronto'],
  ['santiago', 'America/Santiago'],
  ['santo domingo', 'America/Santo_Domingo'],
  ['surrey', 'America/Vancouver'],
  ['tennessee', 'America/Chicago'],
  ['toronto', 'America/Toronto'],
  ['vancouver', 'America/Vancouver'],
  ['victoria', 'America/Vancouver'],
]);

function cleanString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function upperString(value) {
  const text = cleanString(value);
  return text ? text.toUpperCase() : null;
}

function normalizeCountryCode(country, code) {
  const explicit = upperString(code);
  if (explicit) return explicit;
  const countryKey = cleanString(country)?.toLowerCase();
  return countryKey ? COUNTRY_CODE_BY_NAME.get(countryKey) || null : null;
}

function regionLabel(region) {
  const code = upperString(region);
  return code ? REGION_LABELS.get(code) || code : null;
}

function firstLocationToken(value) {
  const text = cleanString(value);
  if (!text) return null;
  return cleanString(text.split(',')[0]?.split('-')[0]);
}

function deriveCityFromFreshServiceDepartment(department) {
  const text = cleanString(department);
  if (!text) return null;
  if (/non-bgc/i.test(text)) return null;
  if (/bgc europe/i.test(text)) return null;
  if (/lab/i.test(text)) return null;
  return firstLocationToken(text);
}

function deriveTimeZoneIana({ city, state, country, countryCode, freshserviceTimeZone }) {
  const region = upperString(state);
  if (region && REGION_TIMEZONE.has(region)) return REGION_TIMEZONE.get(region);

  const cityKey = cleanString(city)?.toLowerCase();
  if (cityKey && CITY_TIMEZONE.has(cityKey)) return CITY_TIMEZONE.get(cityKey);

  const normalizedCountryCode = normalizeCountryCode(country, countryCode);
  if (normalizedCountryCode === 'CL') return 'America/Santiago';
  if (normalizedCountryCode === 'DO') return 'America/Santo_Domingo';
  if (normalizedCountryCode === 'AU' && cityKey === 'brisbane') return 'Australia/Brisbane';
  if (normalizedCountryCode === 'GB') return 'Europe/London';

  const fsTimeZone = cleanString(freshserviceTimeZone);
  return fsTimeZone ? FRESHSERVICE_TIMEZONE_TO_IANA.get(fsTimeZone) || fsTimeZone : null;
}

function locationSummary({ officeLocation, city, stateName, country }) {
  const parts = [];
  const office = cleanString(officeLocation);
  const cityValue = cleanString(city);
  const stateValue = cleanString(stateName);
  const countryValue = cleanString(country);

  if (office) parts.push(office);
  if (cityValue && cityValue.toLowerCase() !== office?.toLowerCase()) parts.push(cityValue);
  if (stateValue && !parts.some((part) => part.toLowerCase() === stateValue.toLowerCase())) parts.push(stateValue);
  if (countryValue && !parts.some((part) => part.toLowerCase() === countryValue.toLowerCase())) parts.push(countryValue);

  return parts.join(', ') || null;
}

function hasFreshEntraProfile(requester, now = Date.now()) {
  if (!requester?.entraProfileSyncedAt) return false;
  const syncedAt = new Date(requester.entraProfileSyncedAt).getTime();
  return Number.isFinite(syncedAt) && now - syncedAt < PROFILE_TTL_MS;
}

function normalizeGraphProfile(profile) {
  if (!profile) return null;
  if (profile.success === false || profile.error) return null;
  return {
    officeLocation: cleanString(profile.officeLocation),
    city: cleanString(profile.city),
    state: cleanString(profile.state),
    country: cleanString(profile.country),
    countryCode: upperString(profile.usageLocation || profile.countryCode),
    department: cleanString(profile.department),
    jobTitle: cleanString(profile.jobTitle),
    preferredLanguage: cleanString(profile.preferredLanguage),
  };
}

async function fetchEntraProfile(email) {
  if (!email) return null;

  if (azureAdService.isConfigured()) {
    const profile = await azureAdService.getUserProfile(email);
    if (profile) return normalizeGraphProfile(profile);
  }

  if (graphMailClient.isConfigured()) {
    const profile = await graphMailClient.getUserProfile(email);
    if (profile?.success) return normalizeGraphProfile(profile);
  }

  return null;
}

async function refreshRequesterEntraProfile(requester) {
  if (!requester?.id || !requester?.email || hasFreshEntraProfile(requester)) {
    return requester;
  }

  try {
    const profile = await fetchEntraProfile(requester.email);
    const data = profile ? {
      entraOfficeLocation: profile.officeLocation,
      entraCity: profile.city,
      entraState: profile.state,
      entraCountry: profile.country,
      entraCountryCode: profile.countryCode,
      entraDepartment: profile.department,
      entraJobTitle: profile.jobTitle,
      entraPreferredLanguage: profile.preferredLanguage,
      entraProfileSyncedAt: new Date(),
    } : {
      entraProfileSyncedAt: new Date(),
    };

    return prisma.requester.update({
      where: { id: requester.id },
      data,
    });
  } catch (error) {
    logger.warn('Unable to refresh requester Entra profile', {
      requesterId: requester.id,
      email: requester.email,
      error: error.message,
    });
    return requester;
  }
}

export function requesterContextFromSource(requester, ticket = null) {
  if (!requester) return null;

  const freshserviceDepartment = cleanString(requester.department || ticket?.department);
  const officeLocation = cleanString(requester.entraOfficeLocation) || deriveCityFromFreshServiceDepartment(freshserviceDepartment);
  const city = cleanString(requester.entraCity) || deriveCityFromFreshServiceDepartment(freshserviceDepartment);
  const state = cleanString(requester.entraState);
  const stateName = regionLabel(state);
  const country = cleanString(requester.entraCountry);
  const countryCode = normalizeCountryCode(country, requester.entraCountryCode);
  const timeZone = cleanString(requester.timeZone);
  const timeZoneIana = deriveTimeZoneIana({
    city,
    state,
    country,
    countryCode,
    freshserviceTimeZone: timeZone,
  });

  const hasEntraLocation = Boolean(
    requester.entraOfficeLocation
    || requester.entraCity
    || requester.entraState
    || requester.entraCountry
    || requester.entraCountryCode,
  );

  return {
    id: requester.id || null,
    name: requester.name || null,
    email: requester.email || null,
    phone: requester.phone || null,
    mobile: requester.mobile || null,
    department: freshserviceDepartment,
    freshserviceDepartment,
    jobTitle: requester.jobTitle || requester.entraJobTitle || null,
    freshserviceJobTitle: requester.jobTitle || null,
    entraDepartment: requester.entraDepartment || null,
    entraJobTitle: requester.entraJobTitle || null,
    officeLocation,
    city,
    state,
    provinceState: state,
    stateName,
    country,
    countryCode,
    locationSummary: locationSummary({ officeLocation, city, stateName, country }),
    locationSource: hasEntraLocation ? 'entra' : (officeLocation ? 'freshservice_department' : null),
    timeZone,
    timeZoneIana,
    language: requester.entraPreferredLanguage || requester.language || null,
    freshserviceLanguage: requester.language || null,
    profileSyncedAt: requester.entraProfileSyncedAt?.toISOString?.() || requester.entraProfileSyncedAt || null,
  };
}

export async function enrichEventContextWithRequesterProfile(eventContext) {
  const requester = eventContext?.requester;
  if (!requester) return eventContext;

  if (!requester.id || !prisma.requester?.findUnique) {
    return {
      ...eventContext,
      requester: requesterContextFromSource(requester),
    };
  }

  let source = requester;
  try {
    source = await prisma.requester.findUnique({
      where: { id: requester.id },
      select: REQUESTER_PROFILE_SELECT,
    }) || requester;
  } catch (error) {
    logger.debug('Unable to load requester profile cache', {
      requesterId: requester.id,
      error: error.message,
    });
  }

  const refreshed = await refreshRequesterEntraProfile(source);
  return {
    ...eventContext,
    requester: requesterContextFromSource(refreshed),
  };
}

export default {
  REQUESTER_PROFILE_SELECT,
  enrichEventContextWithRequesterProfile,
  requesterContextFromSource,
};
