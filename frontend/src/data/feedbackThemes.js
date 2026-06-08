// Feedback page visual themes. Each "image" theme renders a generated 5-image
// rating spectrum (Bad -> Great) plus a themed background; the "classic" theme
// renders the original animated morphing-face SVG. Assets live under
// frontend/public/feedback-themes/<key>/ (1.png..5.png + bg.jpg).

const BASE = '/feedback-themes';

function tiles(key) {
  return [1, 2, 3, 4, 5].map((i) => `${BASE}/${key}/${i}.png`);
}

export const FEEDBACK_THEMES = {
  classic: {
    key: 'classic',
    label: 'Classic (animated)',
    tagline: 'Original morphing face',
    accent: '#2563eb',
    kind: 'svg',
    bg: null,
    tiles: null,
  },
  earth: {
    key: 'earth',
    label: 'Earth Sciences',
    tagline: 'Geological / field',
    accent: '#a16207',
    kind: 'image',
    bg: `${BASE}/earth/bg.jpg`,
    tiles: tiles('earth'),
  },
  clay: {
    key: 'clay',
    label: 'Clay 3D',
    tagline: 'Playful 3D',
    accent: '#2563eb',
    kind: 'image',
    bg: `${BASE}/clay/bg.jpg`,
    tiles: tiles('clay'),
  },
  geo: {
    key: 'geo',
    label: 'Geometric',
    tagline: 'Topographic / engineering',
    accent: '#0f766e',
    kind: 'image',
    bg: `${BASE}/geo/bg.jpg`,
    tiles: tiles('geo'),
  },
  it: {
    key: 'it',
    label: 'IT',
    tagline: 'Field IT support',
    accent: '#0ea5e9',
    kind: 'image',
    bg: `${BASE}/it/bg.jpg`,
    tiles: tiles('it'),
  },
  acct: {
    key: 'acct',
    label: 'Accounting',
    tagline: 'Timesheets / accounts payable',
    accent: '#15803d',
    kind: 'image',
    bg: `${BASE}/acct/bg.jpg`,
    tiles: tiles('acct'),
  },
  hse: {
    key: 'hse',
    label: 'Health & Safety',
    tagline: 'Safety on site',
    accent: '#ea580c',
    kind: 'image',
    bg: `${BASE}/hse/bg.jpg`,
    tiles: tiles('hse'),
  },
};

// Order shown in the Settings picker. Earth Sciences first (default).
export const FEEDBACK_THEME_ORDER = ['earth', 'clay', 'geo', 'it', 'acct', 'hse', 'classic'];
export const FEEDBACK_THEME_LIST = FEEDBACK_THEME_ORDER.map((k) => FEEDBACK_THEMES[k]);
export const FEEDBACK_THEME_KEYS = FEEDBACK_THEME_ORDER;
export const DEFAULT_FEEDBACK_THEME = 'earth';

export function getFeedbackTheme(key) {
  return FEEDBACK_THEMES[key] || FEEDBACK_THEMES[DEFAULT_FEEDBACK_THEME];
}
