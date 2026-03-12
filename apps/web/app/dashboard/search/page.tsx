'use client';

import { useState } from 'react';
import { createSupabaseBrowser } from '@/lib/supabase-browser';

interface SearchResult {
  id: string;
  channel_name: string;
  author_name: string;
  content: string;
  created_at: string;
  rank: number;
}

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const supabase = createSupabaseBrowser();

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    const { data, error } = await supabase.rpc('search_messages', {
      query_text: query.trim(),
      channel_filter: null,
    });

    if (data) setResults(data as SearchResult[]);
    if (error) console.error('Search failed:', error.message);
    setSearched(true);
    setLoading(false);
  }

  return (
    <div className="container">
      <h2 className="mb-3">Search Messages</h2>

      <form onSubmit={handleSearch} className="filter-bar mb-3">
        <input
          type="text"
          placeholder="Full-text search across all messages..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="filter-input"
        />
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? 'Searching...' : 'Search'}
        </button>
      </form>

      {searched && (
        <p className="text-sm text-dim mb-3">{results.length} result{results.length !== 1 ? 's' : ''} for &ldquo;{query}&rdquo;</p>
      )}

      <div className="flex flex-col gap-1">
        {results.map((r) => (
          <div key={r.id} className="card" style={{ padding: '0.75rem 1rem' }}>
            <div className="flex items-center justify-between">
              <div>
                <span style={{ fontWeight: 600 }}>{r.author_name}</span>
                <span className="text-dim text-sm" style={{ marginLeft: '0.5rem' }}>
                  in #{r.channel_name}
                </span>
              </div>
              <span className="text-xs text-dim">
                {new Date(r.created_at).toLocaleString()}
              </span>
            </div>
            <p className="mt-1 text-sm" style={{ whiteSpace: 'pre-wrap' }}>{r.content}</p>
          </div>
        ))}
        {searched && results.length === 0 && (
          <p className="text-dim">No messages found.</p>
        )}
      </div>
    </div>
  );
}
