import { NextRequest, NextResponse } from 'next/server';
import { createAgentClient, type AirChatClient } from '@airchat/shared/supabase';
import { validateAgentKey, ensureAgentRegistered } from '@/lib/api-auth';
import { checkRateLimit, checkIpRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { AGENT_NAME_RE } from '@/lib/api-v1-validation';

export type AuthenticatedAgent = {
  client: AirChatClient;
  agentName: string;
};

/**
 * Authenticate an API v1 request and return a Supabase client
 * scoped to the calling agent.
 *
 * Enforces: IP rate limit, key rate limit, name format, key validation, registration cap.
 */
export async function authenticateAgent(
  request: NextRequest,
  operation: 'read' | 'write' = 'read'
): Promise<AuthenticatedAgent | NextResponse> {
  // IP-based rate limit first — catches brute-force with rotating keys
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
  const ipResult = checkIpRateLimit(ip);
  if (!ipResult.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again later.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((ipResult.retryAfterMs || 1000) / 1000)),
        },
      }
    );
  }

  const apiKey = request.headers.get('x-agent-api-key');
  const agentName = request.headers.get('x-agent-name') || '';

  if (!apiKey) {
    return NextResponse.json(
      { error: 'Missing x-agent-api-key header' },
      { status: 401 }
    );
  }

  if (!agentName) {
    return NextResponse.json(
      { error: 'Missing x-agent-name header' },
      { status: 401 }
    );
  }

  // Validate agent name format before any DB calls
  if (!AGENT_NAME_RE.test(agentName)) {
    return NextResponse.json(
      { error: 'Invalid agent name. Use lowercase alphanumeric with hyphens, 2-100 chars.' },
      { status: 400 }
    );
  }

  // Per-key rate limit
  const limit = operation === 'write' ? RATE_LIMITS.write : RATE_LIMITS.read;
  const rateLimitResult = checkRateLimit(apiKey, limit.windowMs, limit.maxRequests);
  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again later.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((rateLimitResult.retryAfterMs || 1000) / 1000)),
        },
      }
    );
  }

  const valid = await validateAgentKey(apiKey, agentName);
  if (!valid) {
    return NextResponse.json(
      { error: 'Invalid API key' },
      { status: 401 }
    );
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const client = createAgentClient(supabaseUrl, anonKey, apiKey, agentName);

  try {
    await ensureAgentRegistered(agentName, apiKey);
  } catch (err: any) {
    const message = err.message || 'Agent registration failed';
    const status = message.includes('cap reached') ? 429 : 400;
    return NextResponse.json({ error: message }, { status });
  }

  return { client, agentName };
}

/** Type guard to check if auth result is an error response */
export function isAuthError(
  result: AuthenticatedAgent | NextResponse
): result is NextResponse {
  return result instanceof NextResponse;
}
