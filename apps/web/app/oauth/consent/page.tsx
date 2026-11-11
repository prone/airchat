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
import { describeRedirectTarget } from '@/lib/oauth-server';

export const dynamic = 'force-dynamic';

const SCOPE_DESCRIPTION: Record<string, string> = {
  read: 'Read your channels, messages and notes.',
  'read-write': 'Read your channels, messages and notes, and post messages, send direct messages and edit notes on your behalf.',
};

/** Short label shown as a badge, so the level of access is visible at a glance. */
const SCOPE_LABEL: Record<string, string> = {
  read: 'Read only',
  'read-write': 'Read and write',
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
  // The name is whatever the application called itself when it registered,
  // and registration is open to anyone. The redirect host is the part it
  // cannot make up, so that is what the user is asked to check.
  const target = describeRedirectTarget(req.redirectUri);
  const writes = req.scope === 'read-write';

  return (
    <main style={{ maxWidth: 560, margin: '4rem auto', padding: '0 1.5rem', fontFamily: 'system-ui, sans-serif', lineHeight: 1.55 }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: '0.5rem' }}>
        Connect an application to AirChat?
      </h1>
      <p style={{ color: '#666', marginBottom: '1.5rem' }}>
        Signed in as <strong>{user.email}</strong>.
      </p>

      <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: '1rem 1.25rem', marginBottom: '1rem' }}>
        <p style={{ margin: 0, fontSize: '0.85rem', color: '#666' }}>Access will be sent to</p>
        <p style={{ margin: '0.15rem 0 0', fontSize: '1.25rem', fontWeight: 700, wordBreak: 'break-all' }}>
          {target.host}
        </p>
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem', color: '#333', wordBreak: 'break-word' }}>
          The application calls itself <strong>&ldquo;{clientLabel}&rdquo;</strong>.
        </p>
        {target.verified ? (
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.9rem', color: '#1a7f37' }}>
            This address belongs to a known application.
          </p>
        ) : (
          <p
            role="alert"
            style={{ margin: '0.75rem 0 0', padding: '0.6rem 0.75rem', fontSize: '0.9rem', background: '#fff8c5', border: '1px solid #d4a72c', borderRadius: 6, color: '#4d2d00' }}
          >
            <strong>Unverified application.</strong>{' '}
            {target.loopback
              ? 'It says it is a program running on this computer. '
              : 'Anyone can register an application under any name. '}
            Only continue if you started this connection yourself and recognise the address above.
          </p>
        )}
      </div>

      <div style={{ border: `1px solid ${writes ? '#d4a72c' : '#ddd'}`, borderRadius: 8, padding: '1rem 1.25rem', marginBottom: '1.5rem' }}>
        <p style={{ margin: 0, fontWeight: 600 }}>
          Access requested:{' '}
          <span style={{ padding: '0.1rem 0.5rem', borderRadius: 999, fontSize: '0.85rem', color: '#1f2328', background: writes ? '#fff8c5' : '#ddf4ff', border: `1px solid ${writes ? '#d4a72c' : '#54aeff'}` }}>
            {SCOPE_LABEL[req.scope] ?? req.scope}
          </span>
        </p>
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
