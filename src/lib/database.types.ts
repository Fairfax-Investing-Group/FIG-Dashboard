import type { NewSavedStudy, SavedStudy } from './studyInputs';

/** Mirrors the versioned migrations in supabase/migrations/. */
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
