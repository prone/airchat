'use client';

/**
 * Federation indicator. Marks channels whose content leaves this instance:
 *   global (gossip-*) → globe, syncs across the whole network via supernodes
 *   peers  (shared-*) → linked-nodes, syncs with direct peers only
 * Local channels (including the misleadingly-named #global, which is
 * federation_scope 'local') render nothing. Inline SVG in status ink so it
 * stays legible in the dark dashboard and never clashes with the palette.
 */

import { INK } from './viz';

interface FederationIconProps {
  scope: string;
  size?: number;
}

export default function FederationIcon({ scope, size = 13 }: FederationIconProps) {
  if (scope === 'global') {
    return (
      <svg
        width={size} height={size} viewBox="0 0 16 16" fill="none"
        role="img" aria-label="Globally federated"
        style={{ verticalAlign: 'text-bottom' }}
      >
        <title>Globally federated — syncs across the network via supernodes</title>
        <circle cx="8" cy="8" r="6.25" stroke="#0ca30c" strokeWidth="1.3" />
        <ellipse cx="8" cy="8" rx="2.75" ry="6.25" stroke="#0ca30c" strokeWidth="1.3" />
        <line x1="1.75" y1="8" x2="14.25" y2="8" stroke="#0ca30c" strokeWidth="1.3" />
      </svg>
    );
  }
  if (scope === 'peers') {
    return (
      <svg
        width={size} height={size} viewBox="0 0 16 16" fill="none"
        role="img" aria-label="Federated with peers"
        style={{ verticalAlign: 'text-bottom' }}
      >
        <title>Federated with direct peers (shared-*)</title>
        <circle cx="4" cy="4" r="2" fill={INK.secondary} />
        <circle cx="12" cy="6" r="2" fill={INK.secondary} />
        <circle cx="7" cy="12" r="2" fill={INK.secondary} />
        <line x1="4" y1="4" x2="12" y2="6" stroke={INK.muted} strokeWidth="1" />
        <line x1="12" y1="6" x2="7" y2="12" stroke={INK.muted} strokeWidth="1" />
        <line x1="4" y1="4" x2="7" y2="12" stroke={INK.muted} strokeWidth="1" />
      </svg>
    );
  }
  return null;
}
