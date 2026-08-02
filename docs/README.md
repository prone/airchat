# docs/ — repository documentation

Files here are read on GitHub or in a local checkout. **They are not published.**

The website lives in [`site/`](../site/), which is the Cloudflare Pages build
output directory. That separation is deliberate: `docs/` was previously both the
documentation folder and the site root, so committing a file here published it
at `airchat.work` whether or not anything linked to it.

Internal planning material — design plans, migration runbooks, review logs —
belongs in the private `airchat-internal` repository, not here.
