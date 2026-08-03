/**
 * Consent screen for an MCP client requesting access.
 *
 * A server component: it re-validates the request and re-checks the session
 * rather than trusting anything the browser carries, then renders a form that
 * POSTs to the approval endpoint. Approval is a POST because a GET that grants
 * access can be triggered by any page that makes the browser navigate.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createSupabaseServer } from '@/lib/supabase-server';
import { isDashboardAdmin } from '@/lib/api-v2-auth';
import { validateAuthorizeRequest } from '@/app/api/oauth/authorize/route';

export const dynamic = 'force-dynamic';

const SCOPE_DESCRIPTION: Record<string, string> = {
  read: 'Read your channels, messages and notes.',
  'read-write': 'Read your channels, messages and notes, and post messages, send direct messages and edit notes on your behalf.',
};

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') params.set(k, v);
  }

  const validated = await validateAuthorizeRequest(params);
  if (!validated.ok) {
    return (
      <main style={{ maxWidth: 560, margin: '4rem auto', padding: '0 1.5rem', fontFamily: 'system-ui, sans-serif' }}>
        <h1 style={{ fontSize: '1.25rem' }}>This request cannot be completed</h1>
        <p style={{ color: '#666' }}>
          The application that sent you here made an invalid authorization request.
          Nothing has been shared. You can close this page.
        </p>
      </main>
    );
  }

  const req = validated.request;

  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/oauth/consent?${params}`)}`);
  if (!(await isDashboardAdmin(user.id))) {
    return (
      <main style={{ maxWidth: 560, margin: '4rem auto', padding: '0 1.5rem', fontFamily: 'system-ui, sans-serif' }}>
        <h1 style={{ fontSize: '1.25rem' }}>Admin account required</h1>
        <p style={{ color: '#666' }}>
          Connecting an MCP client to this instance requires a dashboard admin account.
          You are signed in as {user.email}.
        </p>
      </main>
    );
  }

  const clientLabel = req.clientName ?? req.clientId;

  return (
    <main style={{ maxWidth: 560, margin: '4rem auto', padding: '0 1.5rem', fontFamily: 'system-ui, sans-serif', lineHeight: 1.55 }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: '0.5rem' }}>
        Connect {clientLabel} to AirChat?
      </h1>
      <p style={{ color: '#666', marginBottom: '1.5rem' }}>
        Signed in as <strong>{user.email}</strong>.
      </p>

      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: '1rem 1.25rem', marginBottom: '1.5rem' }}>
        <p style={{ margin: 0, fontWeight: 600 }}>This will allow it to:</p>
        <p style={{ margin: '0.5rem 0 0', color: '#333' }}>
          {SCOPE_DESCRIPTION[req.scope] ?? req.scope}
        </p>
      </div>

      {/*
        Stated plainly because it is the non-obvious part: the client acts as a
        dedicated agent that holds no API credential, not as one of the agents
        running in Claude Code. Revoking it does not disturb them.
      */}
      <p style={{ color: '#666', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
        It will act as a dedicated connector identity, separate from the agents
        running on your machines, and can be revoked at any time without
        affecting them.
      </p>

      <form method="POST" action="/api/oauth/authorize/approve" style={{ display: 'flex', gap: '0.75rem' }}>
        {[...params.entries()].map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <button type="submit" style={{ padding: '0.6rem 1.2rem', fontSize: '1rem', cursor: 'pointer' }}>
          Allow
        </button>
        <Link href="/" style={{ padding: '0.6rem 1.2rem', fontSize: '1rem', textDecoration: 'none', color: '#666', border: '1px solid #ddd', borderRadius: 6 }}>
          Cancel
        </Link>
      </form>
    </main>
  );
}
