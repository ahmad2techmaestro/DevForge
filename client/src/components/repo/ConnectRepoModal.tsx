import { GitBranch, Globe, HardDrive, Lock, Search } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../services/api/client';
import { useCreateRepo, useGithubRepos, useMe } from '../../hooks/useApi';
import { timeAgo } from '../../utils/format';
import { toast, useUi } from '../../store/ui';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { SegmentedControl } from '../ui/Tabs';
import { Skeleton } from '../ui/Skeleton';
import { Link } from 'react-router-dom';

type Tab = 'github' | 'url' | 'local';

export function ConnectRepoModal() {
  const { connectOpen, setConnect } = useUi();
  const me = useMe(connectOpen);
  const create = useCreateRepo();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('github');
  const [query, setQuery] = useState('');
  const [url, setUrl] = useState('');
  const [path, setPath] = useState('');
  const connected = !!me.data?.github.connected;
  const repos = useGithubRepos(query, connectOpen && tab === 'github' && connected);

  const submit = async (input: { fullName?: string; cloneUrl?: string; localPath?: string }) => {
    try {
      const repo = await create.mutateAsync(input);
      toast.success('Indexing started', `${repo.name} will be ready in a moment.`);
      setConnect(false);
      navigate(`/repos/${repo.id}`);
    } catch (err) {
      toast.error('Could not connect repository', err instanceof ApiError ? err.message : undefined);
    }
  };

  return (
    <Modal open={connectOpen} onClose={() => setConnect(false)} title="Connect a repository" description="DevForge clones and indexes the code so agents can understand it." wide>
      <SegmentedControl
        label="Source"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'github', label: 'GitHub' },
          { value: 'url', label: 'Clone URL' },
          { value: 'local', label: 'Local path' },
        ]}
      />

      <div className="mt-5 min-h-[18rem]">
        {tab === 'github' &&
          (!connected ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <GitBranch className="h-8 w-8 text-muted" aria-hidden />
              <p className="max-w-xs text-sm text-muted">Connect a GitHub token to browse your repositories and open pull requests later.</p>
              <Link to="/settings" onClick={() => setConnect(false)}><Button variant="primary">Connect GitHub</Button></Link>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
                <input className="field pl-9" placeholder="Search your repositories" aria-label="Search GitHub repositories" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto pr-1">
                {repos.isLoading && Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12" />)}
                {repos.data?.length === 0 && <li className="py-8 text-center text-sm text-muted">No repositories match.</li>}
                {repos.data?.map((r) => (
                  <li key={r.fullName}>
                    <button type="button" disabled={create.isPending} onClick={() => void submit({ fullName: r.fullName })} className="flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-left transition hover:border-accent/30 hover:bg-fg/[0.04] disabled:opacity-50">
                      {r.private ? <Lock className="h-4 w-4 shrink-0 text-warn" aria-label="Private" /> : <Globe className="h-4 w-4 shrink-0 text-faint" aria-label="Public" />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{r.fullName}</span>
                        <span className="block truncate text-xs text-muted">{r.description ?? 'No description'}</span>
                      </span>
                      <span className="shrink-0 text-right text-xs text-faint">{r.language}<br />{timeAgo(r.updatedAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ))}

        {tab === 'url' && (
          <form onSubmit={(e) => { e.preventDefault(); void submit({ cloneUrl: url.trim() }); }}>
            <label className="label" htmlFor="clone-url">HTTPS clone URL</label>
            <input id="clone-url" className="field font-mono" placeholder="https://github.com/owner/repo.git" required value={url} onChange={(e) => setUrl(e.target.value)} />
            <p className="mt-2 text-xs text-faint">Public repositories work without a token. Never paste credentials into the URL.</p>
            <Button type="submit" variant="primary" loading={create.isPending} className="mt-5">Connect</Button>
          </form>
        )}

        {tab === 'local' && (
          <form onSubmit={(e) => { e.preventDefault(); void submit({ localPath: path.trim().replace(/^["']+|["']+$/g, '').trim() }); }}>
            <label className="label" htmlFor="local-path">Full path of a folder on this computer</label>
            <div className="relative">
              <HardDrive className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
              <input id="local-path" className="field pl-9 font-mono" placeholder="C:\Users\you\projects\my-app   or   /home/you/my-app" required value={path} onChange={(e) => setPath(e.target.value)} />
            </div>
            <p className="mt-2 text-xs text-faint">On Windows, hold Shift, right-click the folder and choose Copy as path, then paste it here. Use the Clone URL tab for GitHub links. Local folders only work while DevForge runs on your own computer.</p>
            <Button type="submit" variant="primary" loading={create.isPending} className="mt-5">Connect</Button>
          </form>
        )}
      </div>
    </Modal>
  );
}
