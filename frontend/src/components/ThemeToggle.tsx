import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

const KEY = 'leadtrace-theme';

/** Read the saved theme (defaults to dark). Exported so main.tsx can apply it
 *  before first paint to avoid a flash. */
export function initTheme(): Theme {
  const saved = (localStorage.getItem(KEY) as Theme | null) ?? 'dark';
  document.documentElement.dataset.theme = saved;
  return saved;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme as Theme) || 'dark');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(KEY, theme);
  }, [theme]);

  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      className="ghost sm"
      onClick={() => setTheme(next)}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
    >
      {theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
    </button>
  );
}
