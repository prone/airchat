// Pure helpers for the setup wizard, kept apart from index.ts so they can be
// tested without starting it.

/** True for a postgres:// or postgresql:// URL. */
export function isPostgresUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'postgres:' || protocol === 'postgresql:';
  } catch {
    return false;
  }
}

/** The project ref from https://<ref>.supabase.co, or null for any other URL. */
export function supabaseProjectRef(url: string | undefined): string | null {
  try {
    const m = /^([a-z0-9]+)\.supabase\.co$/.exec(new URL(url ?? '').hostname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Set `entries` in the text of an env file, keeping every other line as it is.
 * A key already present has its value replaced where it stands; a new key is
 * added at the end.
 */
export function mergeEnv(existing: string, entries: Record<string, string>): string {
  const pending = new Map(Object.entries(entries));
  const lines = existing.split('\n').map((line) => {
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key === undefined || !pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${value}`;
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  return lines.join('\n') + '\n';
}

/**
 * The lines of an existing ~/.airchat/config that setup does not write
 * itself, so re-running setup keeps settings it knows nothing about (wake
 * settings, anything added by hand) and its comments. Blank lines are dropped.
 */
export function unmanagedConfigLines(existing: string, managedKeys: readonly string[]): string[] {
  return existing.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('#')) return true;
    const eq = trimmed.indexOf('=');
    return eq > 0 && !managedKeys.includes(trimmed.slice(0, eq).trim());
  });
}

/** Agent names from a comma-separated answer; invalid ones are left out. */
export function parseAgentList(answer: string): string[] {
  const names = answer.split(',').map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9][a-z0-9-]{0,99}$/.test(s));
  return [...new Set(names)];
}
