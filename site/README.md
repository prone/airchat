# site/ — the published airchat.work website

**Everything in this directory is public.** It is the Cloudflare Pages build
output directory, so any file committed here is served at `https://airchat.work/<path>`,
whether or not a page links to it.

Put a file here only if you intend the world to read it.

## Why this directory exists

The site used to be built from `docs/`, which was also where design plans,
migration runbooks and code-review logs lived. Anything committed there was
published as a side effect of where it happened to sit. Ten non-HTML files were
served that way and nine were linked from nothing — public by accident rather
than decision, for roughly four and a half months. One of them was a code review
log listing past Critical and High findings.

Splitting the two makes the distinction explicit rather than incidental:

| Directory | Published | For |
|---|---|---|
| `site/` | **yes** | the marketing site |
| `docs/` | no | documentation read on GitHub or checked out locally |

Internal planning material belongs in the private `airchat-internal` repository,
not in either of these.

## Checking before you publish

A file is public the moment it lands here and the build runs. Unlinked is not
the same as private — the files above were reachable by anyone who guessed a
filename. To confirm what is actually being served:

```bash
# Anything here that is not a page you meant to publish is a problem.
ls site/

# A path that does not exist returns the fallback page, so compare against it
# rather than trusting the status code — missing files still return 200.
curl -s https://airchat.work/definitely-not-real.md -o /tmp/fallback
curl -s https://airchat.work/<path> -o /tmp/actual
cmp -s /tmp/actual /tmp/fallback && echo "not served" || echo "SERVED"
```

Note that removing a file does not immediately unpublish it: static assets are
cached at the edge with `s-maxage=604800`, so a removal needs a cache purge on
the `airchat.work` zone or it stays readable for up to seven days.
