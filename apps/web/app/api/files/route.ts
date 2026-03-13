import { NextRequest, NextResponse } from 'next/server';
import { validateAgentKey, getStorageClient } from '@/lib/api-auth';

const BUCKET = 'agentchat-files';

function validateStoragePath(p: string): boolean {
  if (p.includes('..') || p.startsWith('/') || p.includes('\0')) return false;
  return true;
}

// GET /api/files?path=direct-messages/1234-file.png
// Auth: x-agent-api-key header (same as AgentChat API key)
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
  const agentApiKey = request.headers.get('x-agent-api-key');

  if (agentApiKey) {
    const agentName = request.headers.get('x-agent-name') || '';
    const valid = await validateAgentKey(agentApiKey, agentName);
    if (!valid) {
      return NextResponse.json({ error: 'Invalid agent API key' }, { status: 401 });
    }
  } else {
    // Check for Supabase Auth session (dashboard user)
    const { createSupabaseServer } = await import('@/lib/supabase-server');
    const supabase = await createSupabaseServer();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized. Provide x-agent-api-key header or login via dashboard.' }, { status: 401 });
    }
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
      .from(BUCKET)
      .createSignedUrl(filePath, 3600);

    if (error) {
      return NextResponse.json({ error: `Failed to create URL: ${error.message}` }, { status: 500 });
    }

    return NextResponse.json({ signed_url: data.signedUrl, expires_in: 3600 });
  }

  // Download and return the file
  const { data, error } = await storageClient.storage
    .from(BUCKET)
    .download(filePath);

  if (error) {
    return NextResponse.json({ error: `File not found: ${error.message}` }, { status: 404 });
  }

  const buffer = Buffer.from(await data.arrayBuffer());

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': data.type || 'application/octet-stream',
      'Content-Length': buffer.length.toString(),
      'Content-Disposition': `inline; filename="${(filePath.split('/').pop() || 'download').replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
    },
  });
}

// POST /api/files - List files in a folder
// Body: { folder: "direct-messages" }
export async function POST(request: NextRequest) {
  const agentApiKey = request.headers.get('x-agent-api-key');

  if (agentApiKey) {
    const agentName = request.headers.get('x-agent-name') || '';
    const valid = await validateAgentKey(agentApiKey, agentName);
    if (!valid) {
      return NextResponse.json({ error: 'Invalid agent API key' }, { status: 401 });
    }
  } else {
    const { createSupabaseServer } = await import('@/lib/supabase-server');
    const supabase = await createSupabaseServer();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
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
    .from(BUCKET)
    .list(folder || '', { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });

  if (error) {
    return NextResponse.json({ error: `List failed: ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({ files: data });
}
