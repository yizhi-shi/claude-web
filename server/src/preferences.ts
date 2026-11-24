import path from 'node:path';
import { config } from './config.js';
import { atomicWriteJson, HttpError, readJson } from './util.js';

export type ThemePreference = 'system' | 'dark' | 'light';

const THEMES: ThemePreference[] = ['system', 'dark', 'light'];

interface PreferencesFile {
  version: 1;
  theme: ThemePreference;
}

const file = () => path.join(config.dataDir, 'preferences.json');
let cache: PreferencesFile | null = null;

function envTheme(): ThemePreference {
  const raw = process.env.DEFAULT_THEME || 'system';
  return (THEMES as string[]).includes(raw) ? (raw as ThemePreference) : 'system';
}

function load(): PreferencesFile {
  if (cache) return cache;
  const parsed = readJson<PreferencesFile | null>(file(), null);
  const theme =
    parsed && (THEMES as string[]).includes(parsed.theme) ? parsed.theme : envTheme();
  cache = { version: 1, theme };
  return cache;
}

export function getThemePreference(): ThemePreference {
  return load().theme;
}

export function setThemePreference(input: unknown): ThemePreference {
  if (typeof input !== 'string' || !(THEMES as string[]).includes(input)) {
    throw new HttpError(400, '外观只能是 system / dark / light');
  }
  const next: PreferencesFile = { version: 1, theme: input as ThemePreference };
  cache = next;
  atomicWriteJson(file(), next);
  return next.theme;
}
