/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      screens: {
        xs: '400px',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      fontSize: {
        '2xs': ['0.75rem', { lineHeight: '1.125rem', letterSpacing: '0.01em' }],
        xs: ['0.8125rem', { lineHeight: '1.25rem' }],
        sm: ['0.9375rem', { lineHeight: '1.375rem' }],
        base: ['1rem', { lineHeight: '1.5rem' }],
        lg: ['1.125rem', { lineHeight: '1.65rem' }],
        xl: ['1.25rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.5rem', { lineHeight: '2rem' }],
        '3xl': ['1.875rem', { lineHeight: '2.25rem' }],
      },
      colors: {
        surface: {
          DEFAULT: '#090a0f',
          card: '#12141c',
          elevated: '#191b26',
          hover: '#1f2230',
        },
        peak: {
          purple: '#9490ff',
          violet: '#6b66d9',
          pink: '#deb8ff',
          muted: '#9395a8',
        },
      },
      boxShadow: {
        glow: '0 0 40px rgba(148, 144, 255, 0.14)',
        'glow-lg': '0 0 80px rgba(148, 144, 255, 0.2)',
        card: '0 4px 24px rgba(0,0,0,0.5)',
        'card-hover': '0 12px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(148,144,255,0.18)',
      },
      backgroundImage: {
        'peak-gradient': 'linear-gradient(135deg, #9490ff 0%, #7a75e8 48%, #6b66d9 100%)',
        'peak-mesh':
          'radial-gradient(ellipse 120% 70% at 50% 105%, rgba(107,102,217,0.055), transparent 58%), radial-gradient(ellipse 48% 85% at 0% 55%, rgba(148,144,255,0.045), transparent 58%), radial-gradient(ellipse 48% 85% at 100% 55%, rgba(222,184,255,0.035), transparent 58%), radial-gradient(ellipse 90% 55% at 50% -15%, rgba(148,144,255,0.06), transparent)',
      },
      animation: {
        'fade-in': 'fadeIn 0.4s ease-out',
        'fade-in-up': 'fadeInUp 0.5s ease-out',
        'pulse-soft': 'pulseSoft 2s ease-in-out infinite',
        shimmer: 'shimmer 2s linear infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(16px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
};
