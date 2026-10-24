import { useState } from 'react';

export default function LoginPage() {
  const [showPassword, setShowPassword] = useState(false);
  return <main className="login-page">
    <a className="login-back" href="#">← Back to home</a>
    <section className="login-card" aria-labelledby="login-title">
      <span className="login-brand">FIG <span>Fairfax Investing Group</span></span>
      <div className="home-eyebrow">Your research workspace</div>
      <h1 id="login-title">Log in</h1>
      <p>Access your Stock Selection Guide workspace.</p>
      <form onSubmit={event => event.preventDefault()}>
        <label htmlFor="login-email">Email address</label>
        <input id="login-email" name="email" type="email" autoComplete="username" placeholder="you@example.com" required/>
        <label htmlFor="login-password">Password</label>
        <div className="login-password-field"><input id="login-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Enter your password" required/><button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? 'Hide' : 'Show'}</button></div>
        <button className="primary-button login-submit" type="submit" disabled aria-describedby="login-availability">Log in</button>
        <p id="login-availability" className="login-availability">Account sign-in is coming soon. You can explore companies without an account.</p>
      </form>
      <a className="login-explore" href="#">Find a company →</a>
    </section>
  </main>;
}
