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
