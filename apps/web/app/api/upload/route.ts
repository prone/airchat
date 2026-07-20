import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServer } from '@/lib/supabase-server';
import { STORAGE_BUCKET, DIRECT_MESSAGES_CHANNEL, formatSize } from '@airchat/shared';
import { getSupabaseClient, getStorageAdapter, isDashboardAdmin, resolveDashboardAdminAgent } from '@/lib/api-v2-auth';

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

/** Sanitize a file name: replace anything that isn't alphanumeric, dot, dash, or underscore. */
function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// POST /api/upload — upload a file from the dashboard and post a message linking
// it. Session-auth + admin-gated (the dashboard is admin-only). Uses the
// service role for storage and posts as the `dashboard-admin` agent via the
// storage adapter — the same path as /api/messages. (Replaces the old flow that
// required an unset AIRCHAT_API_KEY and the dead v1 agent-key send path.)
export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!(await isDashboardAdmin(user.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  const channel = formData.get('channel') as string | null;

  if (!file || !channel) {
    return NextResponse.json({ error: 'File and channel are required' }, { status: 400 });
  }
  if (!/^[a-z0-9][a-z0-9-]{1,99}$/.test(channel)) {
    return NextResponse.json({ error: 'Invalid channel name' }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json({ error: 'File too large (max 50MB)' }, { status: 400 });
  }

  const admin = await resolveDashboardAdminAgent();
  if (!admin) {
    return NextResponse.json({ error: 'Dashboard uploads are not provisioned' }, { status: 500 });
  }

  const timestamp = Date.now();
  const safeName = sanitizeFileName(file.name);
  const path = `${channel}/${timestamp}-${safeName}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  // Upload via the service role (the private bucket isn't writable by the anon
  // session; the service key never leaves the server).
  const { error: uploadErr } = await getSupabaseClient()
    .storage
    .from(STORAGE_BUCKET)
    .upload(path, buffer, { contentType: file.type, upsert: false });
  if (uploadErr) {
    console.error('Upload failed:', uploadErr.message);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }

  // Post a message linking the file, as dashboard-admin via the service-role
  // storage adapter.
  const target = formData.get('target_agent') as string | null;
  const messageContent = target
    ? `@${target} Shared a file: **${safeName}** (${formatSize(file.size)})`
    : `Shared a file: **${safeName}** (${formatSize(file.size)})`;
  const actualChannel = target ? DIRECT_MESSAGES_CHANNEL : channel;

  try {
    const scoped = getStorageAdapter().forAgent({ agentId: admin.id, agentName: admin.name, machineId: '' });
    await scoped.sendMessage(actualChannel, messageContent, {
      source: 'dashboard',
      user_email: user.email ?? undefined,
      files: [{ name: file.name, size: file.size, type: file.type, path, bucket: STORAGE_BUCKET }],
    });
  } catch (e) {
    // The file uploaded fine; only the announcement message failed.
    console.error('Failed to post file message:', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    file: { name: file.name, size: file.size, path, bucket: STORAGE_BUCKET },
  });
}
