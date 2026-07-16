'use client';

/**
 * Garden graph — the Obsidian-style view of the knowledge layer.
 * Nodes are notes (sized by backlink count, colored by provenance:
 * agent / human / summarizer); edges are note→note wiki-links. Message→note
 * links contribute to node size but are not drawn as edges. Click a node to
 * open the note. Channel filter up top.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowser } from '@/lib/supabase-browser';
import {
  forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide,
  type SimulationNodeDatum,
} from 'd3-force';
import { INK, PROVENANCE, legendEntries, type ProvenanceKind } from '@/components/viz/viz';

interface GraphNode extends SimulationNodeDatum {
  id: string;            // note id
  slug: string;
  title: string;
  channelId: string | null;
  channelName: string;
  kind: ProvenanceKind;
  isStub: boolean;
  backlinks: number;
}

interface GraphEdge {
  source: string;
  target: string;
}

export default function GraphPage() {
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const router = useRouter();
  const svgRef = useRef<SVGSVGElement>(null);
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([]);
  const [channelFilter, setChannelFilter] = useState<string>('');
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<Array<{ source: GraphNode; target: GraphNode }>>([]);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const [empty, setEmpty] = useState(false);

  const W = 900;
  const H = 560;

  useEffect(() => {
    supabase.from('channels').select('id, name').order('name').then(({ data }) => {
      if (data) setChannels(data);
    });
  }, [supabase]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      let notesQuery = supabase
        .from('notes')
        .select('id, slug, title, channel_id, is_stub, properties, updated_by_user_email, channels:channel_id(name), agents:updated_by(name)')
        .limit(400);
      if (channelFilter) notesQuery = notesQuery.eq('channel_id', channelFilter);
      const { data: noteRows } = await notesQuery;

      const { data: linkRows } = await supabase
        .from('note_links')
        .select('source_type, source_id, target_channel_id, target_slug')
        .limit(2000);

      if (cancelled || !noteRows) return;

      const bySlugScope = new Map<string, GraphNode>();
      const byId = new Map<string, GraphNode>();
      const graphNodes: GraphNode[] = noteRows.map((n: any) => {
        const kind: ProvenanceKind = n.properties?.kind === 'daily-digest' || n.agents?.name === 'summarizer'
          ? 'summarizer'
          : n.updated_by_user_email ? 'human' : 'agent';
        const node: GraphNode = {
          id: n.id, slug: n.slug, title: n.title,
          channelId: n.channel_id, channelName: n.channels?.name ?? 'global',
          kind, isStub: n.is_stub, backlinks: 0,
        };
        bySlugScope.set(`${n.channel_id ?? 'global'}/${n.slug}`, node);
        byId.set(n.id, node);
        return node;
      });

      const graphEdges: GraphEdge[] = [];
      for (const l of (linkRows as any[]) ?? []) {
        const target = bySlugScope.get(`${l.target_channel_id ?? 'global'}/${l.target_slug}`);
        if (!target) continue;
        target.backlinks++;
        if (l.source_type === 'note') {
          const source = byId.get(l.source_id);
          if (source && source.id !== target.id) {
            graphEdges.push({ source: source.id, target: target.id });
          }
        }
      }

      setEmpty(graphNodes.length === 0);

      // Run the simulation to completion synchronously, then render static
      const sim = forceSimulation(graphNodes)
        .force('link', forceLink<GraphNode, any>(graphEdges.map((e) => ({ ...e }))).id((d) => d.id).distance(70))
        .force('charge', forceManyBody().strength(-120))
        .force('center', forceCenter(W / 2, H / 2))
        .force('collide', forceCollide<GraphNode>().radius((d) => nodeRadius(d) + 14))
        .stop();
      for (let i = 0; i < 200; i++) sim.tick();

      const resolvedEdges = graphEdges
        .map((e) => ({ source: byId.get(e.source)!, target: byId.get(e.target)! }))
        .filter((e) => e.source && e.target);

      if (!cancelled) {
        setNodes([...graphNodes]);
        setEdges(resolvedEdges);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [supabase, channelFilter]);

  function nodeRadius(n: GraphNode): number {
    return Math.min(6 + n.backlinks * 2, 18);
  }

  return (
    <div className="container">
      <div className="mb-3 flex items-center justify-between">
        <h2>Garden graph</h2>
        <div className="flex items-center gap-1">
          <Link href="/dashboard/overview" className="text-sm">← overview</Link>
        </div>
      </div>

      <div className="filter-bar mb-3" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)} className="filter-select">
          <option value="">All channels</option>
          {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
        </select>
        <div style={{ display: 'flex', gap: 12 }}>
          {legendEntries(['agent', 'human', 'summarizer']).map((l) => (
            <span key={l.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.6875rem', color: INK.secondary }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: l.color, display: 'inline-block' }} />
              {l.label}
            </span>
          ))}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.6875rem', color: INK.secondary }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', border: `1.5px dashed ${INK.muted}`, display: 'inline-block' }} />
            stub
          </span>
        </div>
      </div>

      {empty && <p className="text-dim">No notes yet — the garden graph grows as agents write notes and link them with [[wiki-links]].</p>}

      <div className="card" style={{ padding: 8, overflowX: 'auto' }}>
        <svg ref={svgRef} width={W} height={H} role="img" aria-label="Graph of notes connected by wiki-links">
          {edges.map((e, i) => (
            <line
              key={i}
              x1={e.source.x} y1={e.source.y} x2={e.target.x} y2={e.target.y}
              stroke={INK.grid} strokeWidth={1.5}
            />
          ))}
          {nodes.map((n) => (
            <g
              key={n.id}
              transform={`translate(${n.x},${n.y})`}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHovered(n)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => {
                if (n.channelId) router.push(`/dashboard/channels/${n.channelId}/notes/${n.slug}`);
                else router.push(`/dashboard/notes/resolve?scope=global&slug=${n.slug}`);
              }}
            >
              {/* 2px surface ring so overlapping nodes stay separable */}
              <circle
                r={nodeRadius(n)}
                fill={n.isStub ? 'transparent' : PROVENANCE[n.kind].color}
                stroke={n.isStub ? INK.muted : '#141414'}
                strokeWidth={2}
                strokeDasharray={n.isStub ? '3 2' : undefined}
              />
              {(nodeRadius(n) > 9 || hovered?.id === n.id) && (
                <text y={nodeRadius(n) + 12} textAnchor="middle" fontSize={10} fill={INK.secondary}>
                  {n.slug.length > 24 ? n.slug.slice(0, 22) + '…' : n.slug}
                </text>
              )}
              <title>{`${n.title}\n#${n.channelName} · ${PROVENANCE[n.kind].label}${n.isStub ? ' · stub' : ''}\n${n.backlinks} backlink${n.backlinks === 1 ? '' : 's'}`}</title>
            </g>
          ))}
        </svg>
      </div>

      {hovered && (
        <p className="text-xs" style={{ color: INK.secondary, marginTop: 8 }}>
          <strong>{hovered.title}</strong> — #{hovered.channelName} · {PROVENANCE[hovered.kind].label} · {hovered.backlinks} backlinks
        </p>
      )}
    </div>
  );
}
