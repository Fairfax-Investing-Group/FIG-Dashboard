import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

const env = import.meta.env ?? {};
const url = env.VITE_SUPABASE_URL?.trim();
const key = (env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY)?.trim();

// Only the public project key belongs in a Vite build. Ownership is enforced by RLS.
function publicKey(value: string): boolean {
  if (value.startsWith('sb_publishable_')) return true;
  try {
    const payload = JSON.parse(atob(value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.role === 'anon';
  } catch { return false; }
}

export const supabase = url && /^https?:\/\//.test(url) && key && publicKey(key)
  ? createClient<Database>(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  }) : null;
