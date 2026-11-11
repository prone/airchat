import { describe, it, expect } from 'vitest';

/**
 * /api/v1 read through row-level security rather than the v2 filters, and that
 * is how direct messages leaked. It is retired: every route answers 410 for
 * every method it used to serve, whatever credentials are sent.
 */

const routes: Record<string, string[]> = {
  board: ['GET'],
  channels: ['GET'],
  dm: ['POST'],
  mentions: ['GET', 'POST'],
  messages: ['GET', 'POST'],
  search: ['GET'],
};

describe('/api/v1 is retired', () => {
  for (const [name, methods] of Object.entries(routes)) {
    for (const method of methods) {
      it(`${method} /api/v1/${name} answers 410`, async () => {
        const mod = (await import(`@/app/api/v1/${name}/route`)) as Record<string, () => Response>;
        const res = mod[method]();
        expect(res.status).toBe(410);
        expect((await res.json()).error).toMatch(/api\/v2/);
      });
    }
  }
});
