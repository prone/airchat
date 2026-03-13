import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServer } from '@/lib/supabase-server';
import { createAgentClient } from '@airchat/shared/supabase';
import { STORAGE_BUCKET, DASHBOARD_ADMIN_AGENT, DIRECT_MESSAGES_CHANNEL, formatSize } from '@airchat/shared';
import { ensureAgentRegistered, getStorageClient } from '@/lib/api-auth';

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

/** Sanitize a file name: replace anything that isn't alphanumeric, dot, dash, or underscore. */
function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export async function POST(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({ error: 'Missing Supabase configuration (NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY)' }, { status: 500 });
  }

  // Verify authenticated
  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

  const agentApiKey = process.env.AIRCHAT_API_KEY;
  if (!agentApiKey) {
    return NextResponse.json({ error: 'No AIRCHAT_API_KEY configured' }, { status: 500 });
  }

  // Upload using the authenticated user's session (has storage access)
  const timestamp = Date.now();
  const safeName = sanitizeFileName(file.name);
  const path = `${channel}/${timestamp}-${safeName}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  // Try with the user's auth session first
  const { error: uploadErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, buffer, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadErr) {
    // If RLS blocks it, try with service role key if available
    const adminClient = getStorageClient();
    if (adminClient) {
      const { error: adminUploadErr } = await adminClient.storage
        .from(STORAGE_BUCKET)
        .upload(path, buffer, { contentType: file.type, upsert: false });

      if (adminUploadErr) {
        console.error('Upload failed:', adminUploadErr.message);
        return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
      }
    } else {
      console.error('Upload failed (no admin fallback):', uploadErr.message);
      return NextResponse.json({ error: 'Upload failed — check server configuration' }, { status: 500 });
    }
  }

  // Post a message with the file reference
  const agentClient = createAgentClient(supabaseUrl, anonKey, agentApiKey, DASHBOARD_ADMIN_AGENT);

  await ensureAgentRegistered(DASHBOARD_ADMIN_AGENT, agentApiKey);

  const target = formData.get('target_agent') as string | null;
  const messageContent = target
    ? `@${target} Shared a file: **${safeName}** (${formatSize(file.size)})`
    : `Shared a file: **${safeName}** (${formatSize(file.size)})`;

  const actualChannel = target ? DIRECT_MESSAGES_CHANNEL : channel;

  await agentClient.rpc('send_message_with_auto_join', {
    channel_name: actualChannel,
    content: messageContent,
    parent_message_id: null,
    message_metadata: {
      source: 'dashboard',
      user_email: user.email,
      files: [{
        name: file.name,
        size: file.size,
        type: file.type,
        path,
        bucket: STORAGE_BUCKET,
      }],
    },
  });

  return NextResponse.json({
    file: {
      name: file.name,
      size: file.size,
      path,
      bucket: STORAGE_BUCKET,
    },
  });
}
