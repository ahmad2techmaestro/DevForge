import { motion } from 'framer-motion';
import { FolderGit2, GitBranch, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useRepos } from '../hooks/useApi';
import type { Repo } from '../types/index';
import { Button } from '../components/ui/Button';
import { RepoStatusBadge } from '../components/ui/Badge';
import { EmptyState, ErrorState } from '../components/ui/EmptyState';
import { PageHeader } from '../components/ui/PageHeader';
import { Ring } from '../components/ui/Ring';
import { Skeleton } from '../components/ui/Skeleton';
import { formatNumber, languageColor, timeAgo } from '../utils/format';
import { useUi } from '../store/ui';

export function LanguageBar({ languages }: { languages: Record<string, { files: number; lines: number }> }) {
  const entries = Object.entries(languages).sort((a, b) => b[1].lines - a[1].lines).slice(0, 5);
  const total = entries.reduce((n, [, v]) => n + v.lines, 0) || 1;
  return (
    <div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-fg/10" role="img" aria-label={entries.map(([k, v]) => `${k} ${Math.round((v.lines / total) * 100)}%`).join(', ')}>
        {entries.map(([lang, v]) => <span key={lang} style={{ width: `${(v.lines / total) * 100}%`, background: languageColor(lang) }} />)}
      </div>
      <p className="mt-2 flex flex-wrap gap-x-3 text-xs text-muted">
        {entries.slice(0, 3).map(([lang]) => (
          <span key={lang} className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full" style={{ background: languageColor(lang) }} />{lang}</span>
        ))}
      </p>
    </div>
  );
}

const TINTS = ['tint-mint', 'tint-peach', 'tint-sky', 'tint-lilac'];

function RepoCard({ repo, index }: { repo: Repo; index: number }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index, 8) * 0.04 }}>
      <Link to={`/repos/${repo.id}`} className="panel group block h-full overflow-hidden p-2 transition hover:-translate-y-1 hover:shadow-lift">
        <div className={`relative flex h-24 items-center justify-center rounded-[18px] ${TINTS[index % TINTS.length]}`}>
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/80 text-accent2 shadow-panel dark:bg-white/10"><FolderGit2 className="h-5 w-5" aria-hidden /></span>
          <span className="absolute right-3 top-3">{repo.health ? <Ring score={repo.health.score} grade={repo.health.grade} /> : <RepoStatusBadge status={repo.status} />}</span>
        </div>
        <div className="p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-base">{repo.fullName ?? repo.name}</h3>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted"><GitBranch className="h-3 w-3" aria-hidden />{repo.branch}{repo.commit && <span className="font-mono">· {repo.commit.slice(0, 7)}</span>}</p>
          </div>
        </div>
        <p className="mt-3 line-clamp-2 min-h-[2.5rem] text-sm text-muted">{repo.status === 'error' ? repo.error : repo.summary ?? (repo.status === 'indexing' ? 'Cloning and indexing…' : 'No summary yet.')}</p>
        <div className="mt-4">
          {repo.stats ? <LanguageBar languages={repo.stats.languages} /> : <Skeleton className="h-1.5" />}
        </div>
        <div className="mt-4 flex items-center justify-between text-xs text-faint">
          <span>{repo.stats ? `${formatNumber(repo.stats.fileCount)} files · ${formatNumber(repo.stats.totalLines)} lines` : ' '}</span>
          <span>{timeAgo(repo.createdAt)}</span>
        </div>
        </div>
      </Link>
    </motion.div>
  );
}

export function Repos() {
  const repos = useRepos();
  const setConnect = useUi((s) => s.setConnect);
  return (
    <>
      <PageHeader
        title="Repositories"
        description="Connected codebases your agents can read, analyse and change."
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setConnect(true)}>Connect repository</Button>}
      />
      {repos.isError ? (
        <ErrorState error={repos.error} onRetry={() => void repos.refetch()} />
      ) : repos.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-52" />)}</div>
      ) : repos.data?.length === 0 ? (
        <EmptyState icon={<FolderGit2 className="h-5 w-5" />} title="Connect your first repository" body="Pick a repo from GitHub or paste a clone URL. DevForge indexes it so the agents understand your code." action={<Button variant="primary" onClick={() => setConnect(true)}>Connect repository</Button>} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{repos.data?.map((r, i) => <RepoCard key={r.id} repo={r} index={i} />)}</div>
      )}
    </>
  );
}
