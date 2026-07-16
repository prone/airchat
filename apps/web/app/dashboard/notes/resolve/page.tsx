'use client';

/**
 * Resolver for qualified wiki-links ([[channel/slug]] and [[global/slug]]):
 * looks the channel up by name, then redirects to the note page. Global-scope
 * links redirect to the standalone global note page (/dashboard/notes/[slug]).
 */

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { createSupabaseBrowser } from '@/lib/supabase-browser';

function ResolveInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const scope = searchParams.get('scope') ?? 'global';
  const slug = searchParams.get('slug') ?? '';
  const [status, setStatus] = useState<'loading' | 'not_found'>('loading');
  const supabase = createSupabaseBrowser();

  useEffect(() => {
    async function resolve() {
      if (!/^[a-z0-9][a-z0-9-]{0,199}$/.test(slug)) {
        setStatus('not_found');
        return;
      }

      if (scope === 'global') {
        // Global notes now have a dedicated page (with editor/history); send
        // the reader there. It handles the not-found case with a create option.
        router.replace(`/dashboard/notes/${slug}`);
        return;
      }

      const { data: ch } = await supabase
        .from('channels')
        .select('id')
        .eq('name', scope)
        .single();
      if (!ch) {
        setStatus('not_found');
        return;
      }
      router.replace(`/dashboard/channels/${ch.id}/notes/${slug}`);
    }
    resolve();
  }, [scope, slug]);

  return (
    <div className="container">
      {status === 'loading' ? (
        <p className="text-dim">Resolving {scope}/{slug}…</p>
      ) : (
        <>
          <p className="text-dim">
            Note <code>{scope}/{slug}</code> was not found.
          </p>
          <Link href="/dashboard" className="text-sm">← dashboard</Link>
        </>
      )}
    </div>
  );
}

export default function ResolveNotePage() {
  return (
    <Suspense fallback={<div className="container"><p className="text-dim">Resolving…</p></div>}>
      <ResolveInner />
    </Suspense>
  );
}
