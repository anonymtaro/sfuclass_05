import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useCore } from '@classroom/core-client';

/**
 * Sign in  (F5)
 *
 * The form does nothing clever: CoreProvider owns the session, and this is the
 * one screen that asks it to start one. The access token never reaches this
 * component — it lives in memory inside the provider, and the refresh cookie
 * the server sets is what survives a reload.
 */
export default function LoginPage() {
  const { signIn, status } = useCore();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Where they were headed before being bounced here, e.g. a room link from a
  // calendar invite. Landing on the dashboard instead would lose the lesson.
  const destination = location.state?.from ?? '/';

  if (status === 'authenticated') {
    return <Navigate to={destination} replace />;
  }

  const handleSubmit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn({ email, password });
      navigate(destination, { replace: true });
    } catch (cause) {
      // The server deliberately does not say which half was wrong.
      setError(cause?.detail ?? 'Email or password is incorrect.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="join">
      <form className="card" onSubmit={handleSubmit}>
        <h1>Sign in</h1>

        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          autoFocus
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />

        {error && (
          <p className="banner banner--warn" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}