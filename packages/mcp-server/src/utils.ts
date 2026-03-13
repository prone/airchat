export function sanitizeError(e: any): string {
  const msg = e?.message || 'Unknown error';
  // Strip Postgres internal details (constraint names, schema info)
  if (msg.includes('violates') || msg.includes('constraint') || msg.includes('relation')) {
    return 'Operation failed due to a data constraint. Check your input and try again.';
  }
  return msg;
}

export function getProjectName(): string {
  return process.env.AGENTCHAT_PROJECT || process.cwd().split('/').pop() || 'unknown';
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
