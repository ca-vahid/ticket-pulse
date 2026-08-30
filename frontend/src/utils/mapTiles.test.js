import { describe, expect, test } from 'vitest';
import { DARK_TILE_LAYER, LIGHT_TILE_LAYER, tileLayerFor } from './mapTiles';

/**
 * Phase DM-B (DM9) — dark basemap for the Visuals agent map. The page keys
 * its <TileLayer> on `tiles.url`, so the url/attribution contract here is
 * what actually swaps the map on a theme change. Dark is Esri's World Dark
 * Gray Canvas (base + reference labels): the plan's first choice, CARTO
 * dark_matter, now watermarks keyless requests ("API KEY REQUIRED",
 * verified 2026-08-30), so it must NOT come back without a key.
 */
describe('tileLayerFor', () => {
  test('dark resolves to the keyless Esri Dark Gray Canvas with a labels overlay', () => {
    const tiles = tileLayerFor('dark');
    expect(tiles).toBe(DARK_TILE_LAYER);
    expect(tiles.url).toBe('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}');
    expect(tiles.referenceUrl).toBe('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}');
    expect(tiles.attribution).toContain('Esri');
    expect(tiles.url).not.toContain('cartocdn'); // watermarked without an API key
    expect(tiles.subdomains).toBeUndefined();
    expect(tiles.maxZoom).toBe(16); // Esri Canvas stops ~z16
  });

  test('light resolves to the standard OSM raster', () => {
    const tiles = tileLayerFor('light');
    expect(tiles).toBe(LIGHT_TILE_LAYER);
    expect(tiles.url).toBe('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(tiles.attribution).toContain('OpenStreetMap</a> contributors');
    expect(tiles.referenceUrl).toBeUndefined();
    expect(tiles.subdomains).toBe('abc');
    expect(tiles.maxZoom).toBe(19);
  });

  test('anything that is not "dark" stays on the light map', () => {
    expect(tileLayerFor(undefined)).toBe(LIGHT_TILE_LAYER);
    expect(tileLayerFor('system')).toBe(LIGHT_TILE_LAYER);
  });
});
