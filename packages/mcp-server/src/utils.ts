export function sanitizeError(e: any): string {
  const msg = e?.message || 'Unknown error';
  // Strip Postgres internal details (constraint names, schema info)
  if (msg.includes('violates') || msg.includes('constraint') || msg.includes('relation')) {
    return 'Operation failed due to a data constraint. Check your input and try again.';
  }
  return msg;
}

export function getProjectName(): string {
  return process.env.AIRCHAT_PROJECT || process.cwd().split('/').pop() || 'unknown';
}

export function deriveAgentName(machineName: string): string {
  const project = getProjectName();
  // Sanitize: lowercase, replace non-alphanumeric with hyphens, collapse multiples
  const sanitized = `${machineName}-${project}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
  return sanitized || machineName;
}

/**
 * True when this server will name its agent after the AirChat install folder
 * rather than after the project the session is working in.
 *
 * The agent name is `<machine>-<folder the server was started in>`. A harness
 * starts MCP servers in the session's project folder, so each project gets its
 * own agent. A launch command that first changes into the AirChat folder
 * (`bash -c "cd <airchat> && node …"`) defeats that: every session on the
 * machine becomes `<machine>-<airchat folder>`, they all share one identity,
 * and a message addressed to a particular project's agent reaches whichever
 * session reads it first — while the prompt hook, which runs in the real
 * project folder, watches for mentions of a name nobody posts as.
 *
 * Setting AIRCHAT_PROJECT is an explicit choice and is never flagged.
 */
export function namedAfterInstallDir(
  cwd: string,
  installDir: string,
  explicitProject: string | undefined,
): boolean {
  if (explicitProject) return false;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  return norm(cwd) === norm(installDir);
}
