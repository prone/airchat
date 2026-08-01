import { describe, expect, it } from 'vitest';
import { extractWikiLinks, slugifyNoteTarget } from '../notes.js';

describe('slugifyNoteTarget', () => {
  it('normalizes titles to slugs', () => {
    expect(slugifyNoteTarget('Deploy Runbook')).toBe('deploy-runbook');
    expect(slugifyNoteTarget('  API_Design v2  ')).toBe('api-design-v2');
    expect(slugifyNoteTarget('already-a-slug')).toBe('already-a-slug');
  });

  it('rejects targets with nothing slug-like', () => {
    expect(slugifyNoteTarget('')).toBeNull();
    expect(slugifyNoteTarget('---')).toBeNull();
    expect(slugifyNoteTarget('!!!')).toBeNull();
  });

  it('trims leading/trailing hyphens and collapses runs', () => {
    expect(slugifyNoteTarget('-foo--bar-')).toBe('foo-bar');
  });

  // Targets arrive in federated content, so their length is attacker
  // controlled. The input is capped before any regex runs.
  it('bounds work on hostile input', () => {
    const hostile = '-'.repeat(500_000) + 'x';
    const started = process.hrtime.bigint();
    const result = slugifyNoteTarget(hostile);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(elapsedMs).toBeLessThan(50);
    // Everything inside the cap is hyphens, which trim away to nothing.
    expect(result).toBeNull();
  });

  it('still slugifies a long-but-legitimate title', () => {
    const title = 'A'.repeat(300);
    expect(slugifyNoteTarget(title)).toBe('a'.repeat(200));
  });
});

describe('extractWikiLinks', () => {
  it('returns empty for text without links', () => {
    expect(extractWikiLinks('no links here')).toEqual([]);
    expect(extractWikiLinks('a [single] bracket [pair](url)')).toEqual([]);
  });

  it('extracts unqualified links as channel-scoped (channel: null, global: false)', () => {
    const links = extractWikiLinks('see [[deploy-runbook]] for details');
    expect(links).toEqual([
      { channel: null, global: false, slug: 'deploy-runbook', raw: 'deploy-runbook' },
    ]);
  });

  it('extracts explicit channel scope', () => {
    const links = extractWikiLinks('see [[project-airchat/deploy-runbook]]');
    expect(links).toHaveLength(1);
    expect(links[0].channel).toBe('project-airchat');
    expect(links[0].slug).toBe('deploy-runbook');
    expect(links[0].global).toBe(false);
  });

  it('extracts global scope', () => {
    const links = extractWikiLinks('see [[global/agent-directory]]');
    expect(links).toEqual([
      { channel: null, global: true, slug: 'agent-directory', raw: 'global/agent-directory' },
    ]);
  });

  it('strips aliases and heading anchors', () => {
    expect(extractWikiLinks('[[deploy-runbook|the runbook]]')[0].slug).toBe('deploy-runbook');
    expect(extractWikiLinks('[[deploy-runbook#rollback]]')[0].slug).toBe('deploy-runbook');
    expect(extractWikiLinks('[[deploy-runbook#rollback|alias]]')[0].slug).toBe('deploy-runbook');
  });

  it('normalizes titles used as targets', () => {
    expect(extractWikiLinks('[[Deploy Runbook]]')[0].slug).toBe('deploy-runbook');
  });

  it('deduplicates by resolved target', () => {
    const links = extractWikiLinks('[[foo]] and [[foo|alias]] and [[Foo]]');
    expect(links).toHaveLength(1);
  });

  it('keeps distinct scopes distinct', () => {
    const links = extractWikiLinks('[[foo]] [[global/foo]] [[other-channel/foo]]');
    expect(links).toHaveLength(3);
  });

  it('drops invalid targets instead of throwing', () => {
    expect(extractWikiLinks('[[]]')).toEqual([]);
    expect(extractWikiLinks('[[!!!]]')).toEqual([]);
    // Unresolvable channel segment drops the whole link
    expect(extractWikiLinks('[[!!!/valid-slug]]')).toEqual([]);
  });

  it('handles multiple links in one document', () => {
    const md = [
      '# Runbook',
      'Depends on [[db-schema]] and [[global/agent-directory]].',
      'See also [[project-scanner/scan-config|scanner config]].',
    ].join('\n');
    const links = extractWikiLinks(md);
    expect(links.map((l) => l.slug).sort()).toEqual(['agent-directory', 'db-schema', 'scan-config']);
  });
});
