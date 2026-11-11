/**
 * Shared validation patterns for the API routes (agent names, channel names,
 * UUIDs). The file keeps its original name; /api/v1 is retired and the
 * importers are the /api/v2 routes.
 */

export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,99}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const CHANNEL_NAME_RE = AGENT_NAME_RE; // Same format
