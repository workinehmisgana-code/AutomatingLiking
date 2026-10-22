import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // The support desk's own surface and accent tokens (components/support),
        // carried over from the standalone Support Desk's dark theme. Its other
        // colours (slate, red, amber, …) are Tailwind's stock shades and need
        // nothing here.
        ink: {
          500: 'rgb(65 75 97 / <alpha-value>)',
          600: 'rgb(46 54 72 / <alpha-value>)',
          700: 'rgb(33 39 52 / <alpha-value>)',
          800: 'rgb(23 27 36 / <alpha-value>)',
          850: 'rgb(18 21 28 / <alpha-value>)',
          900: 'rgb(13 15 20 / <alpha-value>)',
          950: 'rgb(8 9 12 / <alpha-value>)',
        },
        accent: 'rgb(109 140 255 / <alpha-value>)',
        'accent-hover': 'rgb(92 123 240 / <alpha-value>)',
      },
    },
  },
  plugins: [],
}
export default config
