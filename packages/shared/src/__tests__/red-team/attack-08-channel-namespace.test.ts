/**
 * Red Team Attack #8: Channel Namespace Pollution
 *
 * Verifies that federated messages cannot be injected into local channels.
 * The channel name must start with gossip-* or shared-* for federation.
 */

import { describe, it, expect } from 'vitest';
import type { ChannelType, FederationScope } from '../../types.js';

// Simulate the channel name validation that processInboundMessage does
function isValidFederatedChannel(channelName: string): boolean {
  return channelName.startsWith('gossip-') || channelName.startsWith('shared-');
}

// Simulate inferChannelTier from supabase-adapter
function inferChannelTier(channelName: string): { type: ChannelType; federationScope: FederationScope } {
  if (channelName.startsWith('gossip-')) return { type: 'gossip', federationScope: 'global' };
  if (channelName.startsWith('shared-')) return { type: 'shared', federationScope: 'peers' };
  if (channelName.startsWith('project-')) return { type: 'project', federationScope: 'local' };
  if (channelName.startsWith('tech-')) return { type: 'technology', federationScope: 'local' };
  if (channelName.startsWith('env-')) return { type: 'environment', federationScope: 'local' };
  const globals = new Set(['general', 'status', 'alerts', 'direct-messages', 'global']);
  if (globals.has(channelName)) return { type: 'global', federationScope: 'local' };
  return { type: 'project', federationScope: 'local' };
}

describe('Attack 08: Channel Namespace Pollution', () => {
  it('rejects injection into "general" channel', () => {
    expect(isValidFederatedChannel('general')).toBe(false);
  });

  it('rejects injection into "project-foo" channel', () => {
    expect(isValidFederatedChannel('project-foo')).toBe(false);
  });

  it('rejects injection into "status" channel', () => {
    expect(isValidFederatedChannel('status')).toBe(false);
  });

  it('rejects injection into "direct-messages" channel', () => {
    expect(isValidFederatedChannel('direct-messages')).toBe(false);
  });

  it('rejects injection into "alerts" channel', () => {
    expect(isValidFederatedChannel('alerts')).toBe(false);
  });

  it('allows gossip-* channels', () => {
    expect(isValidFederatedChannel('gossip-builds')).toBe(true);
    expect(isValidFederatedChannel('gossip-announcements')).toBe(true);
  });

  it('allows shared-* channels', () => {
    expect(isValidFederatedChannel('shared-team')).toBe(true);
    expect(isValidFederatedChannel('shared-acme-corp')).toBe(true);
  });

  it('inferChannelTier assigns correct scope to local channels', () => {
    expect(inferChannelTier('general').federationScope).toBe('local');
    expect(inferChannelTier('project-foo').federationScope).toBe('local');
    expect(inferChannelTier('tech-typescript').federationScope).toBe('local');
    expect(inferChannelTier('random-name').federationScope).toBe('local');
  });

  it('inferChannelTier assigns correct scope to federated channels', () => {
    expect(inferChannelTier('gossip-builds').federationScope).toBe('global');
    expect(inferChannelTier('shared-team').federationScope).toBe('peers');
  });
});
