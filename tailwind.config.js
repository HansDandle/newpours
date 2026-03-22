/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        navy: '#1a2233',
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
