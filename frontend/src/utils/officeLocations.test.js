import { describe, expect, test } from 'vitest';
import {
  MAP_DEFAULT_VIEW, OFFICE_LOCATIONS, PRESET_LOCATIONS, formatLatLng, parseLatLng, resolveLocation,
} from './officeLocations';
// The backend resolves the same table for the PATCH response (QA 08-24 #1).
// Import the mirror straight from the backend tree so drift fails here.
import * as backend from '../../../backend/src/config/officeLocations.js';

describe('officeLocations — resolveLocation matrix (QA 08-24 #1)', () => {
  test('exact key', () => {
    expect(resolveLocation('Vancouver')).toMatchObject({ lat: 49.2827, lng: -123.1207, key: 'Vancouver', kind: 'city' });
  });

  test('case-insensitive + trimmed + collapsed whitespace', () => {
    expect(resolveLocation('  vancouver ')).toMatchObject({ key: 'Vancouver' });
    expect(resolveLocation('SALT  LAKE   CITY')).toMatchObject({ key: 'Salt Lake City' });
    expect(resolveLocation('st. john’s')).toMatchObject({ key: 'St. John\'s' });
  });

  test('strips a ", Country" / ", Province, Country" suffix', () => {
    expect(resolveLocation('Santiago, Chile')).toMatchObject({ key: 'Santiago', lat: -33.4489, lng: -70.6693 });
    expect(resolveLocation('Calgary, AB, Canada')).toMatchObject({ key: 'Calgary' });
    expect(resolveLocation('Golden, CO')).toMatchObject({ key: 'Golden' });
  });

  test('"lat,lng" text resolves as exact coordinates (comma, comma+space, or space)', () => {
    expect(resolveLocation('-33.4489,-70.6693')).toMatchObject({ lat: -33.4489, lng: -70.6693, kind: 'coords', key: '-33.4489,-70.6693' });
    expect(resolveLocation('49.28, -123.12')).toMatchObject({ lat: 49.28, lng: -123.12, kind: 'coords' });
    expect(resolveLocation('49.28 -123.12')).toMatchObject({ kind: 'coords' });
  });

  test('miss → null (never a fallback pin): unknown city, empty, null, out-of-range coords', () => {
    expect(resolveLocation('Atlantis')).toBeNull();
    expect(resolveLocation('Default')).toBeNull();
    expect(resolveLocation('')).toBeNull();
    expect(resolveLocation('   ')).toBeNull();
    expect(resolveLocation(null)).toBeNull();
    expect(resolveLocation(undefined)).toBeNull();
    expect(resolveLocation('95,10')).toBeNull();
    expect(resolveLocation('10,181')).toBeNull();
  });

  test('the viewport centroid is not a location key', () => {
    expect(OFFICE_LOCATIONS.Default).toBeUndefined();
    expect(MAP_DEFAULT_VIEW).toEqual({ lat: 54.5, lng: -105.0, zoom: 4 });
    // No city in the table sits on the old fake pin.
    for (const [key, loc] of Object.entries(OFFICE_LOCATIONS)) {
      expect(`${key}:${loc.lat},${loc.lng}`).not.toBe(`${key}:54.5,-105`);
    }
  });

  test('parseLatLng / formatLatLng round-trip with ≤ 6 decimals', () => {
    expect(parseLatLng('-33.44890001,-70.6693')).toEqual({ lat: -33.44890001, lng: -70.6693 });
    expect(formatLatLng({ lat: -33.44890001, lng: -70.6693 })).toBe('-33.4489,-70.6693');
    expect(parseLatLng('Vancouver')).toBeNull();
    expect(parseLatLng(42)).toBeNull();
  });

  test('Santiago and the non-Canadian offices exist and every preset resolves', () => {
    expect(OFFICE_LOCATIONS.Santiago).toEqual({ lat: -33.4489, lng: -70.6693, zoom: 10 });
    for (const name of ['Lima', 'Denver', 'Golden', 'Anchorage', 'Seattle', 'Brisbane', 'Perth']) {
      expect(OFFICE_LOCATIONS[name], name).toBeTruthy();
    }
    for (const preset of PRESET_LOCATIONS) {
      expect(resolveLocation(preset)?.key, preset).toBe(preset);
    }
    expect(new Set(PRESET_LOCATIONS).size).toBe(PRESET_LOCATIONS.length);
  });
});

describe('officeLocations — frontend/backend mirrors stay in sync', () => {
  test('tables and helpers are identical', () => {
    expect(backend.OFFICE_LOCATIONS).toEqual(OFFICE_LOCATIONS);
    expect(backend.PRESET_LOCATIONS).toEqual(PRESET_LOCATIONS);
    expect(backend.MAP_DEFAULT_VIEW).toEqual(MAP_DEFAULT_VIEW);
    for (const value of ['Santiago, Chile', 'vancouver', '-33.4489,-70.6693', 'Atlantis', '', null]) {
      expect(backend.resolveLocation(value), String(value)).toEqual(resolveLocation(value));
    }
    expect(backend.UNRESOLVED_LOCATION_HINT).toBeTruthy();
  });
});
