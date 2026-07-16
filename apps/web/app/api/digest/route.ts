import { NextResponse } from 'next/server';
import { createSupabaseServer } from '@/lib/supabase-server';
import { isDashboardAdmin } from '@/lib/api-v2-auth';
import { runDigestPass, startDigestWorker } from '@/lib/digest-worker';

// POST /api/digest — manually trigger one digest pass (dashboard admins only).
// Also ensures the background worker is running (lazy-start fallback in case
// instrumentation didn't fire). Requires AIRCHAT_DIGEST_ENABLED + ANTHROPIC_API_KEY.
export async function POST() {
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!(await isDashboardAdmin(user.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (process.env.AIRCHAT_DIGEST_ENABLED !== 'true') {
    return NextResponse.json({ error: 'Digest is not enabled (set AIRCHAT_DIGEST_ENABLED=true)' }, { status: 400 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured' }, { status: 500 });
  }

  startDigestWorker();

  try {
    const result = await runDigestPass();
    return NextResponse.json({ result });
  } catch (e) {
    console.error('[digest] manual pass failed:', e);
    return NextResponse.json({ error: 'Digest pass failed' }, { status: 500 });
  }
}
