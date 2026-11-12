import { describe, it, expect } from 'vitest';
import { identityFields } from './peer.js';

/**
 * `airchat peer add` asks the other instance who it is. The answer is wrapped
 * (`{ data: { fingerprint, ... } }`); reading the top level gave no
 * fingerprint, and the peer was added without one.
 */
const FP = '0123456789abcdef';

describe('identityFields', () => {
  it('reads the wrapped answer the server gives', () => {
    expect(identityFields({ _airchat: 'response', data: { fingerprint: FP, display_name: 'NAS', public_key: 'k' } }))
      .toEqual({ fingerprint: FP, displayName: 'NAS' });
  });

  it('reads an unwrapped answer from an older server', () => {
    expect(identityFields({ fingerprint: FP })).toEqual({ fingerprint: FP });
  });

  it.each([
    ['no fingerprint', { data: { display_name: 'NAS' } }],
    ['a fingerprint of the wrong shape', { data: { fingerprint: 'not-a-fingerprint' } }],
    ['a fingerprint that is not text', { data: { fingerprint: 42 } }],
    ['an error body', { error: 'Gossip is not enabled' }],
    ['nothing', null],
  ])('refuses %s', (_what, json) => {
    expect(identityFields(json)).toBeNull();
  });
});
