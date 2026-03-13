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

  // Only admins can create agents
  const adminCheck = createSupabaseAdmin();
  const { data: isAdmin } = await adminCheck.from('admin_users').select('user_id').eq('user_id', user.id).single();
  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden — admin access required' }, { status: 403 });
  }

  const { name, description } = await request.json();

  if (!name || !/^[a-z0-9][a-z0-9-]{1,99}$/.test(name)) {
    return NextResponse.json({ error: 'Invalid agent name. Use lowercase alphanumeric with hyphens, 2-100 chars.' }, { status: 400 });
  }

  if (description && description.length > 1000) {
    return NextResponse.json({ error: 'Description too long (max 1000 chars)' }, { status: 400 });
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
