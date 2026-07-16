import { describe, expect, it } from 'vitest';
import { extractGithubLinks } from '../channel-links.js';

describe('extractGithubLinks', () => {
  it('extracts a repo from a plain URL', () => {
    const { repos } = extractGithubLinks('see https://github.com/prone/airchat for details');
    expect(repos).toEqual(['prone/airchat']);
  });

  it('strips .git and trailing paths', () => {
    expect(extractGithubLinks('https://github.com/prone/airchat.git').repos).toEqual(['prone/airchat']);
    expect(extractGithubLinks('https://github.com/prone/airchat/tree/main').repos).toEqual(['prone/airchat']);
  });

  it('extracts issues and PRs as tasks', () => {
    const { tasks } = extractGithubLinks(
      'fixing https://github.com/prone/airchat/issues/12 and https://github.com/prone/airchat/pull/34'
    );
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.kind === 'issue')?.key).toBe('prone/airchat#12');
    expect(tasks.find((t) => t.kind === 'pr')?.key).toBe('prone/airchat#34');
  });

  it('dedupes repos and ranks by reference count', () => {
    const { repos } = extractGithubLinks([
      'https://github.com/a/one',
      'https://github.com/b/two',
      'https://github.com/b/two/issues/1',
      'https://github.com/b/two',
    ].join('\n'));
    expect(repos[0]).toBe('b/two'); // referenced 3x
    expect(repos).toContain('a/one');
    expect(new Set(repos).size).toBe(repos.length);
  });

  it('dedupes tasks by key', () => {
    const { tasks } = extractGithubLinks(
      'https://github.com/a/b/issues/5 ... again https://github.com/a/b/issues/5'
    );
    expect(tasks).toHaveLength(1);
  });

  it('ignores reserved owner paths', () => {
    expect(extractGithubLinks('https://github.com/orgs/foo/teams').repos).toEqual([]);
    expect(extractGithubLinks('https://github.com/marketplace/actions/x').repos).toEqual([]);
  });

  it('returns empty for text with no github links', () => {
    expect(extractGithubLinks('no links here, just words')).toEqual({ repos: [], tasks: [] });
  });

  it('handles a task and its repo together', () => {
    const { repos, tasks } = extractGithubLinks('work on https://github.com/prone/airchat/pull/7');
    expect(repos).toEqual(['prone/airchat']);
    expect(tasks[0].repo).toBe('prone/airchat');
  });
});
