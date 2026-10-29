// Database types for the Supabase client, matching supabase/migrations.
// Checked field-by-field against `supabase gen types` output for Phase 3 (incl. list views).
// Regenerate after schema changes with:
//   npx supabase gen types typescript --local > src/types/database.ts

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          full_name: string;
          role: Database["public"]["Enums"]["app_role"];
          created_at: string;
        };
        Insert: {
          id: string;
          full_name: string;
          role?: Database["public"]["Enums"]["app_role"];
          created_at?: string;
        };
        Update: {
          id?: string;
          full_name?: string;
          role?: Database["public"]["Enums"]["app_role"];
          created_at?: string;
        };
        Relationships: [];
      };
      clients: {
        Row: {
          id: string;
          owner_id: string;
          name: string;
          email: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          owner_id: string;
          name: string;
          email: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          owner_id?: string;
          name?: string;
          email?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "clients_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      proposals: {
        Row: {
          id: string;
          client_id: string;
          owner_id: string;
          title: string;
          original_storage_path: string | null;
          preview_storage_path: string | null;
          total_pages: number | null;
          free_preview_pages: number | null;
          unlock_price_minor: number | null;
          currency: string | null;
          status: Database["public"]["Enums"]["proposal_status"];
          created_at: string;
          updated_at: string;
          original_file_name: string | null;
          original_size_bytes: number | null;
          link_token_hash: string | null;
          link_created_at: string | null;
          deletion_requested_at: string | null;
          deletion_requested_by: string | null;
          access_mode: "preview" | "full";
          source_storage_path: string | null;
          source_format: "docx" | "doc" | "odt" | "rtf" | "txt" | null;
          source_size_bytes: number | null;
        };
        Insert: {
          id?: string;
          client_id: string;
          owner_id: string;
          title: string;
          original_storage_path?: string | null;
          preview_storage_path?: string | null;
          total_pages?: number | null;
          free_preview_pages?: number | null;
          unlock_price_minor?: number | null;
          currency?: string | null;
          status?: Database["public"]["Enums"]["proposal_status"];
          created_at?: string;
          updated_at?: string;
          original_file_name?: string | null;
          original_size_bytes?: number | null;
          link_token_hash?: string | null;
          link_created_at?: string | null;
          deletion_requested_at?: string | null;
          deletion_requested_by?: string | null;
          access_mode?: "preview" | "full";
          source_storage_path?: string | null;
          source_format?: "docx" | "doc" | "odt" | "rtf" | "txt" | null;
          source_size_bytes?: number | null;
        };
        Update: {
          id?: string;
          client_id?: string;
          owner_id?: string;
          title?: string;
          original_storage_path?: string | null;
          preview_storage_path?: string | null;
          total_pages?: number | null;
          free_preview_pages?: number | null;
          unlock_price_minor?: number | null;
          currency?: string | null;
          status?: Database["public"]["Enums"]["proposal_status"];
          created_at?: string;
          updated_at?: string;
          original_file_name?: string | null;
          original_size_bytes?: number | null;
          link_token_hash?: string | null;
          link_created_at?: string | null;
          deletion_requested_at?: string | null;
          deletion_requested_by?: string | null;
          access_mode?: "preview" | "full";
          source_storage_path?: string | null;
          source_format?: "docx" | "doc" | "odt" | "rtf" | "txt" | null;
          source_size_bytes?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "proposals_client_owner_fkey";
            columns: ["client_id", "owner_id"];
            isOneToOne: false;
            referencedRelation: "clients";
            referencedColumns: ["id", "owner_id"];
          },
          {
            foreignKeyName: "proposals_owner_id_fkey";
            columns: ["owner_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      payments: {
        Row: {
          id: string;
          proposal_id: string;
          provider: string;
          provider_payment_id: string | null;
          amount_minor: number;
          currency: string;
          status: Database["public"]["Enums"]["payment_status"];
          created_at: string;
          updated_at: string;
          owner_id: string;
          client_id: string;
          public_ref: string | null;
          environment: string | null;
          revision_id: string | null;
          original_storage_path: string | null;
          total_pages: number | null;
          free_preview_pages: number | null;
          title_snapshot: string | null;
          client_name_snapshot: string | null;
          owner_name_snapshot: string | null;
          checkout_session_hash: string | null;
          provider_request_id: string;
          provider_order_id: string | null;
          approve_url: string | null;
          payer_email: string | null;
          merchant_id: string | null;
          status_detail: string | null;
          needs_review: boolean;
          review_reason: string | null;
          refunded_amount_minor: number;
          captured_at: string | null;
          verified_at: string | null;
          last_synced_at: string | null;
        };
        Insert: {
          id?: string;
          proposal_id: string;
          provider: string;
          provider_payment_id?: string | null;
          amount_minor: number;
          currency: string;
          status?: Database["public"]["Enums"]["payment_status"];
          created_at?: string;
          updated_at?: string;
          owner_id?: string;
          client_id?: string;
          public_ref?: string | null;
          environment?: string | null;
          revision_id?: string | null;
          original_storage_path?: string | null;
          total_pages?: number | null;
          free_preview_pages?: number | null;
          title_snapshot?: string | null;
          client_name_snapshot?: string | null;
          owner_name_snapshot?: string | null;
          checkout_session_hash?: string | null;
          provider_request_id?: string;
          provider_order_id?: string | null;
          approve_url?: string | null;
          payer_email?: string | null;
          merchant_id?: string | null;
          status_detail?: string | null;
          needs_review?: boolean;
          review_reason?: string | null;
          refunded_amount_minor?: number;
          captured_at?: string | null;
          verified_at?: string | null;
          last_synced_at?: string | null;
        };
        Update: {
          id?: string;
          proposal_id?: string;
          provider?: string;
          provider_payment_id?: string | null;
          amount_minor?: number;
          currency?: string;
          status?: Database["public"]["Enums"]["payment_status"];
          created_at?: string;
          updated_at?: string;
          owner_id?: string;
          client_id?: string;
          public_ref?: string | null;
          environment?: string | null;
          revision_id?: string | null;
          original_storage_path?: string | null;
          total_pages?: number | null;
          free_preview_pages?: number | null;
          title_snapshot?: string | null;
          client_name_snapshot?: string | null;
          owner_name_snapshot?: string | null;
          checkout_session_hash?: string | null;
          provider_request_id?: string;
          provider_order_id?: string | null;
          approve_url?: string | null;
          payer_email?: string | null;
          merchant_id?: string | null;
          status_detail?: string | null;
          needs_review?: boolean;
          review_reason?: string | null;
          refunded_amount_minor?: number;
          captured_at?: string | null;
          verified_at?: string | null;
          last_synced_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "payments_proposal_id_fkey";
            columns: ["proposal_id"];
            isOneToOne: false;
            referencedRelation: "proposals";
            referencedColumns: ["id"];
          },
        ];
      };
      // Manual Full Access grants (audit). Read-only for authenticated (RLS:
      // own or CEO); written only by service_role functions.
      proposal_full_access_grants: {
        Row: {
          id: string;
          proposal_id: string;
          owner_id: string;
          granted_by: string;
          granted_by_name: string | null;
          granted_at: string;
          revision_id: string;
          document_path: string;
          source_format: string | null;
          total_pages: number;
          note: string | null;
          ended_at: string | null;
          ended_by: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: {
      client_list: {
        Row: {
          id: string;
          owner_id: string;
          name: string;
          email: string;
          created_at: string;
          updated_at: string;
          owner_name: string | null;
          proposal_count: number | null;
          search_text: string | null;
        };
        Relationships: [];
      };
      proposal_list: {
        Row: {
          id: string;
          owner_id: string;
          client_id: string;
          title: string;
          status: Database["public"]["Enums"]["proposal_status"];
          has_original: boolean | null;
          has_preview: boolean | null;
          created_at: string;
          updated_at: string;
          client_name: string;
          owner_name: string | null;
          search_text: string | null;
          link_created_at: string | null;
          deletion_requested_at: string | null;
          has_payments: boolean | null;
          access_mode: "preview" | "full";
          source_format: string | null;
          full_access_granted_at: string | null;
          full_access_granted_by_name: string | null;
        };
        Relationships: [];
      };
      payment_list: {
        Row: {
          id: string;
          owner_id: string;
          proposal_id: string;
          client_id: string;
          provider: string;
          environment: string | null;
          client_name: string | null;
          proposal_title: string | null;
          revision_id: string | null;
          amount_minor: number;
          currency: string;
          status: Database["public"]["Enums"]["payment_status"];
          status_detail: string | null;
          needs_review: boolean;
          review_reason: string | null;
          refunded_amount_minor: number;
          captured_at: string | null;
          verified_at: string | null;
          provider_payment_id: string | null;
          provider_order_id: string | null;
          created_at: string;
          updated_at: string;
          owner_name: string | null;
          search_text: string | null;
        };
        Relationships: [];
      };
      payment_totals: {
        Row: {
          owner_id: string;
          currency: string;
          status: Database["public"]["Enums"]["payment_status"];
          payments: number;
          amount_minor: number;
          refunded_minor: number;
        };
        Relationships: [];
      };
    };
    Functions: {
      // Payments (service_role only; src/lib/supabase/privileged-payments.ts).
      payment_begin_checkout: {
        Args: { p_token: string; p_session_hash: string; p_environment: string };
        Returns: {
          payment_id: string;
          public_ref: string;
          amount_minor: number;
          currency: string;
          title: string;
          request_id: string;
          provider_order_id: string | null;
          approve_url: string | null;
          reused: boolean;
        }[];
      };
      payment_record_order: {
        Args: { p_payment_id: string; p_order_id: string; p_approve_url: string };
        Returns: undefined;
      };
      payment_session_view: {
        Args: { p_public_ref: string; p_session_hash: string };
        Returns: {
          payment_id: string;
          status: Database["public"]["Enums"]["payment_status"];
          amount_minor: number;
          currency: string;
          title: string;
          total_pages: number;
          environment: string;
          provider_order_id: string | null;
          approve_url: string | null;
          needs_review: boolean;
          created_at: string;
          last_synced_at: string | null;
          bound: boolean;
          entitlement_active: boolean;
          has_access: boolean;
        }[];
      };
      payment_lookup_provider: {
        Args: { p_order_id: string | null; p_capture_id: string | null };
        Returns: {
          payment_id: string;
          provider_order_id: string | null;
          provider_payment_id: string | null;
          amount_minor: number;
          currency: string;
          environment: string;
          status: Database["public"]["Enums"]["payment_status"];
        }[];
      };
      payment_mark_cancelled: {
        Args: { p_payment_id: string; p_session_hash: string };
        Returns: Database["public"]["Enums"]["payment_status"];
      };
      payment_apply_state: {
        Args: {
          p_payment_id: string;
          p_status: Database["public"]["Enums"]["payment_status"];
          p_order_id: string;
          p_capture_id: string | null;
          p_amount_minor: number | null;
          p_currency: string | null;
          p_merchant_id: string | null;
          p_payer_email: string | null;
          p_status_detail: string | null;
          p_captured_at: string | null;
          p_review_reason: string | null;
        };
        Returns: {
          status: Database["public"]["Enums"]["payment_status"];
          entitlement_id: string | null;
          entitlement_status: string | null;
          changed: boolean;
        }[];
      };
      payment_record_refund: {
        Args: { p_payment_id: string; p_refund_id: string; p_amount_minor: number; p_currency: string; p_status: string };
        Returns: number;
      };
      payment_grant_session_access: {
        Args: { p_payment_id: string; p_session_hash: string; p_days: number };
        Returns: string | null;
      };
      payment_access_for_link: {
        Args: { p_token: string; p_session_hash: string };
        Returns: { public_ref: string; total_pages: number; verified_at: string; current_revision: boolean }[];
      };
      payment_document_for_session: {
        Args: { p_public_ref: string; p_session_hash: string };
        Returns: { original_storage_path: string; total_pages: number }[];
      };
      payment_recovery_request: {
        Args: { p_token: string; p_email: string; p_token_hash: string; p_ttl_minutes: number };
        Returns: { title: string }[];
      };
      payment_recovery_issue: {
        Args: { p_actor: string; p_payment_id: string; p_token_hash: string; p_ttl_minutes: number };
        Returns: string;
      };
      payment_recovery_peek: {
        Args: { p_token_hash: string };
        Returns: { title: string; expires_at: string }[];
      };
      payment_recovery_consume: {
        Args: { p_token_hash: string; p_session_hash: string; p_days: number };
        Returns: string | null;
      };
      payment_event_begin: {
        Args: {
          p_provider: string;
          p_event_id: string;
          p_event_type: string;
          p_resource_type: string | null;
          p_resource_id: string | null;
        };
        Returns: { id: string; result: string }[];
      };
      payment_event_finish: {
        Args: { p_id: string; p_result: string; p_payment_id: string | null; p_detail: string | null };
        Returns: undefined;
      };
      // Phase 4 trusted writers: executable only by service_role
      // (src/lib/supabase/privileged.ts).
      proposal_attach_original: {
        Args: {
          p_actor: string;
          p_proposal_id: string;
          p_expected_original_path: string | null;
          p_path: string;
          p_file_name: string;
          p_size_bytes: number;
          p_total_pages: number;
        };
        Returns: { previous_original_path: string | null; previous_preview_path: string | null }[];
      };
      proposal_attach_document: {
        Args: {
          p_actor: string;
          p_proposal_id: string;
          p_expected_original_path: string | null;
          p_path: string;
          p_source_path: string | null;
          p_source_format: string | null;
          p_source_size_bytes: number | null;
          p_file_name: string;
          p_size_bytes: number;
          p_total_pages: number;
        };
        Returns: {
          previous_original_path: string | null;
          previous_preview_path: string | null;
          previous_source_path: string | null;
        }[];
      };
      proposal_set_access_mode: {
        Args: { p_actor: string; p_proposal_id: string; p_mode: "preview" | "full" };
        Returns: undefined;
      };
      proposal_issue_full_link: {
        Args: {
          p_actor: string;
          p_proposal_id: string;
          p_expected_original_path: string;
          p_token_hash: string;
          p_note: string | null;
        };
        Returns: string;
      };
      proposal_save_offer: {
        Args: {
          p_actor: string;
          p_proposal_id: string;
          p_expected_original_path: string;
          p_preview_path: string;
          p_free_pages: number;
          p_price_minor: number;
          p_currency: string;
        };
        Returns: { previous_preview_path: string | null }[];
      };
      proposal_issue_link: {
        Args: {
          p_actor: string;
          p_proposal_id: string;
          p_expected_preview_path: string;
          p_token_hash: string;
        };
        Returns: string;
      };
      proposal_revoke_link: {
        Args: { p_actor: string; p_proposal_id: string };
        Returns: undefined;
      };
      // Deletion workflow (service_role only): mark + revoke, list the
      // proposal folder objects, delete the row once storage is empty.
      proposal_begin_deletion: {
        Args: { p_actor: string; p_proposal_id: string };
        Returns: { owner_id: string; deletion_requested_at: string }[];
      };
      proposal_deletion_objects: {
        Args: { p_actor: string; p_proposal_id: string };
        Returns: string[];
      };
      proposal_finish_deletion: {
        Args: { p_actor: string; p_proposal_id: string };
        Returns: undefined;
      };
      // Executable by anon: title of the active proposal for a raw link token.
      resolve_proposal_link: {
        Args: { p_token: string };
        Returns: { title: string }[];
      };
      // Phase 5, executable by anon: client page display fields.
      resolve_proposal_offer: {
        Args: { p_token: string };
        Returns: {
          title: string;
          total_pages: number;
          free_preview_pages: number;
          unlock_price_minor: number;
          currency: string;
        }[];
      };
      // Executable by anon: client page fields of a Full Access link.
      resolve_proposal_full_access: {
        Args: { p_token: string };
        Returns: { title: string; total_pages: number; source_format: string | null }[];
      };
      // service_role only: objects a Full Access link may deliver.
      resolve_proposal_full_object: {
        Args: { p_token: string };
        Returns: { title: string; original_path: string; source_path: string | null; source_format: string | null }[];
      };
      // Phase 5, service_role only: preview object path for streaming.
      resolve_proposal_preview_object: {
        Args: { p_token: string };
        Returns: string | null;
      };
      // Phase 7: rate limiter and storage cleanup (service_role only;
      // src/lib/security/rate-limit.ts and scripts/storage-cleanup.mjs).
      rate_limit_consume: {
        Args: {
          p_scope: string;
          p_key_hash: string;
          p_limit: number;
          p_window_seconds: number;
          p_cost?: number;
        };
        Returns: {
          allowed: boolean;
          hits: number;
          remaining: number;
          retry_after_seconds: number;
        }[];
      };
      rate_limit_prune: {
        Args: { p_max?: number };
        Returns: number;
      };
      storage_cleanup_scan: {
        Args: { p_created_before: string; p_prefix?: string; p_after?: string; p_limit?: number };
        Returns: {
          name: string;
          created_at: string;
          size_bytes: number | null;
          classification: "referenced" | "recent" | "unrecognised" | "orphan";
        }[];
      };
      storage_cleanup_recheck: {
        Args: { p_names: string[]; p_created_before: string };
        Returns: string[];
      };
      storage_cleanup_record: {
        Args: { p_run_id: string; p_entries: Json };
        Returns: number;
      };
      storage_cleanup_history: {
        Args: { p_run_id?: string; p_limit?: number };
        Returns: {
          run_id: string;
          object_name: string;
          size_bytes: number | null;
          outcome: "deleted" | "failed";
          detail: string | null;
          logged_at: string;
        }[];
      };
    };
    Enums: {
      app_role: "admin" | "team_lead";
      proposal_status: "draft" | "active" | "archived";
      payment_status:
        | "created"
        | "pending"
        | "succeeded"
        | "failed"
        | "cancelled"
        | "refunded"
        | "denied"
        | "partially_refunded"
        | "reversed";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

export type AppRole = Database["public"]["Enums"]["app_role"];

export type PaymentStatus = Database["public"]["Enums"]["payment_status"];
