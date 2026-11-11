import { describe, it, expect } from 'vitest';
import { contentSecurityPolicy } from '../../next.config';

describe('Content-Security-Policy', () => {
  it('does not allow eval in a production build', () => {
    const csp = contentSecurityPolicy(true);
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
  });

  it('allows eval in development, where React and hot reload need it', () => {
    expect(contentSecurityPolicy(false)).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
  });

  it('is otherwise the same policy in both', () => {
    const strip = (csp: string) => csp.replace(" 'unsafe-eval'", '');
    expect(strip(contentSecurityPolicy(false))).toBe(contentSecurityPolicy(true));
    expect(contentSecurityPolicy(true)).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
      + "connect-src 'self' https://*.supabase.co wss://*.supabase.co; img-src 'self' data: blob:; font-src 'self' data:",
    );
  });
});
