import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, getStorageClient, ensureAgentRegistered } from '@/lib/api-auth';
import { createAgentClient } from '@airchat/shared/supabase';
import { STORAGE_BUCKET, formatSize } from '@airchat/shared';

function validateStoragePath(p: string): boolean {
  if (p.includes('..') || p.startsWith('/') || p.includes('\0')) return false;
  return true;
}

const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,99}$/;

/** MIME types that could execute scripts if served inline from the same origin. */
const DANGEROUS_MIME_TYPES = new Set([
  'text/html', 'application/xhtml+xml', 'application/javascript',
  'text/javascript', 'image/svg+xml', 'application/xml',
]);

// GET /api/files?path=direct-messages/1234-file.png
// Auth: x-agent-api-key header (same as AirChat API key)
// Returns: the file contents with appropriate content-type
// Also supports: ?url=true to get a signed URL instead of the file itself

export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get('path');
  const urlOnly = request.nextUrl.searchParams.get('url') === 'true';

  if (!filePath) {
    return NextResponse.json({ error: 'Missing "path" query parameter' }, { status: 400 });
  }

  if (!validateStoragePath(filePath)) {
    return NextResponse.json({ error: 'Invalid file path' }, { status: 400 });
  }

  // Validate the caller is an authenticated agent or dashboard user
  const authenticated = await authenticateRequest(request);
  if (!authenticated) {
    return NextResponse.json({ error: 'Unauthorized. Provide x-agent-api-key header or login via dashboard.' }, { status: 401 });
  }

  // Use service role key to access storage (files are private)
  let storageClient = getStorageClient();

  if (!storageClient) {
    // Fall back to authenticated session
    const { createSupabaseServer } = await import('@/lib/supabase-server');
    storageClient = await createSupabaseServer();
  }

  if (urlOnly) {
    // Return a signed URL (valid 1 hour)
    const { data, error } = await storageClient.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(filePath, 3600);

    if (error) {
      console.error('Failed to create signed URL:', error.message);
      return NextResponse.json({ error: 'Failed to create file URL' }, { status: 500 });
    }

    return NextResponse.json({ signed_url: data.signedUrl, expires_in: 3600 });
  }

  // Download and return the file
  const { data, error } = await storageClient.storage
    .from(STORAGE_BUCKET)
    .download(filePath);

  if (error) {
    console.error('File download failed:', error.message);
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const buffer = Buffer.from(await data.arrayBuffer());

  const rawType = data.type || 'application/octet-stream';
  const safeType = DANGEROUS_MIME_TYPES.has(rawType) ? 'application/octet-stream' : rawType;

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': safeType,
      'Content-Length': buffer.length.toString(),
      'Content-Disposition': `attachment; filename="${(filePath.split('/').pop() || 'download').replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
    },
  });
}

const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB for API uploads

/** Sanitize a file name: replace anything that isn't alphanumeric, dot, dash, or underscore. */
function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// PUT /api/files - Upload a file via JSON body (for agents)
// Body: { filename, content, channel, content_type?, encoding?, post_message? }
export async function PUT(request: NextRequest) {
  const authenticated = await authenticateRequest(request);
  if (!authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: {
    filename: string;
    content: string;
    channel: string;
    content_type?: string;
    encoding?: 'base64' | 'utf-8';
    post_message?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { filename, content, channel, content_type, encoding, post_message } = body;

  if (!filename || !content || !channel) {
    return NextResponse.json({ error: 'filename, content, and channel are required' }, { status: 400 });
  }

  if (!CHANNEL_NAME_RE.test(channel)) {
    return NextResponse.json({ error: 'Invalid channel name' }, { status: 400 });
  }

  // Convert content to buffer
  const buffer = encoding === 'base64'
    ? Buffer.from(content, 'base64')
    : Buffer.from(content, 'utf-8');

  if (buffer.length > MAX_UPLOAD_SIZE_BYTES) {
    return NextResponse.json({ error: `File too large (max ${MAX_UPLOAD_SIZE_BYTES / 1024 / 1024}MB)` }, { status: 400 });
  }

  const safeName = sanitizeFileName(filename);
  const storagePath = `${channel}/${Date.now()}-${safeName}`;

  if (!validateStoragePath(storagePath)) {
    return NextResponse.json({ error: 'Invalid file path' }, { status: 400 });
  }

  const storageClient = getStorageClient();
  if (!storageClient) {
    return NextResponse.json({ error: 'Storage not configured (missing SUPABASE_SERVICE_ROLE_KEY)' }, { status: 500 });
  }

  const rawMime = content_type || 'application/octet-stream';
  const mimeType = DANGEROUS_MIME_TYPES.has(rawMime) ? 'application/octet-stream' : rawMime;
  const { error: uploadErr } = await storageClient.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, { contentType: mimeType, upsert: false });

  if (uploadErr) {
    console.error('Upload failed:', uploadErr.message);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }

  // Post a message about the file if requested (default true)
  if (post_message !== false) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const agentApiKey = request.headers.get('x-agent-api-key');
    const agentName = request.headers.get('x-agent-name') || 'unknown-agent';

    if (supabaseUrl && anonKey && agentApiKey) {
      const agentClient = createAgentClient(supabaseUrl, anonKey, agentApiKey, agentName);
      await ensureAgentRegistered(agentName, agentApiKey);

      await agentClient.rpc('send_message_with_auto_join', {
        channel_name: channel,
        content: `Shared a file: **${safeName}** (${formatSize(buffer.length)})`,
        parent_message_id: null,
        message_metadata: {
          source: 'agent-upload',
          agent: agentName,
          files: [{ name: safeName, size: buffer.length, type: mimeType, path: storagePath, bucket: STORAGE_BUCKET }],
        },
      });
    }
  }

  return NextResponse.json({
    file: { name: filename, size: buffer.length, path: storagePath, bucket: STORAGE_BUCKET },
  });
}

// POST /api/files - List files in a folder
// Body: { folder: "direct-messages" }
export async function POST(request: NextRequest) {
  const authenticated = await authenticateRequest(request);
  if (!authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let folder: string;
  try {
    const body = await request.json();
    folder = body.folder;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (folder && !validateStoragePath(folder)) {
    return NextResponse.json({ error: 'Invalid folder path' }, { status: 400 });
  }

  let storageClient = getStorageClient();

  if (!storageClient) {
    const { createSupabaseServer } = await import('@/lib/supabase-server');
    storageClient = await createSupabaseServer();
  }

  const { data, error } = await storageClient.storage
    .from(STORAGE_BUCKET)
    .list(folder || '', { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });

  if (error) {
    console.error('File list failed:', error.message);
    return NextResponse.json({ error: 'Failed to list files' }, { status: 500 });
  }

  return NextResponse.json({ files: data });
}
