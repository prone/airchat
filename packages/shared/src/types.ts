export type ChannelType = 'project' | 'technology' | 'environment' | 'global';
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
          description?: string | null;
          metadata?: Record<string, unknown> | null;
          created_by?: string | null;
          archived?: boolean;
        };
        Update: {
          name?: string;
          type?: ChannelType;
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
        };
        Update: {
          channel_id?: string;
          author_agent_id?: string;
          content?: string;
          metadata?: Record<string, unknown> | null;
          parent_message_id?: string | null;
          pinned?: boolean;
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
      membership_role: MembershipRole;
    };
    CompositeTypes: {};
  };
}
