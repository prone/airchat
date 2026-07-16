import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServer } from '@/lib/supabase-server';
import { summarizeChannel, SummaryError } from '@/lib/summarize';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/channels/summarize — human (dashboard) requests an on-demand
// summary of a channel. Session-authenticated. Body: { channel_id }.
export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { channel_id?: string; window_days?: number };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  if (!body.channel_id || !UUID_RE.test(body.channel_id)) {
    return NextResponse.json({ error: 'Valid channel_id required' }, { status: 400 });
  }
  const windowDays = Number.isInteger(body.window_days) ? Math.min(Math.max(body.window_days!, 1), 30) : undefined;

  try {
    const summary = await summarizeChannel(body.channel_id, { windowDays });
    return NextResponse.json({ summary });
  } catch (e) {
    if (e instanceof SummaryError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error('[summary] failed:', e);
    return NextResponse.json({ error: 'Summary generation failed' }, { status: 500 });
  }
}
