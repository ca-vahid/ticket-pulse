import animate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
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
    },
  },
  plugins: [animate],
};
