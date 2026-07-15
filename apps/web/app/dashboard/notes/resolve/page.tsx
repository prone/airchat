'use client';

/**
 * Resolver for qualified wiki-links ([[channel/slug]] and [[global/slug]]):
 * looks the channel up by name, then redirects to the note page. Global-scope
 * notes have no channel page yet in Phase 1, so they render inline here.
 */

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import SafeMarkdown from '@/components/SafeMarkdown';

interface GlobalNote {
  slug: string;
  title: string;
  body_md: string;
  is_stub: boolean;
  current_revision: number;
  updated_at: string;
}

function ResolveInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const scope = searchParams.get('scope') ?? 'global';
  const slug = searchParams.get('slug') ?? '';
  const [status, setStatus] = useState<'loading' | 'not_found'>('loading');
  const [globalNote, setGlobalNote] = useState<GlobalNote | null>(null);
  const supabase = createSupabaseBrowser();

  useEffect(() => {
    async function resolve() {
      if (!/^[a-z0-9][a-z0-9-]{0,199}$/.test(slug)) {
        setStatus('not_found');
        return;
      }

      if (scope === 'global') {
        const { data } = await supabase
          .from('notes')
          .select('slug, title, body_md, is_stub, current_revision, updated_at')
          .is('channel_id', null)
          .eq('slug', slug)
          .single();
        if (data) setGlobalNote(data as GlobalNote);
        else setStatus('not_found');
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

  if (globalNote) {
    return (
      <div className="container">
        <div className="mb-3">
          <h2>{globalNote.title}</h2>
          <span className="text-xs text-dim">
            global/{globalNote.slug} · rev {globalNote.current_revision} · updated{' '}
            {new Date(globalNote.updated_at).toLocaleString()}
          </span>
        </div>
        {globalNote.is_stub ? (
          <p className="text-dim">This is an unfilled stub.</p>
        ) : (
          <SafeMarkdown markdown={globalNote.body_md} />
        )}
      </div>
    );
  }

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
