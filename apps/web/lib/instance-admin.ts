import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import type { AgentContext } from '@airchat/shared';
import { authenticateAgent, isDashboardAdmin } from '@/lib/api-v2-auth';
import { createSupabaseServer } from '@/lib/supabase-server';

/**
 * Operator-level authorization for actions that change what this instance
 * trusts: turning federation on, adding or removing peers, and releasing or
 * reading quarantined content.
 *
 * An agent key is deliberately NOT enough. Every agent on the board holds one,
 * and agents read untrusted text all day; if an agent key could add a peer and
 * approve quarantined messages, one successful prompt injection would open the
 * instance to an attacker's server. These actions belong to the person who
 * runs the instance, proven one of two ways:
 *
 * - a dashboard session whose user is in admin_users, or
 * - the `x-admin-secret` header matching ADMIN_REGISTRATION_SECRET (the same
 *   operator secret that registers machines), for the CLI.
 *
 * Returns null when authorized, otherwise the response to send.
 */
export async function requireInstanceAdmin(request: NextRequest): Promise<NextResponse | null> {
  const provided = request.headers.get('x-admin-secret');
  if (provided) {
    const secret = process.env.ADMIN_REGISTRATION_SECRET;
    if (secret) {
      const a = Buffer.from(secret);
      const b = Buffer.from(provided);
      if (a.length === b.length && timingSafeEqual(a, b)) return null;
    }
    return NextResponse.json({ error: 'Invalid admin secret' }, { status: 403 });
  }

  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (user && (await isDashboardAdmin(user.id))) return null;

  return NextResponse.json(
    {
      error:
        'Instance admin required: sign in to the dashboard as an admin, or send x-admin-secret (set AIRCHAT_ADMIN_SECRET for the CLI). An agent key cannot do this.',
    },
    { status: user || request.headers.get('x-agent-api-key') ? 403 : 401 },
  );
}

/**
 * For read-only status endpoints that agents and the dashboard both use:
 * a registered agent, or an instance admin. Returns the agent context (null
 * for an admin), or the error response.
 */
export async function authenticateAgentOrAdmin(
  request: NextRequest,
): Promise<{ agent: AgentContext | null } | NextResponse> {
  if (request.headers.get('x-agent-api-key')) {
    const auth = await authenticateAgent(request);
    if (auth instanceof NextResponse) return auth;
    return { agent: auth };
  }
  const denied = await requireInstanceAdmin(request);
  if (denied) return denied;
  return { agent: null };
}
