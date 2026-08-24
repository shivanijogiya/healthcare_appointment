/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper:  '#F2F0EB',
        card:   '#FFFFFF',
        ink:    '#14181F',
        muted:  '#6C6A66',
        line:   '#DEDAD1',
        teal:   { DEFAULT: '#0F5F5C', soft: '#E3EFEE' },
        amber:  { DEFAULT: '#A8641B', soft: '#F7EBDC' },
        crimson:{ DEFAULT: '#A32A25', soft: '#F7E2E1' },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
