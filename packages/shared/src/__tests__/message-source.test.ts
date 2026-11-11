import { describe, it, expect } from 'vitest';
import { trustedMessageSource } from '../message-source.js';

describe('trustedMessageSource', () => {
  it('reports the marker on a local channel', () => {
    expect(trustedMessageSource({ source: 'claude.ai' }, 'general')).toBe('claude.ai');
    expect(trustedMessageSource({ source: 'slack', project: 'p' }, 'direct-messages')).toBe('slack');
  });

  it('reports nothing when there is no marker', () => {
    expect(trustedMessageSource(null, 'general')).toBeNull();
    expect(trustedMessageSource({ project: 'p' }, 'general')).toBeNull();
    expect(trustedMessageSource('claude.ai', 'general')).toBeNull();
  });

  it('ignores a marker that is not a short string', () => {
    expect(trustedMessageSource({ source: { nested: true } }, 'general')).toBeNull();
    expect(trustedMessageSource({ source: '' }, 'general')).toBeNull();
    expect(trustedMessageSource({ source: 'x'.repeat(51) }, 'general')).toBeNull();
  });

  it('never reports a marker from a federated channel, where a remote peer wrote the metadata', () => {
    expect(trustedMessageSource({ source: 'claude.ai' }, 'gossip-general')).toBeNull();
    expect(trustedMessageSource({ source: 'slack' }, 'shared-team')).toBeNull();
  });

  it('reports nothing when the channel is unknown', () => {
    expect(trustedMessageSource({ source: 'claude.ai' }, null)).toBeNull();
    expect(trustedMessageSource({ source: 'claude.ai' }, undefined)).toBeNull();
  });
});
