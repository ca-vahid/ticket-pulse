/**
 * Leaflet basemap per theme (Phase DM-B, DM9).
 *
 * The OSM standard raster is a daylight map — under `.dark` it glares against
 * the slate ground, so dark mode swaps to a night basemap. The plan's first
 * choice (CARTO dark_matter) now serves an "API KEY REQUIRED" watermark on
 * keyless requests (verified 2026-08-30), so dark uses Esri's World Dark Gray
 * Canvas instead — keyless, watermark-free night cartography — with the
 * matching Reference overlay for place labels (the Base layer is unlabeled).
 * Pure lookup so the page (and the test) can key the `<TileLayer>` on the
 * url — react-leaflet layer props are mostly immutable after mount, so a key
 * change is what actually remounts the layer.
 */

export const LIGHT_TILE_LAYER = Object.freeze({
  url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  subdomains: 'abc',
  // Esri Canvas tiles top out around zoom 16; OSM serves to 19.
  maxZoom: 19,
});

export const DARK_TILE_LAYER = Object.freeze({
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  // Place labels live in a separate reference layer stacked on the base.
  referenceUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
  subdomains: undefined,
  maxZoom: 16,
});

export function tileLayerFor(resolvedTheme) {
  return resolvedTheme === 'dark' ? DARK_TILE_LAYER : LIGHT_TILE_LAYER;
}
