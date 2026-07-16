/**
 * Extract GitHub repos and task references (issues / pull requests) from
 * channel text (message and note content). Used to surface a channel's repos
 * and open tasks as links in the dashboard.
 *
 * Browser-safe: no Node imports.
 */

// github.com/owner/repo, stopping at the repo segment. Excludes reserved paths.
const REPO_RE = /https?:\/\/github\.com\/([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:\.git)?(?=[\/#?)\s]|$)/g;
// github.com/owner/repo/issues|pull/N — a task reference
const TASK_RE = /https?:\/\/github\.com\/([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)\/(issues|pull)\/(\d+)/g;

// Owner path segments that are not repos.
const RESERVED = new Set(['orgs', 'sponsors', 'settings', 'notifications', 'marketplace', 'apps', 'topics', 'collections']);

export interface ChannelTask {
  key: string;   // owner/repo#N
  url: string;
  kind: 'issue' | 'pr';
  repo: string;  // owner/repo
}

export interface ChannelLinks {
  repos: string[];         // "owner/repo", deduped, most-referenced first
  tasks: ChannelTask[];    // deduped by key
}

/** Normalize a repo slug ("owner/repo"), or null if it's a reserved/invalid path. */
function normalizeRepo(owner: string, repo: string): string | null {
  if (RESERVED.has(owner.toLowerCase())) return null;
  const cleanRepo = repo.replace(/\.git$/, '');
  if (!cleanRepo || cleanRepo === '.' || cleanRepo === '..') return null;
  return `${owner}/${cleanRepo}`;
}

/**
 * Extract repos and tasks from a body of text. Repos are ranked by reference
 * count (descending); tasks are deduped by their owner/repo#N key.
 */
export function extractGithubLinks(text: string): ChannelLinks {
  const repoCounts = new Map<string, number>();
  const tasks = new Map<string, ChannelTask>();

  for (const m of text.matchAll(TASK_RE)) {
    const repo = normalizeRepo(m[1], m[2]);
    if (!repo) continue;
    const kind = m[3] === 'pull' ? 'pr' : 'issue';
    const key = `${repo}#${m[4]}`;
    if (!tasks.has(key)) {
      tasks.set(key, { key, url: m[0], kind, repo });
    }
    repoCounts.set(repo, (repoCounts.get(repo) ?? 0) + 1);
  }

  for (const m of text.matchAll(REPO_RE)) {
    const repo = normalizeRepo(m[1], m[2]);
    if (!repo) continue;
    repoCounts.set(repo, (repoCounts.get(repo) ?? 0) + 1);
  }

  const repos = [...repoCounts.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
  return { repos, tasks: [...tasks.values()] };
}
