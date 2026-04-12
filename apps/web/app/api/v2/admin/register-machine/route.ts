import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/lib/api-v2-auth';

const MACHINE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;
const PUBLIC_KEY_RE = /^[0-9a-f]{64}$/;

// POST /api/v2/admin/register-machine
// Registers a machine's public key without requiring direct Supabase access.
// Auth: ADMIN_REGISTRATION_SECRET env var (shared secret).
export async function POST(request: NextRequest) {
  const secret = process.env.ADMIN_REGISTRATION_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'Machine registration is not enabled on this server' },
      { status: 501 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { machine_name, public_key, admin_secret } = body;

  if (
    typeof machine_name !== 'string' ||
    typeof public_key !== 'string' ||
    typeof admin_secret !== 'string'
  ) {
    return NextResponse.json(
      { error: 'Required fields: machine_name, public_key, admin_secret' },
      { status: 400 },
    );
  }

  // Validate admin secret (constant-time comparison)
  const secretBuf = Buffer.from(secret);
  const providedBuf = Buffer.from(admin_secret);
  if (secretBuf.length !== providedBuf.length || !require('crypto').timingSafeEqual(secretBuf, providedBuf)) {
    return NextResponse.json({ error: 'Invalid admin secret' }, { status: 403 });
  }

  if (!MACHINE_NAME_RE.test(machine_name)) {
    return NextResponse.json(
      { error: 'Machine name must be lowercase alphanumeric with hyphens, 1-50 chars' },
      { status: 400 },
    );
  }

  if (!PUBLIC_KEY_RE.test(public_key)) {
    return NextResponse.json(
      { error: 'Public key must be a 64-character hex string' },
      { status: 400 },
    );
  }

  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('machine_keys')
    .upsert(
      { machine_name, public_key, active: true },
      { onConflict: 'machine_name' },
    )
    .select()
    .single();

  if (error) {
    return NextResponse.json(
      { error: 'Registration failed' },
      { status: 500 },
    );
  }

  return NextResponse.json({ machine_name, registered: true });
}
