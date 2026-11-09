import { ExternalLink, GitPullRequest, MessageSquareWarning } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Badge, type Tone } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState, ErrorState } from '../../components/ui/EmptyState';
import { Skeleton } from '../../components/ui/Skeleton';
import { Switch } from '../../components/ui/Switch';
import { keys, useMe, useReviews } from '../../hooks/useApi';
import { ApiError } from '../../services/api/client';
import { api } from '../../services/api/endpoints';
import { toast } from '../../store/ui';
import { timeAgo } from '../../utils/format';
import { useRepoContext } from './RepoLayout';

const RISK: Record<string, Tone> = { low: 'ok', medium: 'warn', high: 'bad' };
const SEV: Record<string, Tone> = { high: 'bad', medium: 'warn', low: 'info', info: 'neutral' };

export function ReviewsTab() {
  const repo = useRepoContext();
  const me = useMe();
  const qc = useQueryClient();
  const reviews = useReviews(repo.id);
  const [number, setNumber] = useState('');
  const [post, setPost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(!!repo.autoReview);
  const connected = !!me.data?.github.connected;

  if (!repo.fullName) return <EmptyState icon={<GitPullRequest className="h-5 w-5" />} title="Not a GitHub repository" body="PR reviews need a repository connected from GitHub (owner/name)." />;
  if (!connected) return <EmptyState icon={<GitPullRequest className="h-5 w-5" />} title="Connect GitHub first" body="A GitHub connection is needed to read pull requests." action={<Link to="/settings"><Button variant="primary">Open settings</Button></Link>} />;

  const run = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(number);
    if (!Number.isInteger(n) || n < 1) return;
    setBusy(true);
    try {
      const r = await api.reviewPr(repo.id, n, post);
      toast.success(post ? 'Review posted to GitHub' : 'Review ready', `#${r.number} · ${r.comments.length} comment(s)`);
      setNumber('');
      await qc.invalidateQueries({ queryKey: keys.reviews(repo.id) });
    } catch (err) {
      toast.error('Review failed', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const toggleAuto = async (v: boolean) => {
    setAuto(v);
    try {
      await api.repoSettings(repo.id, { autoReview: v });
      toast.success(v ? 'Auto review on' : 'Auto review off', v ? 'New pull requests are reviewed through the webhook.' : undefined);
    } catch (err) {
      setAuto(!v);
      toast.error('Could not change the setting', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <div className="space-y-5">
      <section className="panel grid gap-5 p-5 md:grid-cols-2">
        <form onSubmit={run}>
          <h2 className="text-base">Review a pull request</h2>
          <p className="mt-1 text-sm text-muted">DevForge reads the diff, finds risky changes and writes line-level comments. It posts as a plain comment, never as an approval.</p>
          <div className="mt-4 flex items-center gap-2">
            <input className="field w-32" inputMode="numeric" placeholder="PR number" value={number} onChange={(e) => setNumber(e.target.value)} aria-label="Pull request number" />
            <Button type="submit" variant="primary" loading={busy}>Review</Button>
          </div>
          <label className="mt-3 flex items-center gap-2.5 text-sm text-muted"><Switch checked={post} onChange={setPost} label="Post to GitHub" />Post the review on GitHub</label>
        </form>
        <div className="md:border-l md:border-line md:pl-5">
          <h2 className="text-base">Review every new pull request</h2>
          <p className="mt-1 text-sm text-muted">Needs the GitHub webhook from the README (event: Pull requests). Draft PRs are skipped.</p>
          <label className="mt-4 flex items-center gap-2.5 text-sm"><Switch checked={auto} onChange={(v) => void toggleAuto(v)} label="Auto review" />{auto ? 'Auto review is on' : 'Auto review is off'}</label>
        </div>
      </section>

      {reviews.isError ? <ErrorState error={reviews.error} onRetry={() => void reviews.refetch()} /> : !reviews.data ? <Skeleton className="h-40" /> : reviews.data.length === 0 ? (
        <EmptyState icon={<MessageSquareWarning className="h-5 w-5" />} title="No reviews yet" body="Enter a pull request number above to get the first one." />
      ) : (
        <ul className="space-y-4">
          {reviews.data.map((r) => (
            <li key={r.id} className="panel p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">#{r.number} {r.title}</p>
                  <p className="mt-0.5 text-xs text-muted">{timeAgo(r.createdAt)} · {r.trigger === 'webhook' ? 'automatic' : 'manual'}{r.stats ? ` · ${r.stats.files} files, +${r.stats.additions} −${r.stats.deletions}` : ''}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={RISK[r.riskScore]}>{r.riskScore} risk</Badge>
                  <Badge>{r.verdict.replace('_', ' ')}</Badge>
                  {r.posted && r.postedUrl && <a href={r.postedUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-accent2 hover:underline">Posted<ExternalLink className="h-3 w-3" aria-hidden /></a>}
                </div>
              </div>
              <p className="mt-3 text-sm text-muted">{r.summary}</p>
              {r.comments.length > 0 && (
                <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
                  {r.comments.map((c, i) => (
                    <li key={i} className="flex gap-3 px-3.5 py-2.5 text-sm">
                      <Badge tone={SEV[c.severity] ?? 'neutral'} className="h-fit">{c.severity}</Badge>
                      <div className="min-w-0"><p className="truncate font-mono text-xs text-faint">{c.path}:{c.line}</p><p className="mt-0.5">{c.body}</p></div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
