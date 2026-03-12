import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const BUCKET = 'agentchat-files';

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

  // Validate the caller is an authenticated agent or dashboard user
  const agentApiKey = request.headers.get('x-agent-api-key');
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  if (agentApiKey) {
    // Verify this is a valid agent key by calling get_agent_id
    const agentClient = createClient(supabaseUrl, anonKey, {
      global: {
        headers: {
          'x-agent-api-key': agentApiKey,
          'x-agent-name': request.headers.get('x-agent-name') || '',
        },
      },
    });

    // Try to call a simple RPC that requires agent auth
    const { data, error } = await agentClient.rpc('check_mentions', {
      only_unread: true,
      mention_limit: 1,
    });

    if (error) {
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
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let storageClient;

  if (serviceKey) {
    storageClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  } else {
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
      'Content-Disposition': `inline; filename="${filePath.split('/').pop()}"`,
    },
  });
}
