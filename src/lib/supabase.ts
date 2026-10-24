import type { SupabaseClient } from '@supabase/supabase-js';
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

export const supabaseConfigured = Boolean(url && /^https?:\/\//.test(url) && key && publicKey(key));
let clientPromise: Promise<SupabaseClient<Database> | null> | undefined;

// Authentication initializes in the background without adding its SDK to the
// critical search/chart bundle. All callers share the same client and session.
export function getSupabaseClient(): Promise<SupabaseClient<Database> | null> {
  if (!supabaseConfigured) return Promise.resolve(null);
  clientPromise ??= import('@supabase/supabase-js').then(({ createClient }) => createClient<Database>(url!, key!, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  })).catch(error => { clientPromise = undefined; throw error; });
  return clientPromise;
}
