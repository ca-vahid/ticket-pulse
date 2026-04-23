import { useEffect, useRef } from 'react';

/**
 * Two-way sync between a flat object of filter state and `window.location.search`.
 *
 * Schema example:
 *   {
 *     search:       { type: 'string', default: '' },
 *     source:       { type: 'string', default: 'all' },
 *     decisions:    { type: 'csv',    default: [] },         // string array, joined with ','
 *     priorities:   { type: 'csvInt', default: [] },         // number array, joined with ','
 *     bounceOnly:   { type: 'bool',   default: false },
 *   }
 *
 * Behavior:
 * - On mount, hydrate state from `window.location.search` by calling each `setter`
 *   with the parsed value (only for keys actually present in the URL).
 * - On every state change, serialize back to the URL with `history.replaceState`
 *   (no navigation), omitting keys at their default values.
 * - Keeps URLs short and shareable: `?source=via_pipeline&decisions=approved,modified`
 *
 * @param {object} state    Current filter state object
 * @param {object} setters  Map of { key: setterFn } matching state keys
 * @param {object} schema   Map of { key: { type, default } }
 * @param {boolean} [enabled=true] Set false to disable URL sync (e.g. while loading)
 */
export default function useFilterUrlSync(state, setters, schema, enabled = true) {
  const hasHydratedRef = useRef(false);

  // One-time hydration from URL params on mount.
  useEffect(() => {
    if (!enabled || hasHydratedRef.current) return;
    hasHydratedRef.current = true;

    const params = new URLSearchParams(window.location.search);
    for (const [key, def] of Object.entries(schema)) {
      const raw = params.get(key);
      if (raw == null) continue;
      const parsed = decode(raw, def.type);
      if (parsed != null && setters[key]) {
        setters[key](parsed);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Serialize state back to URL whenever it changes.
  useEffect(() => {
    if (!enabled || !hasHydratedRef.current) return;

    const params = new URLSearchParams(window.location.search);

    for (const [key, def] of Object.entries(schema)) {
      const value = state[key];
      const isDefault = isAtDefault(value, def.default, def.type);
      if (isDefault) {
        params.delete(key);
      } else {
        const encoded = encode(value, def.type);
        if (encoded == null || encoded === '') params.delete(key);
        else params.set(key, encoded);
      }
    }

    const next = params.toString();
    const newUrl = `${window.location.pathname}${next ? `?${next}` : ''}${window.location.hash}`;
    if (newUrl !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(null, '', newUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...Object.keys(schema).map((k) => state[k])]);
}

function decode(raw, type) {
  switch (type) {
  case 'string':
    return raw;
  case 'bool':
    return raw === 'true' || raw === '1';
  case 'int': {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }
  case 'csv':
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  case 'csvInt':
    return raw
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
  default:
    return raw;
  }
}

function encode(value, type) {
  if (value == null) return null;
  switch (type) {
  case 'string':
    return String(value);
  case 'bool':
    return value ? 'true' : null;
  case 'int':
    return String(value);
  case 'csv':
  case 'csvInt':
    return Array.isArray(value) && value.length > 0 ? value.join(',') : null;
  default:
    return String(value);
  }
}

function isAtDefault(value, defaultValue, type) {
  if (type === 'csv' || type === 'csvInt') {
    if (!Array.isArray(value)) return true;
    if (value.length === 0 && (!defaultValue || defaultValue.length === 0)) return true;
    if (Array.isArray(defaultValue) && value.length === defaultValue.length) {
      const a = [...value].map(String).sort();
      const b = [...defaultValue].map(String).sort();
      return a.every((x, i) => x === b[i]);
    }
    return false;
  }
  return value === defaultValue;
}
