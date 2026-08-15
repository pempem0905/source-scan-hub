export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      api_usage: {
        Row: {
          cost_usd: number
          created_at: string
          credits: number
          id: string
          metadata: Json
          provider: string
          requests: number
          updated_at: string
          usage_date: string
        }
        Insert: {
          cost_usd?: number
          created_at?: string
          credits?: number
          id?: string
          metadata?: Json
          provider: string
          requests?: number
          updated_at?: string
          usage_date?: string
        }
        Update: {
          cost_usd?: number
          created_at?: string
          credits?: number
          id?: string
          metadata?: Json
          provider?: string
          requests?: number
          updated_at?: string
          usage_date?: string
        }
        Relationships: []
      }
      discovery_edges: {
        Row: {
          canonical_url: string | null
          confidence: number | null
          created_at: string
          discovered_url: string | null
          edge_type: string
          final_url: string | null
          from_source_id: string | null
          id: string
          to_candidate_id: string | null
        }
        Insert: {
          canonical_url?: string | null
          confidence?: number | null
          created_at?: string
          discovered_url?: string | null
          edge_type?: string
          final_url?: string | null
          from_source_id?: string | null
          id?: string
          to_candidate_id?: string | null
        }
        Update: {
          canonical_url?: string | null
          confidence?: number | null
          created_at?: string
          discovered_url?: string | null
          edge_type?: string
          final_url?: string | null
          from_source_id?: string | null
          id?: string
          to_candidate_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "discovery_edges_from_source_id_fkey"
            columns: ["from_source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "discovery_edges_to_candidate_id_fkey"
            columns: ["to_candidate_id"]
            isOneToOne: false
            referencedRelation: "source_candidates"
            referencedColumns: ["id"]
          },
        ]
      }
      merchants: {
        Row: {
          category: string | null
          created_at: string
          id: string
          market: string
          name: string
          normalized_name: string | null
          official_domain: string | null
          status: string
          updated_at: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          id?: string
          market?: string
          name: string
          normalized_name?: string | null
          official_domain?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          category?: string | null
          created_at?: string
          id?: string
          market?: string
          name?: string
          normalized_name?: string | null
          official_domain?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      scan_jobs: {
        Row: {
          attempts: number
          created_at: string
          error: string | null
          finished_at: string | null
          id: string
          job_type: string
          lane: string | null
          max_attempts: number
          payload: Json
          priority: number
          scheduled_at: string
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          job_type: string
          lane?: string | null
          max_attempts?: number
          payload?: Json
          priority?: number
          scheduled_at?: string
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          job_type?: string
          lane?: string | null
          max_attempts?: number
          payload?: Json
          priority?: number
          scheduled_at?: string
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      scan_queue: {
        Row: {
          available_at: string
          created_at: string
          id: string
          job_id: string | null
          lane: string | null
          locked_at: string | null
          locked_by: string | null
          priority: number
          status: string
          target_domain: string | null
          target_url: string | null
          updated_at: string
        }
        Insert: {
          available_at?: string
          created_at?: string
          id?: string
          job_id?: string | null
          lane?: string | null
          locked_at?: string | null
          locked_by?: string | null
          priority?: number
          status?: string
          target_domain?: string | null
          target_url?: string | null
          updated_at?: string
        }
        Update: {
          available_at?: string
          created_at?: string
          id?: string
          job_id?: string | null
          lane?: string | null
          locked_at?: string | null
          locked_by?: string | null
          priority?: number
          status?: string
          target_domain?: string | null
          target_url?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "scan_queue_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "scan_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      source_candidates: {
        Row: {
          authority_score: number
          canonical_domain: string | null
          canonical_url: string | null
          created_at: string
          discovered_at: string
          discovered_via: string | null
          domain: string | null
          error_count: number
          http_status: number | null
          id: string
          is_official: boolean
          is_radar: boolean
          last_scan_at: string | null
          market: string
          merchant_id: string | null
          normalized_url: string | null
          notes: string | null
          resolution_status: string
          source_type: string
          status: string
          updated_at: string
          url: string
          verified_at: string | null
          yield_score: number
        }
        Insert: {
          authority_score?: number
          canonical_domain?: string | null
          canonical_url?: string | null
          created_at?: string
          discovered_at?: string
          discovered_via?: string | null
          domain?: string | null
          error_count?: number
          http_status?: number | null
          id?: string
          is_official?: boolean
          is_radar?: boolean
          last_scan_at?: string | null
          market?: string
          merchant_id?: string | null
          normalized_url?: string | null
          notes?: string | null
          resolution_status?: string
          source_type?: string
          status?: string
          updated_at?: string
          url: string
          verified_at?: string | null
          yield_score?: number
        }
        Update: {
          authority_score?: number
          canonical_domain?: string | null
          canonical_url?: string | null
          created_at?: string
          discovered_at?: string
          discovered_via?: string | null
          domain?: string | null
          error_count?: number
          http_status?: number | null
          id?: string
          is_official?: boolean
          is_radar?: boolean
          last_scan_at?: string | null
          market?: string
          merchant_id?: string | null
          normalized_url?: string | null
          notes?: string | null
          resolution_status?: string
          source_type?: string
          status?: string
          updated_at?: string
          url?: string
          verified_at?: string | null
          yield_score?: number
        }
        Relationships: [
          {
            foreignKeyName: "source_candidates_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      source_events: {
        Row: {
          candidate_id: string | null
          created_at: string
          event_type: string
          id: string
          payload: Json
          source_id: string | null
        }
        Insert: {
          candidate_id?: string | null
          created_at?: string
          event_type: string
          id?: string
          payload?: Json
          source_id?: string | null
        }
        Update: {
          candidate_id?: string | null
          created_at?: string
          event_type?: string
          id?: string
          payload?: Json
          source_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "source_events_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "source_candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_events_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["id"]
          },
        ]
      }
      sources: {
        Row: {
          authority_score: number
          canonical_domain: string | null
          canonical_url: string | null
          created_at: string
          discovered_at: string
          discovered_via: string | null
          domain: string
          error_count: number
          http_status: number | null
          id: string
          is_official: boolean
          is_radar: boolean
          last_scan_at: string | null
          market: string
          merchant_id: string | null
          normalized_url: string | null
          notes: string | null
          resolution_status: string
          source_type: string
          status: string
          updated_at: string
          url: string
          verified_at: string | null
          yield_score: number
        }
        Insert: {
          authority_score?: number
          canonical_domain?: string | null
          canonical_url?: string | null
          created_at?: string
          discovered_at?: string
          discovered_via?: string | null
          domain: string
          error_count?: number
          http_status?: number | null
          id?: string
          is_official?: boolean
          is_radar?: boolean
          last_scan_at?: string | null
          market?: string
          merchant_id?: string | null
          normalized_url?: string | null
          notes?: string | null
          resolution_status?: string
          source_type: string
          status?: string
          updated_at?: string
          url: string
          verified_at?: string | null
          yield_score?: number
        }
        Update: {
          authority_score?: number
          canonical_domain?: string | null
          canonical_url?: string | null
          created_at?: string
          discovered_at?: string
          discovered_via?: string | null
          domain?: string
          error_count?: number
          http_status?: number | null
          id?: string
          is_official?: boolean
          is_radar?: boolean
          last_scan_at?: string | null
          market?: string
          merchant_id?: string | null
          normalized_url?: string | null
          notes?: string | null
          resolution_status?: string
          source_type?: string
          status?: string
          updated_at?: string
          url?: string
          verified_at?: string | null
          yield_score?: number
        }
        Relationships: [
          {
            foreignKeyName: "sources_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
        ]
      }
      system_config: {
        Row: {
          description: string | null
          id: string
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          description?: string | null
          id?: string
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          description?: string | null
          id?: string
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      worker_stats: {
        Row: {
          created_at: string
          current_job_id: string | null
          errors_total: number
          id: string
          lane: string | null
          last_heartbeat: string
          metadata: Json
          qualified_sources_total: number
          rate_403: number
          rate_429: number
          requests_total: number
          status: string
          updated_at: string
          worker_id: string
        }
        Insert: {
          created_at?: string
          current_job_id?: string | null
          errors_total?: number
          id?: string
          lane?: string | null
          last_heartbeat?: string
          metadata?: Json
          qualified_sources_total?: number
          rate_403?: number
          rate_429?: number
          requests_total?: number
          status?: string
          updated_at?: string
          worker_id: string
        }
        Update: {
          created_at?: string
          current_job_id?: string | null
          errors_total?: number
          id?: string
          lane?: string | null
          last_heartbeat?: string
          metadata?: Json
          qualified_sources_total?: number
          rate_403?: number
          rate_429?: number
          requests_total?: number
          status?: string
          updated_at?: string
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_stats_current_job_id_fkey"
            columns: ["current_job_id"]
            isOneToOne: false
            referencedRelation: "scan_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_scan_queue_item: {
        Args: { p_lane?: string; p_worker_id: string }
        Returns: {
          available_at: string
          created_at: string
          id: string
          job_id: string | null
          lane: string | null
          locked_at: string | null
          locked_by: string | null
          priority: number
          status: string
          target_domain: string | null
          target_url: string | null
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "scan_queue"
          isOneToOne: false
          isSetofReturn: true
        }
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
