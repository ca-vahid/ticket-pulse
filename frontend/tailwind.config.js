import animate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
  // Class-driven theming (Phase DM-A): ThemeContext stamps `.dark` on <html>;
  // the index.html pre-paint script does the same before first paint.
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
          foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)',
        },
        card: {
          DEFAULT: 'hsl(var(--card) / <alpha-value>)',
          foreground: 'hsl(var(--card-foreground) / <alpha-value>)',
        },
        // Workload level colors
        'load-light': '#10b981',  // green-500
        'load-medium': '#f59e0b', // amber-500
        'load-heavy': '#ef4444',  // red-500
      },
      borderRadius: {
        xl: 'var(--radius-xl)',
        lg: 'var(--radius-lg)',
        md: 'var(--radius-md)',
      },
      boxShadow: {
        subtle: '0 1px 2px rgb(15 23 42 / 0.06), 0 1px 1px rgb(15 23 42 / 0.04)',
        soft: '0 18px 45px rgb(15 23 42 / 0.10), 0 6px 18px rgb(15 23 42 / 0.06)',
      },
      // The house easing for rails, panels and menus (16 Sep 2026). The
      // arbitrary form ease-[cubic-bezier(0.22,1,0.36,1)] never made it into
      // the build (commas inside the brackets), so it lives here as ease-soft.
      transitionTimingFunction: {
        soft: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [
    animate,
    // Motion is an APP preference, not only an OS flag (16 Sep 2026): the
    // `motion-off:` variant keys off <html data-motion="reduce"> — stamped
    // by utils/motionPreference.js from the user's choice (On by default,
    // System, Off) — instead of prefers-reduced-motion directly.
    ({ addVariant }) => {
      // Tailwind's own motion-reduce:/motion-safe: cannot be overridden (the
      // core variant plugins register last), so the app uses its own names.
      addVariant('motion-off', 'html[data-motion="reduce"] &');
      addVariant('motion-on', 'html:not([data-motion="reduce"]) &');
    },
  ],
};
