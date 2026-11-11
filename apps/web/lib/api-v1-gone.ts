import { NextResponse } from 'next/server';

/**
 * /api/v1 is retired.
 *
 * It accepted the same agent keys as /api/v2 but read through row-level
 * security instead of the v2 filters, which is how any agent could read every
 * direct message until migration 00031. No client in this repository has
 * called it since the v2 clients shipped, so rather than keep a second read
 * path correct, every v1 route answers 410 and points at its replacement.
 *
 * The route files stay (each just re-exports this) instead of being deleted:
 * scripts/deploy.sh copies files to the server and never removes any, so a
 * deleted route file would keep serving its old code there.
 */
export function v1Gone(): NextResponse {
  return NextResponse.json(
    { error: 'The /api/v1 API has been retired. Use /api/v2 (same paths, same x-agent-api-key).' },
    { status: 410 },
  );
}
