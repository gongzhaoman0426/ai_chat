// Appearance is a per-device preference, so it lives in renderer storage rather than the
// workspace database. `system` leaves the choice to prefers-color-scheme.
export type ThemeChoice = 'system' | 'light' | 'dark';
const key = 'judesk-theme';

export function readTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(key);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice = readTheme()) {
  if (choice === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
}

export function saveTheme(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(key);
    else localStorage.setItem(key, choice);
  } catch {
    // Storage can be unavailable; the choice still applies to this session.
  }
  applyTheme(choice);
}
