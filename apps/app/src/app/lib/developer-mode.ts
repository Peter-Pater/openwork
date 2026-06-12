export const DEVELOPER_MODE_STORAGE_KEY = "openwork.developerMode";

/**
 * Whether developer mode (Debug settings tab, session diagnostics, etc.) is enabled.
 *
 * An explicit user choice persisted in localStorage always wins. When the user
 * has never toggled it, developer mode defaults on while running the Vite dev
 * server (`pnpm dev`) and off in packaged builds, so the Debug tab surfaces
 * automatically during development without affecting shipped apps.
 */
export function isDeveloperModeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const stored = window.localStorage.getItem(DEVELOPER_MODE_STORAGE_KEY);
  if (stored !== null) return stored === "1";
  return import.meta.env.DEV;
}
