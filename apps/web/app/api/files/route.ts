import { NextRequest, NextResponse } from 'next/server';
import { getStorageClient } from '@/lib/api-auth';
import { authenticateAgent, isAuthError, getStorageAdapter, getSupabaseClient, checkAgentRateLimit, isDashboardAdmin } from '@/lib/api-v2-auth';
import { createSupabaseServer } from '@/lib/supabase-server';
import type { AgentContext } from '@airchat/shared';
import { DIRECT_MESSAGES_CHANNEL, STORAGE_BUCKET, formatSize } from '@airchat/shared';

function validateStoragePath(p: string): boolean {
  if (p.includes('..') || p.startsWith('/') || p.includes('\0')) return false;
  return true;
}

/**
 * Who may touch stored files: a registered agent (verified derived key, the
 * same check every /api/v2 route uses) or a dashboard admin session.
 *
 * This route reads and writes storage with the service role, so nothing
 * downstream constrains the caller — the check here is the only one. It used
 * to be "a query through RLS with this key returned no error", which a
 * made-up key satisfies: RLS answers an unknown key with zero rows, not an
 * error. And a session alone is not enough either, because sign-up is open
 * and only admin_users members are dashboard admins.
 *
 * Returns the agent context (null for an admin session), or the error response.
 */
async function authorizeFileAccess(
  request: NextRequest,
  operation: 'read' | 'write',
): Promise<{ agent: AgentContext | null } | NextResponse> {
  if (request.headers.get('x-agent-api-key')) {
    const auth = await authenticateAgent(request);
    if (isAuthError(auth)) return auth;
    const limited = checkAgentRateLimit(auth.agentId, operation);
    if (limited) return limited;
    return { agent: auth };
  }

  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: 'Unauthorized. Provide x-agent-api-key header or login via dashboard.' },
      { status: 401 },
    );
  }
  if (!(await isDashboardAdmin(user.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return { agent: null };
}

function isDirectMessagePath(p: string): boolean {
  // First real segment, so "./direct-messages/x" and "direct-messages//x"
  // are recognised as well.
  const first = p.split('/').find((seg) => seg !== '' && seg !== '.');
  return first === DIRECT_MESSAGES_CHANNEL;
}

/**
 * Files attached to direct messages are as private as the messages. An agent
 * may fetch one only if it wrote, or is mentioned in, a direct message that
 * carries the file (`metadata.files[].path`). Dashboard admins are not
 * restricted — they can already read every message.
 *
 * Fails closed: any lookup error is a refusal.
 */
async function agentMayReadDirectMessageFile(agentId: string, filePath: string): Promise<boolean> {
  const db = getSupabaseClient();
  const { data: channel, error: channelError } = await db
    .from('channels').select('id').eq('name', DIRECT_MESSAGES_CHANNEL).maybeSingle();
  if (channelError || !channel) return false;

  const { data: carriers, error } = await db
    .from('messages')
    .select('id, author_agent_id')
    .eq('channel_id', channel.id)
    .eq('quarantined', false)
    .contains('metadata', { files: [{ path: filePath }] })
    .limit(50);
  if (error || !carriers || carriers.length === 0) return false;
  if (carriers.some((m: { author_agent_id: string }) => m.author_agent_id === agentId)) return true;

  const { data: mention, error: mentionError } = await db
    .from('mentions')
    .select('id')
    .eq('mentioned_agent_id', agentId)
    .in('message_id', carriers.map((m: { id: string }) => m.id))
    .limit(1);
  return !mentionError && !!mention && mention.length > 0;
}

/** Bare media type: lower-cased, parameters dropped ("Text/HTML; charset=utf-8" -> "text/html"). */
function baseMimeType(type: string): string {
  return type.split(';')[0].trim().toLowerCase();
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

  const access = await authorizeFileAccess(request, 'read');
  if (access instanceof NextResponse) return access;

  if (access.agent && isDirectMessagePath(filePath)
      && !(await agentMayReadDirectMessageFile(access.agent.agentId, filePath))) {
    // Same answer as a missing file: do not confirm that it exists.
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  // Use service role key to access storage (files are private)
  const storageClient = getStorageClient();
  if (!storageClient) {
    return NextResponse.json({ error: 'Storage not configured (missing SUPABASE_SERVICE_ROLE_KEY)' }, { status: 500 });
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
  const safeType = DANGEROUS_MIME_TYPES.has(baseMimeType(rawType)) ? 'application/octet-stream' : rawType;

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
  const access = await authorizeFileAccess(request, 'write');
  if (access instanceof NextResponse) return access;

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
  const mimeType = DANGEROUS_MIME_TYPES.has(baseMimeType(rawMime)) ? 'application/octet-stream' : rawMime;
  const { error: uploadErr } = await storageClient.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, { contentType: mimeType, upsert: false });

  if (uploadErr) {
    console.error('Upload failed:', uploadErr.message);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }

  // Post a message about the file if requested (default true). Best-effort
  // via the modern v2 path: the old send_message_with_auto_join RPC threw
  // under derived-key auth and turned every default upload into a 500 —
  // after the file was already stored. The upload result must never depend
  // on the announcement.
  // Only an agent has an identity to post as; a dashboard admin uploading
  // here gets the file without an announcement.
  const agent = access.agent;
  if (post_message !== false && agent) {
    try {
      const scoped = getStorageAdapter().forAgent(agent);
      await scoped.sendMessage(
        channel,
        `Shared a file: **${safeName}** (${formatSize(buffer.length)})`,
        {
          source: 'agent-upload',
          agent: agent.agentName,
          files: [{ name: safeName, size: buffer.length, type: mimeType, path: storagePath, bucket: STORAGE_BUCKET }],
        },
      );
    } catch (err) {
      console.error(`[files] upload announcement failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return NextResponse.json({
    file: { name: filename, size: buffer.length, path: storagePath, bucket: STORAGE_BUCKET },
  });
}

// POST /api/files - List files in a folder
// Body: { folder: "direct-messages" }
export async function POST(request: NextRequest) {
  const access = await authorizeFileAccess(request, 'read');
  if (access instanceof NextResponse) return access;

  let folder: string;
  try {
    const body = await request.json();
    folder = body.folder;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (folder !== undefined && folder !== null && typeof folder !== 'string') {
    return NextResponse.json({ error: 'Invalid folder path' }, { status: 400 });
  }
  if (folder && !validateStoragePath(folder)) {
    return NextResponse.json({ error: 'Invalid folder path' }, { status: 400 });
  }
  // Listing would hand an agent the names of everyone's DM attachments.
  if (access.agent && folder && isDirectMessagePath(folder)) {
    return NextResponse.json({ error: 'Direct-message files cannot be listed' }, { status: 403 });
  }

  const storageClient = getStorageClient();
  if (!storageClient) {
    return NextResponse.json({ error: 'Storage not configured (missing SUPABASE_SERVICE_ROLE_KEY)' }, { status: 500 });
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
