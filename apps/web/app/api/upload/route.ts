import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServer } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';

const BUCKET = 'agentchat-files';
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

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json({ error: 'File too large (max 50MB)' }, { status: 400 });
  }

  const agentApiKey = process.env.AGENTCHAT_API_KEY;
  if (!agentApiKey) {
    return NextResponse.json({ error: 'No AGENTCHAT_API_KEY configured' }, { status: 500 });
  }

  // Upload using the authenticated user's session (has storage access)
  const timestamp = Date.now();
  const safeName = sanitizeFileName(file.name);
  const path = `${channel}/${timestamp}-${safeName}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  // Try with the user's auth session first
  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadErr) {
    // If RLS blocks it, try with service role key if available
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (serviceKey) {
      const adminClient = createClient(
        supabaseUrl,
        serviceKey,
        { auth: { persistSession: false } }
      );
      const { error: adminUploadErr } = await adminClient.storage
        .from(BUCKET)
        .upload(path, buffer, { contentType: file.type, upsert: false });

      if (adminUploadErr) {
        return NextResponse.json({ error: `Upload failed: ${adminUploadErr.message}` }, { status: 500 });
      }
    } else {
      return NextResponse.json({
        error: `Upload failed: ${uploadErr.message}. Add a storage policy for authenticated users on the "${BUCKET}" bucket, or set SUPABASE_SERVICE_ROLE_KEY in .env.local.`,
      }, { status: 500 });
    }
  }

  // Post a message with the file reference
  const agentClient = createClient(
    supabaseUrl,
    anonKey,
    {
      global: {
        headers: {
          'x-agent-api-key': agentApiKey,
          'x-agent-name': 'dashboard-admin',
        },
      },
    }
  );

  await agentClient.rpc('ensure_agent_exists', { p_agent_name: 'dashboard-admin' });

  const target = formData.get('target_agent') as string | null;
  const messageContent = target
    ? `@${target} Shared a file: **${file.name}** (${formatSize(file.size)})`
    : `Shared a file: **${file.name}** (${formatSize(file.size)})`;

  const actualChannel = target ? 'direct-messages' : channel;

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
        bucket: BUCKET,
      }],
    },
  });

  return NextResponse.json({
    file: {
      name: file.name,
      size: file.size,
      path,
      bucket: BUCKET,
    },
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
