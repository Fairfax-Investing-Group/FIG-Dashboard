import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from './supabase';
import type { Database } from './database.types';
import { validateStudyValues, type NewSavedStudy } from './studyInputs';

// Explicit saves only; provider documents never enter this repository.
export function createStudyRepository(client?: SupabaseClient<Database> | null) {
  async function connection() {
    const db = client === undefined ? await getSupabaseClient() : client;
    if (!db) throw new Error('Study storage is not configured.');
    return db;
  }
  async function authenticated() {
    const db = await connection();
    const { data, error } = await db.auth.getSession();
    if (error) throw error;
    if (!data.session?.user) throw new Error('Log in to save or edit studies.');
    // This is a local convenience check; Postgres RLS validates real ownership.
    return { db, userId: data.session.user.id };
  }
  return {
    async list() {
      const db = await connection();
      const { data, error } = await db.from('studies').select('id,user_id,ticker,cik,title,study_made_at,created_at,updated_at').order('updated_at', { ascending: false });
      if (error) throw error;
      return data;
    },
    async get(id: string) {
      const db = await connection();
      const { data, error } = await db.from('studies').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data;
    },
    async create(values: NewSavedStudy) {
      const input = validateStudyValues(values);
      if (!input.ticker || !input.cik) throw new Error('Select a company before saving a study.');
      const { db } = await authenticated();
      const { data, error } = await db.from('studies').insert(input as NewSavedStudy).select('*').single();
      if (error) throw error;
      return data;
    },
    async update(id: string, values: Partial<NewSavedStudy>) {
      const input = validateStudyValues(values);
      delete input.study_made_at; // Creation date is immutable after the first save.
      if (!Object.keys(input).length) throw new Error('No study inputs to update.');
      const { db, userId } = await authenticated();
      const { data, error } = await db.from('studies').update(input).eq('id', id).eq('user_id', userId).select('*').single();
      if (error) throw error;
      return data;
    },
    async remove(id: string) {
      const { db, userId } = await authenticated();
      const { data, error } = await db.from('studies').delete().eq('id', id).eq('user_id', userId).select('id').maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('Study not found.');
    },
  };
}
