export type ChannelType = 'project' | 'technology' | 'environment' | 'global' | 'shared' | 'gossip';
export type FederationScope = 'local' | 'peers' | 'global';
export type MembershipRole = 'member' | 'admin';

export interface Agent {
  id: string;
  name: string;
  api_key_hash: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  permissions: Record<string, unknown> | null;
  machine_id: string | null;
  active: boolean;
  created_at: string;
  last_seen_at: string | null;
}

export interface Channel {
  id: string;
  name: string;
  type: ChannelType;
  federation_scope: FederationScope;
  description: string | null;
  metadata: Record<string, unknown> | null;
  created_by: string | null;
  archived: boolean;
  created_at: string;
}

export interface ChannelMembership {
  agent_id: string;
  channel_id: string;
  role: MembershipRole;
  joined_at: string;
  last_read_at: string | null;
}

export interface Message {
  id: string;
  channel_id: string;
  author_agent_id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  parent_message_id: string | null;
  pinned: boolean;
  safety_labels: string[];
  quarantined: boolean;
  classification: Record<string, unknown> | null;
  origin_instance: string | null;
  author_display: string | null;
  hop_count: number | null;
  created_at: string;
  updated_at: string | null;
}

export interface MessageWithAuthor extends Message {
  agents: Pick<Agent, 'id' | 'name'>;
}

export interface ChannelMembershipWithChannel extends ChannelMembership {
  channels: Channel;
}

export interface SearchResult {
  id: string;
  channel_id: string;
  channel_name: string;
  author_agent_id: string;
  author_name: string;
  content: string;
  created_at: string;
  rank: number;
}

export interface Note {
  id: string;
  slug: string;
  channel_id: string | null;
  title: string;
  body_md: string;
  properties: Record<string, unknown>;
  created_by: string;
  updated_by: string;
  is_stub: boolean;
  protected: boolean;
  current_revision: number;
  created_at: string;
  updated_at: string;
}

export interface NoteRevision {
  id: string;
  note_id: string;
  revision: number;
  title: string;
  body_md: string;
  properties: Record<string, unknown>;
  author_agent_id: string;
  created_at: string;
}

export type NoteLinkSource = 'note' | 'message';

export interface NoteLink {
  id: string;
  source_type: NoteLinkSource;
  source_id: string;
  target_channel_id: string | null;
  target_slug: string;
  created_at: string;
}

/** A backlink resolved with source context for display. */
export interface NoteBacklink {
  source_type: NoteLinkSource;
  source_id: string;
  /** Note slug or message excerpt, depending on source_type. */
  source_label: string;
  channel_name: string | null;
  author_name: string | null;
  created_at: string;
}

export interface NoteSearchResult {
  id: string;
  slug: string;
  channel_id: string | null;
  channel_name: string | null;
  title: string;
  is_stub: boolean;
  updated_at: string;
  rank: number;
}

export interface Mention {
  id: string;
  message_id: string;
  channel_id: string;
  mentioned_agent_id: string;
  mentioning_agent_id: string;
  read: boolean;
  created_at: string;
}

export interface Database {
  public: {
    Tables: {
      agents: {
        Row: Agent;
        Insert: {
          name: string;
          api_key_hash: string;
          description?: string | null;
          metadata?: Record<string, unknown> | null;
          permissions?: Record<string, unknown> | null;
          machine_id?: string | null;
          active?: boolean;
          last_seen_at?: string | null;
        };
        Update: {
          name?: string;
          api_key_hash?: string;
          description?: string | null;
          metadata?: Record<string, unknown> | null;
          permissions?: Record<string, unknown> | null;
          machine_id?: string | null;
          active?: boolean;
          created_at?: string;
          last_seen_at?: string | null;
        };
        Relationships: [];
      };
      channels: {
        Row: Channel;
        Insert: {
          name: string;
          type?: ChannelType;
          federation_scope?: FederationScope;
          description?: string | null;
          metadata?: Record<string, unknown> | null;
          created_by?: string | null;
          archived?: boolean;
        };
        Update: {
          name?: string;
          type?: ChannelType;
          federation_scope?: FederationScope;
          description?: string | null;
          metadata?: Record<string, unknown> | null;
          created_by?: string | null;
          archived?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: 'channels_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'agents';
            referencedColumns: ['id'];
          }
        ];
      };
      channel_memberships: {
        Row: ChannelMembership;
        Insert: {
          agent_id: string;
          channel_id: string;
          role?: MembershipRole;
          last_read_at?: string | null;
        };
        Update: {
          agent_id?: string;
          channel_id?: string;
          role?: MembershipRole;
          joined_at?: string;
          last_read_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'channel_memberships_agent_id_fkey';
            columns: ['agent_id'];
            isOneToOne: false;
            referencedRelation: 'agents';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'channel_memberships_channel_id_fkey';
            columns: ['channel_id'];
            isOneToOne: false;
            referencedRelation: 'channels';
            referencedColumns: ['id'];
          }
        ];
      };
      messages: {
        Row: Message;
        Insert: {
          channel_id: string;
          author_agent_id: string;
          content: string;
          metadata?: Record<string, unknown> | null;
          parent_message_id?: string | null;
          pinned?: boolean;
          safety_labels?: string[];
          quarantined?: boolean;
          classification?: Record<string, unknown> | null;
          origin_instance?: string | null;
          author_display?: string | null;
          hop_count?: number | null;
        };
        Update: {
          channel_id?: string;
          author_agent_id?: string;
          content?: string;
          metadata?: Record<string, unknown> | null;
          parent_message_id?: string | null;
          pinned?: boolean;
          safety_labels?: string[];
          quarantined?: boolean;
          classification?: Record<string, unknown> | null;
          origin_instance?: string | null;
          author_display?: string | null;
          hop_count?: number | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'messages_channel_id_fkey';
            columns: ['channel_id'];
            isOneToOne: false;
            referencedRelation: 'channels';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'messages_author_agent_id_fkey';
            columns: ['author_agent_id'];
            isOneToOne: false;
            referencedRelation: 'agents';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'messages_parent_message_id_fkey';
            columns: ['parent_message_id'];
            isOneToOne: false;
            referencedRelation: 'messages';
            referencedColumns: ['id'];
          }
        ];
      };
    };
    Views: {};
    Functions: {
      search_messages: {
        Args: { query_text: string; channel_filter?: string };
        Returns: SearchResult[];
      };
      send_message_with_auto_join: {
        Args: {
          channel_name: string;
          content: string;
          parent_message_id?: string | null;
          message_metadata?: Record<string, unknown> | null;
        };
        Returns: Message[];
      };
      ensure_channel_membership: {
        Args: { p_channel_id: string };
        Returns: undefined;
      };
      update_last_read: {
        Args: { p_channel_id: string };
        Returns: undefined;
      };
      check_mentions: {
        Args: { only_unread: boolean; mention_limit: number };
        Returns: unknown[];
      };
      mark_mentions_read: {
        Args: { mention_ids: string[] };
        Returns: undefined;
      };
      ensure_agent_exists: {
        Args: { p_agent_name: string };
        Returns: undefined;
      };
    };
    Enums: {
      channel_type: ChannelType;
      federation_scope: FederationScope;
      membership_role: MembershipRole;
    };
    CompositeTypes: {};
  };
}
