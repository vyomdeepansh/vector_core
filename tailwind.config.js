/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class', '[data-theme="dark"]'],
  content: [
    "./static/**/*.html",
    "./static/**/*.js"
  ],
  safelist: [
    'is-good',
    'is-bad',
    'text-emerald-400',
    'text-rose-400',
    'text-slate-400',
    'bg-slate-900',
    'border-slate-800',
    'bg-slate-950',
    'border-cyan-950',
    'text-cyan-300'
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Google Sans"', 'sans-serif'],
        mono: ['"Google Sans Code"', 'monospace']
      },
      colors: {
        white: 'rgb(var(--t-white) / <alpha-value>)',
        slate: {
          50:'rgb(var(--t-s50) / <alpha-value>)',   100:'rgb(var(--t-s100) / <alpha-value>)',
          200:'rgb(var(--t-s200) / <alpha-value>)', 300:'rgb(var(--t-s300) / <alpha-value>)',
          400:'rgb(var(--t-s400) / <alpha-value>)', 500:'rgb(var(--t-s500) / <alpha-value>)',
          600:'rgb(var(--t-s600) / <alpha-value>)', 700:'rgb(var(--t-s700) / <alpha-value>)',
          800:'rgb(var(--t-s800) / <alpha-value>)', 900:'rgb(var(--t-s900) / <alpha-value>)',
          950:'rgb(var(--t-s950) / <alpha-value>)'
        },
        cyan: {
          300:'rgb(var(--t-c300) / <alpha-value>)', 400:'rgb(var(--t-c400) / <alpha-value>)',
          500:'rgb(var(--t-c500) / <alpha-value>)', 600:'rgb(var(--t-c600) / <alpha-value>)',
          700:'rgb(var(--t-c700) / <alpha-value>)', 800:'rgb(var(--t-c800) / <alpha-value>)',
          900:'rgb(var(--t-c900) / <alpha-value>)', 950:'rgb(var(--t-c950) / <alpha-value>)'
        },
        rose: {
          300:'rgb(var(--t-r300) / <alpha-value>)', 400:'rgb(var(--t-r400) / <alpha-value>)',
          500:'rgb(var(--t-r500) / <alpha-value>)', 800:'rgb(var(--t-r800) / <alpha-value>)',
          900:'rgb(var(--t-r900) / <alpha-value>)', 950:'rgb(var(--t-r950) / <alpha-value>)'
        },
        emerald: {
          300:'rgb(var(--t-e300) / <alpha-value>)', 400:'rgb(var(--t-e400) / <alpha-value>)',
          500:'rgb(var(--t-e500) / <alpha-value>)', 600:'rgb(var(--t-e600) / <alpha-value>)',
          700:'rgb(var(--t-e700) / <alpha-value>)', 800:'rgb(var(--t-e800) / <alpha-value>)',
          950:'rgb(var(--t-e950) / <alpha-value>)'
        },
        blue: {
          300:'rgb(var(--t-b300) / <alpha-value>)', 400:'rgb(var(--t-b400) / <alpha-value>)',
          500:'rgb(var(--t-b500) / <alpha-value>)', 800:'rgb(var(--t-b800) / <alpha-value>)',
          900:'rgb(var(--t-b900) / <alpha-value>)', 950:'rgb(var(--t-b950) / <alpha-value>)'
        },
        amber:  { 400:'rgb(var(--t-a400) / <alpha-value>)', 500:'rgb(var(--t-a500) / <alpha-value>)' },
        indigo: { 400:'rgb(var(--t-i400) / <alpha-value>)', 500:'rgb(var(--t-i500) / <alpha-value>)' },
        purple: { 400:'rgb(var(--t-p400) / <alpha-value>)', 500:'rgb(var(--t-p500) / <alpha-value>)' }
      }
    }
  },
  plugins: [],
}
