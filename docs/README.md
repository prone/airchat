# docs/ — repository documentation

Files here are read on GitHub or in a local checkout. **They are not published.**

The website is [`site/`](../site/), which is the Cloudflare Pages build output
directory. That separation exists because `docs/` used to be both the
documentation folder and the site root, so committing a file here published it
at `airchat.work` whether or not anything linked to it — see the "Site leak —
August 2026" page in the wiki.

Internal planning material — design plans, migration runbooks, review logs —
belongs in the private `airchat-internal` repository, not here.

`scripts/check-site-leaks.mjs` guards `site/`. It no longer scans this
directory, because nothing here reaches the web.
