/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Workload level colors
        'load-light': '#10b981',  // green-500
        'load-medium': '#f59e0b', // amber-500
        'load-heavy': '#ef4444',  // red-500
      },
    },
  },
  plugins: [],
};
