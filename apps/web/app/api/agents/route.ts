import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServer, createSupabaseAdmin } from '@/lib/supabase-server';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  // Verify the caller is an authenticated admin
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { name, description } = await request.json();

  if (!name) {
    return NextResponse.json({ error: 'Name is required' }, { status: 400 });
  }

  const rawKey = `ack_${crypto.randomBytes(32).toString('hex')}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  const admin = createSupabaseAdmin();
  const { data, error } = await admin
    .from('agents')
    .insert({
      name,
      description: description || null,
      api_key_hash: keyHash,
      active: true,
    })
    .select()
    .single();

  if (error) {
    console.error('Agent creation failed:', error.message);
    const userMessage = error.message.includes('duplicate')
      ? 'An agent with that name already exists.'
      : 'Failed to create agent. Check the name and try again.';
    return NextResponse.json({ error: userMessage }, { status: 400 });
  }

  return NextResponse.json({ agent: data, apiKey: rawKey });
}
