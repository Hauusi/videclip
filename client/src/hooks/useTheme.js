import { useEffect } from 'react';
import { useLocalStorage } from './useLocalStorage';

export function useTheme() {
  const [theme, setTheme] = useLocalStorage('peakclip-theme', 'dark');

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme === 'light' ? 'light' : 'dark';
    root.classList.toggle('dark', theme !== 'light');
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'));

  return { theme, setTheme, toggleTheme, isLight: theme === 'light' };
}
