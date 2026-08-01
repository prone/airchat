/**
 * Content sanitization helpers for federated data.
 *
 * Kept separate from gossip-sync so it can be unit tested without pulling in
 * the sync engine's Supabase and adapter dependencies.
 */

/**
 * Strip HTML tags from federated content.
 *
 * Defense-in-depth only. The primary XSS control is the render path: content
 * goes through SafeMarkdown, which builds React elements directly and never
 * uses dangerouslySetInnerHTML, so React escapes it regardless of what this
 * function returns.
 *
 * CodeQL flags this as js/incomplete-sanitization because single-pass regex
 * tag-stripping is a known-fragile pattern. It does not admit a bypass here:
 * the regex matches from the first `<` to the first following `>`, so after
 * one pass every surviving `<` has no `>` after it and no complete tag can
 * remain. Removal cannot join a leftover `<` to a later `>` either, because
 * the `>` that ended the match was consumed. A repeat-until-stable version was
 * tried and shown to be a no-op against 200k fuzzed inputs, so it was dropped
 * rather than shipped as complexity that does nothing.
 *
 * What survives is inert text -- `<<script>script>` becomes `script>`, which
 * cannot form an element. The tests pin that property.
 */
export function stripHtmlTags(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}

/** Longest a single interpolated value may be in a log line. */
const MAX_LOGGED_LENGTH = 200;

/**
 * Make a peer-controlled value safe to interpolate into a log line.
 *
 * Values like agent keys, peer display names and suspension reasons arrive
 * over federation, so a hostile peer chooses their contents. Without this, a
 * newline in a display name lets that peer append whatever it likes to the
 * log -- forging entries that look like they came from this instance, which
 * matters precisely because these logs record quarantines and suspensions.
 * Control characters are also how ANSI escapes get into a terminal reading
 * the logs.
 *
 * Replaces CR, LF, tabs, other C0/C1 control characters and the DEL byte with
 * U+FFFD, then truncates so one value cannot flood the line.
 */
export function sanitizeForLog(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  // C0 controls (CR, LF, tab included), DEL, and C1 controls (ANSI escapes).
  const cleaned = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, '\uFFFD');
  return cleaned.length > MAX_LOGGED_LENGTH
    ? `${cleaned.slice(0, MAX_LOGGED_LENGTH)}…`
    : cleaned;
}
