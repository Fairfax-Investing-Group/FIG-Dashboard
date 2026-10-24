import type { NewSavedStudy, SavedStudy } from './studyInputs';

/** Mirrors supabase/migrations/202610240001_user_studies.sql. */
export type Database = {
  public: {
    Tables: {
      studies: { Row: SavedStudy; Insert: NewSavedStudy; Update: Partial<NewSavedStudy>; Relationships: [] };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
