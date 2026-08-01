/**
 * Wiki-link parsing for the knowledge layer (notes).
 *
 * Syntax (Obsidian-inspired, strictly channel-scoped):
 *   [[slug]]                 — resolves within the current channel scope only
 *   [[channel-name/slug]]    — explicit cross-channel reference
 *   [[global/slug]]          — instance-global note
 *   [[slug|display text]]    — alias (display text ignored for link resolution)
 *   [[slug#heading]]         — block/heading anchor (Phase 3; anchor ignored for now)
 *
 * There is deliberately NO global fallback resolution: an unqualified [[slug]]
 * never resolves outside its channel. See design doc §3.2 / §10 (threat model).
 *
 * Browser-safe: no Node.js imports (barrel-exported from @airchat/shared).
 */

/** Sentinel channel segment addressing the instance-global scope. */
export const GLOBAL_NOTE_SCOPE = 'global';

/** Matches [[target]] with optional |alias; target may contain / and #. */
const WIKI_LINK_RE = /\[\[([^\[\]|#]+)(?:#[^\[\]|]*)?(?:\|[^\[\]]*)?\]\]/g;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/;

/**
 * Cap on the raw target text fed through slugification, so the work is bounded
 * before any regex sees it. 20x the 200-character slug limit -- generous enough
 * that no real note title is affected, small enough that a hostile peer cannot
 * hand us a megabyte to chew on.
 */
const MAX_TARGET_INPUT = 4000;

export interface WikiLinkTarget {
  /** Channel name the link addresses, or null for "current channel scope". */
  channel: string | null;
  /** True when the link explicitly addresses the instance-global scope. */
  global: boolean;
  slug: string;
  /** The raw target text as written, for diagnostics. */
  raw: string;
}

/**
 * Normalize a wiki-link target segment into a slug:
 * lowercase, spaces/underscores to hyphens, strip other punctuation.
 * Returns null when nothing slug-like remains.
 */
export function slugifyNoteTarget(segment: string): string | null {
  // Bound the input before any regex runs. Wiki-link targets arrive in
  // federated content, so their length is attacker-controlled, and the
  // truncation below happens after the replaces -- meaning the regexes
  // previously ran over the full string however long it was.
  //
  // Measured, V8 handles these patterns linearly (200k characters in ~0.3ms),
  // so this is not a live DoS. Bounding the input removes the class of concern
  // regardless of engine behaviour, at no cost: the cap is 20x the 200-char
  // output limit, far beyond any real note title.
  const slug = segment
    .slice(0, MAX_TARGET_INPUT)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
  return SLUG_RE.test(slug) ? slug : null;
}

/**
 * Extract all wiki-link targets from markdown text. Deduplicates by
 * (channel, global, slug). Invalid targets are dropped, not thrown.
 */
export function extractWikiLinks(text: string): WikiLinkTarget[] {
  if (!text.includes('[[')) return [];

  const seen = new Set<string>();
  const targets: WikiLinkTarget[] = [];

  for (const match of text.matchAll(WIKI_LINK_RE)) {
    const raw = match[1].trim();
    if (!raw) continue;

    const slashIdx = raw.indexOf('/');
    let channel: string | null = null;
    let global = false;
    let slugSegment = raw;

    if (slashIdx !== -1) {
      const scopeSegment = raw.slice(0, slashIdx).trim();
      slugSegment = raw.slice(slashIdx + 1);
      if (scopeSegment.toLowerCase() === GLOBAL_NOTE_SCOPE) {
        global = true;
      } else {
        channel = slugifyNoteTarget(scopeSegment);
        if (!channel) continue;
      }
    }

    const slug = slugifyNoteTarget(slugSegment);
    if (!slug) continue;

    const key = `${global ? 'g' : channel ?? ''}/${slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ channel, global, slug, raw });
  }

  return targets;
}
