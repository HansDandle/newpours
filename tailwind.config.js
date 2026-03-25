/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        navy: '#131210',
        brand: {
          bg: '#131210',
          accent: '#c8a96c',
          text: '#f1e6d4',
          'text-on-light': '#6a4e27',
        },
        amber: {
          50: '#fff8e1',
          100: '#ffecb3',
          200: '#ffd54f',
          500: '#ffc107',
        },
      },
      fontFamily: {
        sans: ["DM Sans", "Geist", "sans-serif"],
        mono: ["Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
