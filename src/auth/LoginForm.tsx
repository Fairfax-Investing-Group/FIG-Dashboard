import { useState } from 'react';
import { useAuth } from './AuthProvider';

export default function LoginForm({ compact = false }: { compact?: boolean }) {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefix = compact ? 'home-login' : 'login';
  const message = error ?? auth.error;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || auth.loading) return;
    setBusy(true); setError(null);
    try { await auth.signIn(email, password); setPassword(''); }
    catch (error) { setError(error instanceof Error ? error.message : 'Sign-in failed. Please try again.'); }
    finally { setBusy(false); }
  }
  async function signOut() {
    setBusy(true); setError(null);
    try { await auth.signOut(); setPassword(''); }
    catch { setError('Could not log out. Please try again.'); }
    finally { setBusy(false); }
  }
  if (auth.session) return <section className={compact ? 'home-login-form signed-in-account' : 'signed-in-account'} aria-label="Your account">
    {compact && <h2>Investor account</h2>}<p>Signed in as <strong>{auth.session.user.email}</strong></p>
    <button className={compact ? 'text-button' : 'primary-button'} type="button" disabled={busy} onClick={signOut}>{busy ? 'Logging out…' : 'Log out'}</button>
    {message && <p className="auth-error" role="alert">{message}</p>}
  </section>;
  const emailField = <><label className={compact ? 'sr-only' : undefined} htmlFor={`${prefix}-email`}>Email address</label><input id={`${prefix}-email`} name="email" type="email" autoComplete="username" placeholder={compact ? 'Email' : 'you@example.com'} value={email} onChange={event => setEmail(event.target.value)} required/></>;
  const passwordField = <input id={`${prefix}-password`} name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder={compact ? 'Password' : 'Enter your password'} value={password} onChange={event => setPassword(event.target.value)} required/>;
  return <form className={compact ? 'home-login-form' : undefined} aria-labelledby={compact ? 'home-login-title' : 'login-title'} onSubmit={submit}>
    {compact && <h2 id="home-login-title">Investor login</h2>}
    <div className={compact ? 'home-login-fields' : undefined}>
      {emailField}
      <label className={compact ? 'sr-only' : undefined} htmlFor={`${prefix}-password`}>Password</label>
      {compact ? passwordField : <div className="login-password-field">{passwordField}<button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? 'Hide' : 'Show'}</button></div>}
    </div>
    <div className={compact ? 'home-login-actions' : undefined}><button className={compact ? undefined : 'primary-button login-submit'} type="submit" disabled={busy || auth.loading || !auth.configured}>{busy ? 'Logging in…' : auth.loading ? 'Checking session…' : compact ? 'Investor login' : 'Log in'}</button></div>
    {message && <p className="auth-error" role="alert">{message}</p>}
  </form>;
}
