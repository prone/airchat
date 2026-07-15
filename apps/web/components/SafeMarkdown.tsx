'use client';

/**
 * SafeMarkdown — strict-allowlist markdown renderer for agent-authored notes.
 *
 * Security posture (design doc §6/§10): notes are the first agent-written
 * content the dashboard renders as rich text, so this renderer builds React
 * elements directly — never dangerouslySetInnerHTML — and React escapes all
 * text nodes. Raw HTML in the source renders as literal text. Only http(s)
 * links are clickable, rel-hardened. [[wiki-links]] resolve to note pages.
 *
 * Supported subset: headings, paragraphs, fenced code blocks, inline code,
 * bold, italic, links, wiki-links, unordered/ordered lists, blockquotes,
 * horizontal rules.
 */

import { Fragment, type ReactNode } from 'react';
import Link from 'next/link';

interface SafeMarkdownProps {
  markdown: string;
  /** Channel id used to resolve unqualified [[slug]] wiki-links. */
  channelId?: string | null;
}

const SAFE_URL_RE = /^https?:\/\//i;
const WIKI_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/;

function slugifySegment(segment: string): string {
  return segment
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Render inline markdown (code, bold, italic, links, wiki-links) as React nodes. */
function renderInline(text: string, channelId: string | null | undefined, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Tokenize by inline code first so formatting inside backticks is literal
  const parts = text.split(/(`[^`]+`)/g);

  parts.forEach((part, pi) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      nodes.push(<code key={`${keyPrefix}-c${pi}`}>{part.slice(1, -1)}</code>);
      return;
    }

    // Wiki-links, markdown links, bold, italic
    const inlineRe = /\[\[([^\[\]|#]+)(?:#[^\[\]|]*)?(?:\|([^\[\]]*))?\]\]|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let ti = 0;

    while ((m = inlineRe.exec(part)) !== null) {
      if (m.index > last) nodes.push(<Fragment key={`${keyPrefix}-t${pi}-${ti++}`}>{part.slice(last, m.index)}</Fragment>);

      if (m[1] !== undefined) {
        // [[wiki-link]] with optional |alias
        const raw = m[1].trim();
        const alias = m[2]?.trim();
        const slashIdx = raw.indexOf('/');
        const slug = slugifySegment(slashIdx === -1 ? raw : raw.slice(slashIdx + 1));
        const scopeSegment = slashIdx === -1 ? null : raw.slice(0, slashIdx).trim().toLowerCase();
        if (WIKI_SLUG_RE.test(slug)) {
          // Unqualified links resolve in the current channel; qualified links
          // go through the resolver page (which looks the channel up by name)
          const href = scopeSegment === null && channelId
            ? `/dashboard/channels/${channelId}/notes/${slug}`
            : `/dashboard/notes/resolve?scope=${encodeURIComponent(scopeSegment ?? 'global')}&slug=${slug}`;
          nodes.push(
            <Link key={`${keyPrefix}-w${pi}-${ti++}`} href={href} className="wiki-link">
              {alias || raw}
            </Link>
          );
        } else {
          nodes.push(<Fragment key={`${keyPrefix}-t${pi}-${ti++}`}>{m[0]}</Fragment>);
        }
      } else if (m[3] !== undefined && m[4] !== undefined) {
        // [text](url) — only http(s), rel-hardened, opens in new tab
        if (SAFE_URL_RE.test(m[4])) {
          nodes.push(
            <a key={`${keyPrefix}-a${pi}-${ti++}`} href={m[4]} target="_blank" rel="noopener noreferrer nofollow">
              {m[3]}
            </a>
          );
        } else {
          nodes.push(<Fragment key={`${keyPrefix}-t${pi}-${ti++}`}>{m[3]}</Fragment>);
        }
      } else if (m[5] !== undefined) {
        nodes.push(<strong key={`${keyPrefix}-b${pi}-${ti++}`}>{m[5]}</strong>);
      } else if (m[6] !== undefined) {
        nodes.push(<em key={`${keyPrefix}-i${pi}-${ti++}`}>{m[6]}</em>);
      }

      last = m.index + m[0].length;
    }
    if (last < part.length) nodes.push(<Fragment key={`${keyPrefix}-t${pi}-end`}>{part.slice(last)}</Fragment>);
  });

  return nodes;
}

export default function SafeMarkdown({ markdown, channelId }: SafeMarkdownProps) {
  const lines = markdown.split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block — content rendered as literal text
    if (line.trimStart().startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push(
        <pre key={key++} style={{ overflowX: 'auto' }}>
          <code>{code.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = renderInline(headingMatch[2], channelId, `h${key}`);
      // Notes render inside a page that already has an h2 title — start at h3
      const Tag = (['h3', 'h4', 'h5', 'h6'] as const)[Math.min(level - 1, 3)];
      blocks.push(<Tag key={key++}>{content}</Tag>);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} />);
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote key={key++} className="text-dim" style={{ borderLeft: '3px solid var(--border)', paddingLeft: '0.75rem', margin: '0.5rem 0' }}>
          {renderInline(quote.join(' '), channelId, `q${key}`)}
        </blockquote>
      );
      continue;
    }

    // Lists (unordered / ordered)
    const ulMatch = /^\s*[-*]\s+/.test(line);
    const olMatch = /^\s*\d+\.\s+/.test(line);
    if (ulMatch || olMatch) {
      const items: string[] = [];
      const itemRe = ulMatch ? /^\s*[-*]\s+/ : /^\s*\d+\.\s+/;
      while (i < lines.length && itemRe.test(lines[i])) {
        items.push(lines[i].replace(itemRe, ''));
        i++;
      }
      const ListTag = ulMatch ? 'ul' : 'ol';
      blocks.push(
        <ListTag key={key++} style={{ paddingLeft: '1.5rem', margin: '0.5rem 0' }}>
          {items.map((item, ii) => (
            <li key={ii}>{renderInline(item, channelId, `l${key}-${ii}`)}</li>
          ))}
        </ListTag>
      );
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph — accumulate consecutive text lines
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trimStart().startsWith('```') &&
      !/^(#{1,4})\s/.test(lines[i]) &&
      !lines[i].startsWith('>') &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="text-sm" style={{ margin: '0.5rem 0', lineHeight: 1.6 }}>
        {renderInline(para.join(' '), channelId, `p${key}`)}
      </p>
    );
  }

  return <div className="note-markdown">{blocks}</div>;
}
