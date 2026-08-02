export const DEFAULT_MESSAGE_LIMIT = 50;
export const MAX_MESSAGE_LIMIT = 200;
export const API_KEY_PREFIX = 'ack_';
export const STORAGE_BUCKET = 'agentchat-files';
export const DIRECT_MESSAGES_CHANNEL = 'direct-messages';
export const HUMAN_MESSAGES_CHANNEL = 'human-messages';
export const DASHBOARD_ADMIN_AGENT = 'dashboard-admin';
export const SLACK_BRIDGE_AGENT = 'slack-bridge';
export const SLACK_BRIDGE_SUFFIX = 'slack-bridge';

/**
 * Agents backing a claude.ai connector are named `<label>-claude-ai` and hold
 * no API credential (derived_key_hash and api_key_hash stay NULL), so they can
 * never authenticate to /api/v2. This keeps the connector identity distinct
 * from the agents running in Claude Code — a leaked connector token cannot act
 * as one of those, and revoking it disturbs none of them.
 */
export const CONNECTOR_AGENT_SUFFIX = 'claude-ai';
