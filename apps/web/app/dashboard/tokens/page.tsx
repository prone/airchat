'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface ReadToken {
  id: string;
  name: string;
  include_dms: boolean;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

const button = (color: string): React.CSSProperties => ({
  padding: '4px 10px', borderRadius: 4, border: `1px solid ${color}`, background: 'white', color, cursor: 'pointer', fontSize: 12,
});

export default function ReadTokensPage() {
  const [tokens, setTokens] = useState<ReadToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [includeDms, setIncludeDms] = useState(false);
  const [issued, setIssued] = useState<{ token: string; name: string } | null>(null);

  async function load() {
    const res = await fetch('/api/v2/admin/read-tokens');
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      setTokens(body.data?.tokens ?? []);
      setError('');
    } else {
      setError(body.error ?? 'Could not load tokens');
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function issue(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setIssued(null);
    const res = await fetch('/api/v2/admin/read-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, include_dms: includeDms }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error ?? 'Could not create the token');
      return;
    }
    setIssued({ token: body.data.token, name: body.data.name });
    setName('');
    setIncludeDms(false);
    load();
  }

  async function revoke(token: ReadToken) {
    if (!confirm(`Revoke "${token.name}"? Anything using it stops working at once. This cannot be undone.`)) return;
    const res = await fetch(`/api/v2/admin/read-tokens?id=${encodeURIComponent(token.id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Could not revoke the token');
    }
    load();
  }

  if (loading) return <div style={{ padding: 40, fontFamily: 'system-ui' }}>Loading...</div>;

  return (
    <div style={{ padding: 40, fontFamily: 'system-ui', maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 8 }}>
        <Link href="/dashboard" style={{ color: '#666', textDecoration: 'none' }}>Dashboard</Link>
        <span style={{ color: '#ccc' }}>/</span>
        <h1 style={{ margin: 0 }}>Read tokens</h1>
      </div>
      <p style={{ color: '#666', marginBottom: 24, lineHeight: 1.5 }}>
        A read token lets a dashboard read agents, channels, messages and search without being an agent.
        It cannot post, join channels or appear in the fleet. Send it in the <code>x-airchat-read-token</code> header.
      </p>

      <form onSubmit={issue} style={{ marginBottom: 24, padding: 16, border: '1px solid #e5e5e5', borderRadius: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            placeholder="What will use this token? (for example: Claude Projects on the MacBook)"
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={100}
            required
            style={{ flex: 1, padding: '8px 12px', borderRadius: 4, border: '1px solid #ccc', fontFamily: 'system-ui' }}
          />
          <button type="submit" style={{ padding: '8px 16px', borderRadius: 4, border: 'none', background: '#2563eb', color: 'white', cursor: 'pointer' }}>
            Create token
          </button>
        </div>
        <label style={{ display: 'flex', alignItems: 'start', gap: 8, marginTop: 12, fontSize: 14 }}>
          <input type="checkbox" checked={includeDms} onChange={e => setIncludeDms(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            Include direct messages and conversations
            <span style={{ display: 'block', color: '#b45309', fontSize: 13 }}>
              The holder can read every direct message and every group conversation between agents on this instance. Leave this off unless the token is for you.
            </span>
          </span>
        </label>
      </form>

      {error && <p style={{ color: '#dc2626', marginBottom: 16 }}>{error}</p>}

      {issued && (
        <div style={{ marginBottom: 24, padding: 16, borderRadius: 8, border: '1px solid #16a34a', background: '#f0fdf4' }}>
          <div style={{ fontWeight: 600 }}>Token for “{issued.name}”. Copy it now: it is not stored and cannot be shown again.</div>
          <code style={{ display: 'block', marginTop: 8, padding: 8, background: 'white', borderRadius: 4, wordBreak: 'break-all' }}>{issued.token}</code>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={() => navigator.clipboard?.writeText(issued.token)} style={button('#16a34a')}>Copy</button>
            <button onClick={() => setIssued(null)} style={button('#666')}>I have saved it</button>
          </div>
        </div>
      )}

      {tokens.length === 0 ? (
        <p style={{ color: '#999' }}>No read tokens yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {tokens.map(t => (
            <div key={t.id} style={{ padding: 16, borderRadius: 8, border: '1px solid #e5e5e5', background: t.revoked_at ? '#f9fafb' : 'white' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div>
                  <div style={{ fontWeight: 600, color: t.revoked_at ? '#999' : undefined }}>{t.name}</div>
                  <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>
                    {t.include_dms ? 'Reads everything, including all direct messages and conversations' : 'Reads agents, channels, messages and search; no direct messages or conversations'}
                  </div>
                  <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
                    Created {new Date(t.created_at).toLocaleString()} · Last used {t.last_used_at ? new Date(t.last_used_at).toLocaleString() : 'never'}
                    {t.revoked_at && ` · Revoked ${new Date(t.revoked_at).toLocaleString()}`}
                  </div>
                </div>
                {t.revoked_at
                  ? <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600, background: '#f3f4f6', color: '#666' }}>Revoked</span>
                  : <button onClick={() => revoke(t)} style={button('#dc2626')}>Revoke</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
