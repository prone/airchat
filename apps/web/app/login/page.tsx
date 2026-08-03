'use client';

import { Suspense, useState } from 'react';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import { useRouter, useSearchParams } from 'next/navigation';

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const supabase = createSupabaseBrowser();
    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      // Honour ?next=, so a flow that sent the user here to sign in gets them
      // back. The OAuth authorize endpoint does exactly that, and without this
      // a user completed the login and landed on the dashboard with the
      // authorization request silently abandoned.
      //
      // Only same-origin relative paths are followed. An absolute URL here
      // would make the login page an open redirect: anyone could send a link
      // that authenticates a user and then bounces them somewhere hostile.
      const next = searchParams.get('next');
      const safe = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
      router.push(safe);
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
      <div className="card" style={{ width: 400 }}>
        <h1 style={{ marginBottom: '1.5rem' }}>AirChat</h1>
        <form onSubmit={handleLogin} className="flex flex-col gap-2">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <p style={{ color: 'var(--danger)', fontSize: '0.875rem' }}>{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * useSearchParams opts a page into client-side rendering, which Next requires
 * to sit behind a Suspense boundary so the rest of the page can still be
 * prerendered. Without this the build fails outright on /login.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
