import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy, newNonce } from '@/lib/csp';

/**
 * Runs for every page (see `config.matcher`). Two jobs:
 *
 *  1. Give the page a Content-Security-Policy with a nonce made for this one
 *     response. The policy is set on the request as well as the response:
 *     Next.js reads it from the request to learn the nonce and puts it on the
 *     scripts it writes.
 *  2. For /dashboard and /login, refresh the Supabase session and send the
 *     visitor to the right one of the two.
 */
export async function middleware(request: NextRequest) {
  const nonce = newNonce();
  const csp = contentSecurityPolicy(process.env.NODE_ENV === 'production', nonce);

  // The request as the page will see it: whatever cookies have been set on it
  // so far, plus the nonce and the policy.
  const forward = () => {
    const headers = new Headers(request.headers);
    headers.set('x-nonce', nonce);
    headers.set('Content-Security-Policy', csp);
    const response = NextResponse.next({ request: { headers } });
    response.headers.set('Content-Security-Policy', csp);
    return response;
  };

  const { pathname } = request.nextUrl;
  if (!pathname.startsWith('/dashboard') && pathname !== '/login') return forward();

  let supabaseResponse = forward();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: any }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = forward();
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh the session
  const { data: { user } } = await supabase.auth.getUser();

  // Redirect unauthenticated users away from dashboard
  if (!user && pathname.startsWith('/dashboard')) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // Redirect authenticated users away from login
  if (user && pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    // Every page. Not the API, the MCP endpoint, the discovery documents or
    // Next.js's own files: none of those is a page, and they keep the fixed
    // policy from next.config.ts. Prefetches are skipped because a prefetched
    // page is rendered again, with its own nonce, when it is opened.
    {
      source: '/((?!api/|mcp$|\\.well-known/|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
