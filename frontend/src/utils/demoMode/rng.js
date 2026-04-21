// Mulberry32: tiny seedable PRNG. Same seed => same sequence.
// Used by demo mode so that within one recording session every real
// person/location/computer maps to the same fake counterpart.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a 32-bit string hash. Stable across runs / browsers.
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Combine a session seed + a real value into a deterministic per-session index.
export function pickIndex(seed, value, modulo) {
  if (!modulo || modulo <= 0) return 0;
  const mixed = (hashString(value) ^ (seed >>> 0)) >>> 0;
  return mixed % modulo;
}
