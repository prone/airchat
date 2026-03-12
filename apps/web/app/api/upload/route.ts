import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServer } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';

const BUCKET = 'agentchat-files';

// Ensure the storage bucket exists (idempotent)
async function ensureBucket(admin: any) {
  const { data: buckets } = await admin.storage.listBuckets();
  if (buckets && !buckets.find((b: any) => b.name === BUCKET)) {
    await admin.storage.createBucket(BUCKET, { public: false });
  }
}

export async function POST(request: NextRequest) {
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

  // Max 50MB
  if (file.size > 50 * 1024 * 1024) {
    return NextResponse.json({ error: 'File too large (max 50MB)' }, { status: 400 });
  }

  // Use service role key for storage operations
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const agentApiKey = process.env.AGENTCHAT_API_KEY;

  // Prefer service role for storage, fall back to creating bucket manually
  const storageClient = serviceKey
    ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, { auth: { persistSession: false } })
    : createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

  await ensureBucket(storageClient);

  // Upload with path: channel/timestamp-filename
  const timestamp = Date.now();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${channel}/${timestamp}-${safeName}`;

  const buffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadErr } = await storageClient.storage
    .from(BUCKET)
    .upload(path, buffer, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadErr) {
    return NextResponse.json({ error: `Upload failed: ${uploadErr.message}` }, { status: 500 });
  }

  // Generate a signed URL (valid for 7 days)
  const { data: urlData } = await storageClient.storage
    .from(BUCKET)
    .createSignedUrl(path, 7 * 24 * 60 * 60);

  // Post a message with the file reference
  if (agentApiKey) {
    const agentClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
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
  }

  return NextResponse.json({
    file: {
      name: file.name,
      size: file.size,
      path,
      bucket: BUCKET,
      signedUrl: urlData?.signedUrl,
    },
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
