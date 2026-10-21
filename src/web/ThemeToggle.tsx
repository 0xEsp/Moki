import { useEffect, useState } from 'react';
import { cycleThemePref, getThemePref, onThemeChange, type ThemePref } from './theme';

const LABEL: Record<ThemePref, { icon: string; title: string }> = {
  system: { icon: '◐', title: 'Tema: sistema (clic para claro)' },
  light: { icon: '☀', title: 'Tema: claro (clic para oscuro)' },
  dark: { icon: '☾', title: 'Tema: oscuro (clic para sistema)' },
};

export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  useEffect(() => onThemeChange(() => setPref(getThemePref())), []);
  return (
    <button className="icon-btn theme-toggle" title={LABEL[pref].title} onClick={() => setPref(cycleThemePref())}>
      {LABEL[pref].icon}
    </button>
  );
}
