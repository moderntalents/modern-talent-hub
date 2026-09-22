// Hand-written to match supabase/migrations/0001_init.sql.
// If you evolve the schema, regenerate with the Supabase CLI instead:
//   npx supabase gen types typescript --project-id <ref> > lib/supabase/types.ts
//
// `Relationships` mirrors the real foreign keys declared in the migration
// (Postgres's default `<table>_<column>_fkey` naming) so that embedded/joined
// selects like `.select("*, subjects(name)")` type-check the embedded shape.

export type UserRole = "student" | "teacher" | "admin";
export type ActivityCategory = "sports" | "martial" | "performing" | "creative";
export type BillingCycle = "month" | "week" | "lesson" | "day" | "one-time" | "free";
export type LessonStatus = "draft" | "published";
export type SubscriptionStatus = "pending_payment" | "active" | "cancelled" | "expired";
export type TransactionStatus = "pending" | "completed" | "failed";
export type WithdrawalStatus = "pending" | "processing" | "successful" | "failed" | "reversed";
export type ActivationPaymentStatus = "pending" | "completed" | "failed" | "expired";

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          role: UserRole;
          full_name: string;
          phone: string | null;
          avatar_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["profiles"]["Row"]> & { id: string };
        Update: Partial<Database["public"]["Tables"]["profiles"]["Row"]>;
        Relationships: [];
      };
      student_profiles: {
        Row: {
          profile_id: string;
          grade: string | null;
          school_name: string | null;
          parent_phone: string | null;
        };
        Insert: Partial<Database["public"]["Tables"]["student_profiles"]["Row"]> & {
          profile_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["student_profiles"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "student_profiles_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: true;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      teacher_profiles: {
        Row: {
          profile_id: string;
          bio: string | null;
          specialty: string | null;
          approved: boolean;
          payout_method: "mpesa" | "bank";
          mpesa_number: string | null;
          bank_name: string | null;
          bank_account: string | null;
          wallet_balance: number;
          activated: boolean;
          activated_at: string | null;
        };
        Insert: Partial<Database["public"]["Tables"]["teacher_profiles"]["Row"]> & {
          profile_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["teacher_profiles"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "teacher_profiles_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: true;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      subjects: {
        Row: {
          id: string;
          name: string;
          description: string | null;
          color: string;
          order_index: number;
        };
        Insert: Partial<Database["public"]["Tables"]["subjects"]["Row"]>;
        Update: Partial<Database["public"]["Tables"]["subjects"]["Row"]>;
        Relationships: [];
      };
      lessons: {
        Row: {
          id: string;
          subject_id: string;
          teacher_id: string | null;
          title: string;
          description: string | null;
          video_url: string | null;
          status: LessonStatus;
          order_index: number;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["lessons"]["Row"]> & {
          subject_id: string;
          title: string;
        };
        Update: Partial<Database["public"]["Tables"]["lessons"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "lessons_subject_id_fkey";
            columns: ["subject_id"];
            isOneToOne: false;
            referencedRelation: "subjects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lessons_teacher_id_fkey";
            columns: ["teacher_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      lesson_materials: {
        Row: {
          id: string;
          lesson_id: string;
          file_name: string;
          storage_path: string;
          file_type: string | null;
          file_size: number | null;
          uploaded_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["lesson_materials"]["Row"]> & {
          lesson_id: string;
          file_name: string;
          storage_path: string;
        };
        Update: Partial<Database["public"]["Tables"]["lesson_materials"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "lesson_materials_lesson_id_fkey";
            columns: ["lesson_id"];
            isOneToOne: false;
            referencedRelation: "lessons";
            referencedColumns: ["id"];
          },
        ];
      };
      assignments: {
        Row: {
          id: string;
          lesson_id: string;
          title: string;
          instructions: string | null;
          due_date: string | null;
          max_score: number;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["assignments"]["Row"]> & {
          lesson_id: string;
          title: string;
        };
        Update: Partial<Database["public"]["Tables"]["assignments"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "assignments_lesson_id_fkey";
            columns: ["lesson_id"];
            isOneToOne: false;
            referencedRelation: "lessons";
            referencedColumns: ["id"];
          },
        ];
      };
      assignment_submissions: {
        Row: {
          id: string;
          assignment_id: string;
          student_id: string;
          storage_path: string;
          file_name: string;
          submitted_at: string;
          grade: number | null;
          feedback: string | null;
          graded_at: string | null;
        };
        Insert: Partial<Database["public"]["Tables"]["assignment_submissions"]["Row"]> & {
          assignment_id: string;
          student_id: string;
          storage_path: string;
          file_name: string;
        };
        Update: Partial<Database["public"]["Tables"]["assignment_submissions"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "assignment_submissions_assignment_id_fkey";
            columns: ["assignment_id"];
            isOneToOne: false;
            referencedRelation: "assignments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "assignment_submissions_student_id_fkey";
            columns: ["student_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      activities: {
        Row: {
          id: string;
          teacher_id: string;
          category: ActivityCategory;
          activity_type: string;
          sub_type: string | null;
          title: string;
          description: string | null;
          level: string | null;
          age_range: string | null;
          location: string | null;
          price: number;
          billing: BillingCycle;
          status: LessonStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["activities"]["Row"]> & {
          teacher_id: string;
          category: ActivityCategory;
          activity_type: string;
          title: string;
        };
        Update: Partial<Database["public"]["Tables"]["activities"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "activities_teacher_id_fkey";
            columns: ["teacher_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      activity_materials: {
        Row: {
          id: string;
          activity_id: string;
          file_name: string;
          storage_path: string;
          file_type: string | null;
          file_size: number | null;
          uploaded_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["activity_materials"]["Row"]> & {
          activity_id: string;
          file_name: string;
          storage_path: string;
        };
        Update: Partial<Database["public"]["Tables"]["activity_materials"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "activity_materials_activity_id_fkey";
            columns: ["activity_id"];
            isOneToOne: false;
            referencedRelation: "activities";
            referencedColumns: ["id"];
          },
        ];
      };
      subscriptions: {
        Row: {
          id: string;
          student_id: string;
          activity_id: string;
          teacher_id: string;
          status: SubscriptionStatus;
          current_period_end: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["subscriptions"]["Row"]> & {
          student_id: string;
          activity_id: string;
          teacher_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["subscriptions"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "subscriptions_student_id_fkey";
            columns: ["student_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "subscriptions_activity_id_fkey";
            columns: ["activity_id"];
            isOneToOne: false;
            referencedRelation: "activities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "subscriptions_teacher_id_fkey";
            columns: ["teacher_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      payment_transactions: {
        Row: {
          id: string;
          subscription_id: string;
          student_id: string;
          teacher_id: string;
          amount: number;
          currency: string;
          provider: string;
          provider_reference: string | null;
          checkout_request_id: string | null;
          status: TransactionStatus;
          teacher_share: number;
          platform_share: number;
          created_at: string;
          completed_at: string | null;
        };
        Insert: Partial<Database["public"]["Tables"]["payment_transactions"]["Row"]> & {
          subscription_id: string;
          student_id: string;
          teacher_id: string;
          amount: number;
        };
        Update: Partial<Database["public"]["Tables"]["payment_transactions"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "payment_transactions_subscription_id_fkey";
            columns: ["subscription_id"];
            isOneToOne: false;
            referencedRelation: "subscriptions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "payment_transactions_student_id_fkey";
            columns: ["student_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "payment_transactions_teacher_id_fkey";
            columns: ["teacher_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      withdrawal_requests: {
        Row: {
          id: string;
          teacher_id: string;
          amount: number;
          method: "mpesa" | "bank";
          destination: string;
          status: WithdrawalStatus;
          requested_at: string;
          processed_at: string | null;
          provider_reference: string | null;
          notes: string | null;
        };
        Insert: Partial<Database["public"]["Tables"]["withdrawal_requests"]["Row"]> & {
          teacher_id: string;
          amount: number;
          destination: string;
        };
        Update: Partial<Database["public"]["Tables"]["withdrawal_requests"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "withdrawal_requests_teacher_id_fkey";
            columns: ["teacher_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      platform_settings: {
        Row: {
          key: string;
          value: Json;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: Partial<Database["public"]["Tables"]["platform_settings"]["Row"]> & {
          key: string;
          value: Json;
        };
        Update: Partial<Database["public"]["Tables"]["platform_settings"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "platform_settings_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      platform_settings_history: {
        Row: {
          id: number;
          key: string;
          old_value: Json | null;
          new_value: Json;
          changed_by: string | null;
          changed_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["platform_settings_history"]["Row"]> & {
          key: string;
          new_value: Json;
        };
        Update: Partial<Database["public"]["Tables"]["platform_settings_history"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "platform_settings_history_changed_by_fkey";
            columns: ["changed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      coach_activation_payments: {
        Row: {
          id: string;
          teacher_id: string;
          amount: number;
          currency: string;
          phone: string;
          status: ActivationPaymentStatus;
          checkout_request_id: string | null;
          merchant_request_id: string | null;
          provider_reference: string | null;
          result_desc: string | null;
          created_at: string;
          completed_at: string | null;
        };
        Insert: Partial<Database["public"]["Tables"]["coach_activation_payments"]["Row"]> & {
          teacher_id: string;
          amount: number;
          phone: string;
        };
        Update: Partial<Database["public"]["Tables"]["coach_activation_payments"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "coach_activation_payments_teacher_id_fkey";
            columns: ["teacher_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      live_sessions: {
        Row: {
          id: string;
          kind: "lesson" | "activity";
          lesson_id: string | null;
          activity_id: string | null;
          teacher_id: string;
          scheduled_at: string;
          duration_minutes: number;
          status: "scheduled" | "live" | "ended";
          room_name: string | null;
          started_at: string | null;
          ended_at: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["live_sessions"]["Row"]> & {
          kind: "lesson" | "activity";
          teacher_id: string;
          scheduled_at: string;
          duration_minutes: number;
        };
        Update: Partial<Database["public"]["Tables"]["live_sessions"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "live_sessions_lesson_id_fkey";
            columns: ["lesson_id"];
            isOneToOne: false;
            referencedRelation: "lessons";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "live_sessions_activity_id_fkey";
            columns: ["activity_id"];
            isOneToOne: false;
            referencedRelation: "activities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "live_sessions_teacher_id_fkey";
            columns: ["teacher_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      live_session_participants: {
        Row: {
          id: string;
          session_id: string;
          profile_id: string;
          joined_at: string;
          last_joined_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["live_session_participants"]["Row"]> & {
          session_id: string;
          profile_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["live_session_participants"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "live_session_participants_session_id_fkey";
            columns: ["session_id"];
            isOneToOne: false;
            referencedRelation: "live_sessions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "live_session_participants_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      // 0010_age_and_guardian_consent.sql — written by server code only.
      age_records: {
        Row: {
          profile_id: string;
          date_of_birth: string;
          guardian_email: string | null;
          consent_status: "not_required" | "pending" | "granted" | "declined";
          consent_decided_at: string | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["age_records"]["Row"]> & {
          profile_id: string;
          date_of_birth: string;
          consent_status: "not_required" | "pending" | "granted" | "declined";
        };
        Update: Partial<Database["public"]["Tables"]["age_records"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "age_records_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: true;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      guardian_consent_requests: {
        Row: {
          id: string;
          profile_id: string;
          guardian_email: string;
          token_hash: string;
          expires_at: string;
          decided_at: string | null;
          decision: "approved" | "declined" | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["guardian_consent_requests"]["Row"]> & {
          profile_id: string;
          guardian_email: string;
          token_hash: string;
          expires_at: string;
        };
        Update: Partial<Database["public"]["Tables"]["guardian_consent_requests"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "guardian_consent_requests_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      // 0011_messaging.sql — read by the two people in a conversation; written by server code only.
      conversations: {
        Row: {
          id: string;
          student_id: string;
          teacher_id: string;
          created_at: string;
          last_message_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["conversations"]["Row"]> & {
          student_id: string;
          teacher_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["conversations"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "conversations_student_id_fkey";
            columns: ["student_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversations_teacher_id_fkey";
            columns: ["teacher_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      messages: {
        Row: {
          id: string;
          conversation_id: string;
          sender_id: string;
          kind: "message" | "homework" | "submission";
          body: string;
          attachment_path: string | null;
          attachment_name: string | null;
          attachment_size: number | null;
          created_at: string;
        };
        Insert: Partial<Database["public"]["Tables"]["messages"]["Row"]> & {
          conversation_id: string;
          sender_id: string;
        };
        Update: Partial<Database["public"]["Tables"]["messages"]["Row"]>;
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_sender_id_fkey";
            columns: ["sender_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: {
      // Server-only (service role) helpers from 0005_registration_codes.sql.
      auth_email_status: {
        Args: { p_email: string };
        Returns: { id: string; confirmed: boolean }[];
      };
      hit_rate_limit: {
        Args: { p_key: string; p_max: number; p_window_seconds: number };
        Returns: boolean;
      };
      issue_registration_code: {
        Args: { p_email: string; p_code_hash: string; p_ttl_seconds?: number };
        Returns: { status: "ok" | "cooldown" | "limit"; retry_after: number }[];
      };
      verify_registration_code: {
        Args: { p_email: string; p_code_hash: string };
        Returns: "ok" | "invalid" | "expired" | "locked" | "none";
      };
      // Server-only, from 0009_delete_user_identities.sql (account deletion).
      delete_user_identities: {
        Args: { p_user_id: string };
        Returns: undefined;
      };
      // Server-only, from 0010_age_and_guardian_consent.sql.
      decide_guardian_consent: {
        Args: { p_token_hash: string; p_decision: string };
        Returns: "approved" | "declined" | "used" | "expired" | "invalid";
      };
      // Server-only, from 0011_messaging.sql. Failures are raised as "messaging:<reason>".
      start_conversation_from_lesson: {
        Args: { p_student: string; p_lesson: string };
        Returns: string;
      };
      start_conversation_from_activity: {
        Args: { p_student: string; p_activity: string };
        Returns: string;
      };
      start_conversation_as_teacher: {
        Args: { p_teacher: string; p_student: string };
        Returns: string;
      };
      messaging_can_send: {
        Args: { p_user: string; p_conversation: string };
        Returns: "ok" | "not_found" | "not_cleared" | "closed";
      };
      send_message: {
        Args: {
          p_sender: string;
          p_conversation: string;
          p_body: string;
          p_kind: "message" | "homework" | "submission";
          p_attachment_path: string | null;
          p_attachment_name: string | null;
          p_attachment_size: number | null;
        };
        Returns: string;
      };
      attachment_in_use: {
        Args: { p_path: string };
        Returns: boolean;
      };
      messaging_conversation_ids: {
        Args: { p_user: string };
        Returns: string[];
      };
      delete_user_messages: {
        Args: { p_user: string };
        Returns: number;
      };
    };
  };
}
