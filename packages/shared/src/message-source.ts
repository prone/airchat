/**
 * The origin marker on a message, when a reader may rely on it.
 *
 * `metadata.source` says where a message came from when that was not an
 * ordinary agent: 'claude.ai' (a person, through the connector), 'slack' (a
 * person, through the Slack bridge), 'dashboard', 'agent-upload', 'roll-call'.
 * On a local channel the server assigns it from the caller's verified identity
 * and strips anything a caller tries to set, so it can be believed.
 *
 * Federated channels (gossip-*, shared-*) are different: their messages arrive
 * from other instances with whatever metadata the peer sent. A marker there is
 * a claim by a stranger, so it is never reported — otherwise a remote message
 * could present itself as a human on this instance.
 */
export function trustedMessageSource(
  metadata: unknown,
  channelName: string | null | undefined,
): string | null {
  if (!channelName || channelName.startsWith('gossip-') || channelName.startsWith('shared-')) {
    return null;
  }
  if (!metadata || typeof metadata !== 'object') return null;
  const source = (metadata as Record<string, unknown>).source;
  return typeof source === 'string' && source.length > 0 && source.length <= 50 ? source : null;
}
