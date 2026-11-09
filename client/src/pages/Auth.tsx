import { Eye, EyeOff, Lock, Mail, User } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { RelayDemo } from '../components/landing/RelayDemo';
import { Button } from '../components/ui/Button';
import { GitHubIcon, GoogleIcon } from '../components/ui/BrandIcons';
import { Logo } from '../components/ui/Logo';
import { API_URL } from '../config';
import { ApiError } from '../services/api/client';
import { api } from '../services/api/endpoints';
import { useAuth } from '../store/auth';

type Provider = 'google' | 'github';

function strength(pw: string): { score: number; label: string } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  return { score, label: ['Too short', 'Weak', 'Okay', 'Good', 'Strong'][score]! };
}

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const token = useAuth((s) => s.token);
  const setSession = useAuth((s) => s.setSession);
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<Provider | null>(null);
  const [providers, setProviders] = useState<Record<Provider, boolean> | null>(null);
  const register = mode === 'register';
  const meter = useMemo(() => strength(form.password), [form.password]);

  useEffect(() => {
    setError(null);
    let live = true;
    api.authProviders().then((p) => live && setProviders(p), () => live && setProviders({ google: false, github: false }));
    return () => { live = false; };
  }, [mode]);

  if (token) return <Navigate to="/" replace />;

  const social = (p: Provider) => {
    window.location.href = `${API_URL}/api/auth/oauth/${p}/start`;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = register ? await api.register(form) : await api.login({ email: form.email, password: form.password });
      setSession(res.token, res.user);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not reach the server at ${API_URL}. Is it running?`);
    } finally {
      setBusy(false);
    }
  };

  const providerBtn = (p: Provider, label: string, icon: JSX.Element) => {
    const on = providers?.[p] ?? false;
    return (
      <button
        type="button"
        onClick={() => (on ? social(p) : setSetup(setup === p ? null : p))}
        aria-expanded={on ? undefined : setup === p}
        className={clsx('inline-flex h-11 flex-1 items-center justify-center gap-2.5 rounded-xl border bg-surface text-sm font-medium shadow-panel transition hover:border-fg/30 hover:bg-raised', setup === p ? 'border-fg/40' : 'border-line-strong', !on && 'opacity-70')}
      >
        {icon}
        {label}
      </button>
    );
  };

  const fieldIcon = 'pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint';

  return (
    <div className="relative grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <div aria-hidden className="relay-bg fixed inset-x-0 top-0 z-[60] h-[3px]" />
      <section className="relative hidden overflow-hidden border-r border-line bg-raised/60 lg:block">
        <div className="relative flex min-h-screen flex-col justify-between gap-8 p-10">
          <Link to="/welcome" aria-label="DevForge home"><Logo /></Link>
          <div className="mx-auto w-full max-w-md">
            <h2 className="mb-6 text-2xl font-semibold leading-tight tracking-tight">An engineer on your team that reads the whole repo first.</h2>
            <RelayDemo />
          </div>
          <p className="text-xs text-faint">Plans and diffs wait for your approval. Nothing is pushed without it.</p>
        </div>
      </section>

      <section className="flex items-center justify-center px-6 py-12">
        <form onSubmit={submit} className="w-full max-w-[400px]" noValidate={false}>
          <Link to="/welcome" className="mb-10 block lg:hidden" aria-label="DevForge home"><Logo /></Link>
          <h1 className="text-3xl font-semibold tracking-tight">{register ? 'Create your account' : 'Welcome back'}</h1>
          <p className="mt-2 text-sm text-muted">{register ? 'Connect a repository and have your first task planned in minutes.' : 'Sign in to pick up where your agents left off.'}</p>

          <div className="mt-8 flex gap-3">
            {providerBtn('google', 'Google', <GoogleIcon className="h-[18px] w-[18px]" />)}
            {providerBtn('github', 'GitHub', <GitHubIcon className="h-[18px] w-[18px]" />)}
          </div>
          {setup && (
            <div role="note" className="mt-3 rounded-xl border border-line-strong bg-raised/60 p-3.5 text-xs leading-5 text-muted">
              <p className="font-medium text-fg">{setup === 'google' ? 'Google' : 'GitHub'} sign-in is not set up on this server yet.</p>
              <p className="mt-1">
                Create an OAuth {setup === 'google' ? 'client (Google Cloud Console, Credentials)' : 'app (GitHub, Settings, Developer settings)'} with the callback URL
              </p>
              <code className="mt-1 block break-all rounded-md bg-fg/[0.06] px-2 py-1 font-mono text-[11px] text-fg">{API_URL}/api/auth/oauth/{setup}/callback</code>
              <p className="mt-1">then add <span className="font-mono">{setup === 'google' ? 'GOOGLE_CLIENT_ID' : 'GITHUB_OAUTH_CLIENT_ID'}</span> and the secret to <span className="font-mono">.env</span> and restart. Until then, use email.</p>
            </div>
          )}

          <div className="my-6 flex items-center gap-3 text-xs text-faint" role="separator">
            <span className="h-px flex-1 bg-line/15" />
            or continue with email
            <span className="h-px flex-1 bg-line/15" />
          </div>

          <div className="space-y-4">
            {register && (
              <div>
                <label className="label" htmlFor="name">Full name</label>
                <div className="relative">
                  <User className={fieldIcon} aria-hidden />
                  <input id="name" className="field pl-10" autoComplete="name" required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
              </div>
            )}
            <div>
              <label className="label" htmlFor="email">Email</label>
              <div className="relative">
                <Mail className={fieldIcon} aria-hidden />
                <input id="email" type="email" className="field pl-10" autoComplete="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="label" htmlFor="password">Password</label>
              <div className="relative">
                <Lock className={fieldIcon} aria-hidden />
                <input id="password" type={show ? 'text' : 'password'} className="field px-10" autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 8 : undefined} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-faint hover:text-fg">
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {register && (
                <div className="mt-2" aria-live="polite">
                  <div className="flex gap-1">
                    {[1, 2, 3, 4].map((i) => (
                      <span key={i} className={clsx('h-1 flex-1 rounded-full transition-colors', meter.score >= i ? (meter.score <= 1 ? 'bg-bad' : meter.score === 2 ? 'bg-warn' : 'bg-ok') : 'bg-fg/10')} />
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-faint">{form.password ? meter.label : 'Use at least 8 characters.'}</p>
                </div>
              )}
            </div>
          </div>

          {error && <p role="alert" className="mt-4 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>}

          <Button type="submit" variant="primary" loading={busy} className="mt-6 h-11 w-full rounded-xl">
            {register ? 'Create account' : 'Sign in'}
          </Button>
          <p className="mt-6 text-center text-sm text-muted">
            {register ? 'Already have an account?' : 'New to DevForge?'}{' '}
            <Link to={register ? '/login' : '/register'} className="font-medium text-fg underline underline-offset-4">{register ? 'Sign in' : 'Create an account'}</Link>
          </p>
        </form>
      </section>
    </div>
  );
}
