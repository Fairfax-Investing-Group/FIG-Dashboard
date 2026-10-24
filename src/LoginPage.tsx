import { useEffect } from 'react';
import { useAuth } from './auth/AuthProvider';
import LoginForm from './auth/LoginForm';

export default function LoginPage() {
  const { session } = useAuth();
  useEffect(() => { if (session) window.location.hash = ''; }, [session]);
  return <main className="login-page">
    <a className="login-back" href="#">← Back to home</a>
    <section className="login-card" aria-labelledby="login-title">
      <span className="login-brand">FIG <span>Fairfax Investing Group</span></span>
      <div className="home-eyebrow">Your research workspace</div>
      <h1 id="login-title">Log in</h1>
      <p>Access your Stock Selection Guide workspace.</p>
      <LoginForm/>
      <a className="login-explore" href="#">Find a company →</a>
    </section>
  </main>;
}
