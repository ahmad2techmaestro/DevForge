import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Spinner } from '../components/ui/Spinner';
import { api } from '../services/api/endpoints';
import { useAuth } from '../store/auth';

/** Landing point after Google/GitHub sign-in. The API redirects here with #token=... or #error=... */
export function OAuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const token = params.get('token');
    const err = params.get('error');
    window.history.replaceState(null, '', window.location.pathname);
    if (err || !token) {
      setError(err ?? 'Sign-in failed. Please try again.');
      return;
    }
    const { setSession, clear } = useAuth.getState();
    setSession(token, { id: '', email: '', name: '', createdAt: '' });
    api.me().then(
      (me) => { setSession(token, me.user); navigate('/', { replace: true }); },
      () => { clear(); setError('Could not finish signing in. Please try again.'); },
    );
  }, [navigate]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      {error ? (
        <>
          <p role="alert" className="max-w-sm rounded-lg border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad">{error}</p>
          <Link to="/login" className="text-sm font-medium underline underline-offset-4">Back to sign in</Link>
        </>
      ) : (
        <>
          <Spinner />
          <p className="text-sm text-muted">Signing you in…</p>
        </>
      )}
    </div>
  );
}
