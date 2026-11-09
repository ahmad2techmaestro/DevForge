import { ArrowRight, GitPullRequest, Brain, ShieldCheck, Hand } from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { RelayDemo } from '../components/landing/RelayDemo';
import { GitHubIcon, LinkedInIcon } from '../components/ui/BrandIcons';
import { Logo } from '../components/ui/Logo';
import { AUTHOR } from '../config/links';
import { useAuth } from '../store/auth';

const PROOF = [
  { icon: ShieldCheck, title: 'Security Auditor', body: 'Scans for leaked secrets, injection patterns and risky dependencies, then explains each finding in plain words.' },
  { icon: GitPullRequest, title: 'Issue to pull request', body: 'Label a GitHub issue and a task starts on its own. You still approve the plan and the diff.' },
  { icon: Brain, title: 'Repository memory', body: 'When you reject a plan and say why, DevForge remembers and does not repeat the mistake.' },
  { icon: Hand, title: 'Two human gates', body: 'Plans and diffs wait for you. Nothing is pushed, merged or published without a decision.' },
];

export function Landing() {
  const token = useAuth((s) => s.token);
  if (token) return <Navigate to="/" replace />;
  return (
    <div className="relative min-h-screen overflow-hidden">
      <div aria-hidden className="relay-bg fixed inset-x-0 top-0 z-[60] h-[3px]" />
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <Logo />
        <nav className="flex items-center gap-2 text-sm">
          <a href={AUTHOR.repo} className="hidden rounded-lg px-3 py-2 text-muted hover:text-fg sm:block">Source</a>
          <Link to="/login" className="rounded-lg px-3 py-2 text-muted hover:text-fg">Sign in</Link>
          <Link to="/register" className="rounded-lg bg-fg px-3.5 py-2 font-medium text-bg shadow-panel hover:opacity-90">Get started</Link>
        </nav>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-20 pt-10 lg:grid-cols-[1.05fr_1fr] lg:pt-16">
          <div>
            <h1 className="max-w-xl text-[2.6rem] font-semibold leading-[1.05] tracking-tight sm:text-6xl">
              Five agents write the change. You <span className="accent-serif">sign it off.</span>
            </h1>
            <p className="mt-6 max-w-lg text-lg leading-7 text-muted">
              Connect a GitHub repository. DevForge reads it, plans the work, edits the code, runs your tests and drafts the pull request, pausing twice for your approval.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link to="/register" className="inline-flex items-center gap-2 rounded-xl bg-fg px-5 py-3 text-sm font-medium text-bg shadow-lift hover:opacity-90">
                Create an account <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <a href={AUTHOR.repo} className="inline-flex items-center gap-2 rounded-xl border border-line bg-surface px-5 py-3 text-sm font-medium shadow-panel hover:bg-raised">
                <GitHubIcon className="h-4 w-4" /> View the code
              </a>
            </div>
            <p className="mt-5 text-sm text-faint">Runs offline with a built-in demo model, or with Gemini, Groq, Ollama, OpenAI or Anthropic.</p>
          </div>
          <RelayDemo />
        </section>

        <section className="border-y border-line bg-surface/60">
          <div className="mx-auto grid max-w-6xl gap-px px-5 py-14 sm:grid-cols-2 lg:grid-cols-4">
            {PROOF.map(({ icon: Icon, title, body }) => (
              <div key={title} className="p-5">
                <Icon className="h-5 w-5 text-fg" aria-hidden />
                <h2 className="mt-4 text-base font-semibold">{title}</h2>
                <p className="mt-1.5 text-sm leading-6 text-muted">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-16">
          <h2 className="max-w-xl text-3xl font-semibold tracking-tight">Built like a product, not a demo.</h2>
          <p className="mt-3 max-w-2xl text-muted">
            React and TypeScript client, Express API with Redis queues and WebSockets, a Python LangGraph service, and a sandbox for running generated code. Every layer has tests.
          </p>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-4 px-5 py-8 text-sm text-muted sm:flex-row sm:items-center">
          <p>Designed and built by <span className="font-medium text-fg">{AUTHOR.name}</span></p>
          <div className="flex items-center gap-4">
            <a href={AUTHOR.github} className="inline-flex items-center gap-2 hover:text-fg"><GitHubIcon className="h-4 w-4" /> GitHub</a>
            <a href={AUTHOR.linkedin} className="inline-flex items-center gap-2 hover:text-fg"><LinkedInIcon className="h-4 w-4" /> LinkedIn</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
