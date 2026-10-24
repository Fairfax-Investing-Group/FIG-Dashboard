import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../lib/database.types';
import { supabase } from '../lib/supabase';

type AuthState = { session: Session | null; loading: boolean; error: string | null };
type AuthContextValue = AuthState & {
  configured: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};
const unavailable = async () => { throw new Error('Sign-in is currently unavailable. Please try again later.'); };
const AuthContext = createContext<AuthContextValue>({ session: null, loading: false, error: null, configured: false, signIn: unavailable, signOut: unavailable });

export function AuthProvider({ children, client = supabase }: { children: ReactNode; client?: SupabaseClient<Database> | null }) {
  const [state, setState] = useState<AuthState>({ session: null, loading: Boolean(client), error: null });
  useEffect(() => {
    if (!client) { setState({ session: null, loading: false, error: null }); return; }
    let active = true;
    let revision = 0;
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      revision++;
      if (active) setState({ session, loading: false, error: null });
    });
    const initialRevision = revision;
    client.auth.getSession().then(({ data, error }) => {
      if (!active || revision !== initialRevision) return;
      setState({ session: error ? null : data.session, loading: false, error: error ? 'Your session could not be restored. Please log in again.' : null });
    }).catch(() => {
      if (active && revision === initialRevision) setState({ session: null, loading: false, error: 'Your session could not be restored. Please log in again.' });
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, [client]);

  const signIn = useCallback(async (email: string, password: string) => {
    if (!client) return unavailable();
    const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw error;
    if (!data.session) throw new Error('Sign-in could not be completed. Please try again.');
    setState({ session: data.session, loading: false, error: null });
  }, [client]);
  const signOut = useCallback(async () => {
    if (!client) return unavailable();
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) throw error;
    setState({ session: null, loading: false, error: null });
  }, [client]);
  const value = useMemo(() => ({ ...state, configured: Boolean(client), signIn, signOut }), [state, client, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
