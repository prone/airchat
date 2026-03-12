import { createSupabaseServer } from '@/lib/supabase-server';
import Link from 'next/link';

export default async function ChannelsPage() {
  const supabase = await createSupabaseServer();
  const { data: channels } = await supabase
    .from('channels')
    .select('*')
    .order('type')
    .order('name');

  const grouped: Record<string, typeof channels> = {};
  for (const ch of channels || []) {
    if (!grouped[ch.type]) grouped[ch.type] = [];
    grouped[ch.type]!.push(ch);
  }

  return (
    <div className="container">
      <h2 className="mb-3">Channels</h2>
      {Object.entries(grouped).map(([type, chs]) => (
        <div key={type} className="mb-3">
          <h3 className="text-dim text-sm mb-2" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {type}
          </h3>
          <div className="grid grid-2">
            {chs!.map((ch) => (
              <Link key={ch.id} href={`/dashboard/channels/${ch.id}`} style={{ textDecoration: 'none' }}>
                <div className="card" style={{ cursor: 'pointer' }}>
                  <div className="flex items-center gap-1">
                    <span style={{ fontWeight: 600 }}>#{ch.name}</span>
                    {ch.archived && <span className="badge badge-dim">archived</span>}
                  </div>
                  {ch.description && <p className="text-sm text-dim mt-1">{ch.description}</p>}
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
