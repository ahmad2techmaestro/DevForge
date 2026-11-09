import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { Activity, FlaskConical, FolderGit2, KanbanSquare, Plug, LayoutDashboard, ListChecks, LogOut, Menu, Moon, ScrollText, Search, Settings, Sun, X } from 'lucide-react';
import { useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CommandPalette } from '../components/common/CommandPalette';
import { ConnectRepoModal } from '../components/repo/ConnectRepoModal';
import { ConnectionIndicator, OfflineBanner } from '../components/common/ConnectionIndicator';
import { Toaster } from '../components/ui/Toaster';
import { LogoMark } from '../components/ui/Logo';
import { useAuth } from '../store/auth';
import { useUi } from '../store/ui';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true, keys: 'g d' },
  { to: '/repos', label: 'Repositories', icon: FolderGit2, keys: 'g r' },
  { to: '/tasks', label: 'Tasks', icon: ListChecks, keys: 'g t' },
  { to: '/board', label: 'Board', icon: KanbanSquare, keys: 'g k' },
  { to: '/activity', label: 'Activity', icon: Activity, keys: 'g y' },
  { to: '/mcp', label: 'Tools (MCP)', icon: Plug, keys: 'g m' },
  { to: '/benchmarks', label: 'Benchmarks', icon: FlaskConical, keys: 'g b' },
  { to: '/audit', label: 'Audit log', icon: ScrollText, keys: 'g a' },
  { to: '/settings', label: 'Settings', icon: Settings, keys: 'g s' },
];

const GO: Record<string, string> = { d: '/', r: '/repos', t: '/tasks', b: '/benchmarks', m: '/mcp', k: '/board', y: '/activity', a: '/audit', s: '/settings' };

function useShortcuts() {
  const navigate = useNavigate();
  const setPalette = useUi((s) => s.setPalette);
  useEffect(() => {
    let armed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(!useUi.getState().paletteOpen);
        return;
      }
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (armed && GO[e.key]) {
        e.preventDefault();
        navigate(GO[e.key] as string);
      }
      armed = e.key === 'g';
      clearTimeout(timer);
      if (armed) timer = setTimeout(() => (armed = false), 900);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(timer);
    };
  }, [navigate, setPalette]);
}

/** Small round rail button with a hover label. */
function RailButton({ label, onClick, children, expanded }: { label: string; onClick: () => void; children: React.ReactNode; expanded?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={expanded ? undefined : label}
      className={clsx('group relative flex items-center gap-3 rounded-full text-[rgb(190_222_208)] transition hover:bg-white/10 hover:text-white', expanded ? 'h-11 w-full px-3.5' : 'h-10 w-10 justify-center')}
    >
      {children}
      {expanded && <span className="text-sm font-medium">{label}</span>}
    </button>
  );
}

/** The dark pill rail. Icon-only on desktop; with labels in the mobile drawer. */
function Rail({ expanded, onNavigate }: { expanded?: boolean; onNavigate?: () => void }) {
  const user = useAuth((s) => s.user);
  const clear = useAuth((s) => s.clear);
  const { theme, toggleTheme, setPalette } = useUi();
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (
    <div className={clsx('flex h-full flex-col items-center bg-rail py-4 text-white', expanded ? 'rounded-r-[32px] px-3' : 'rounded-full px-2')}>
      <div className={clsx('mb-4 flex items-center gap-3', expanded && 'w-full px-1.5')}>
        <LogoMark className="h-9 w-9 shrink-0" />
        {expanded && <span className="font-display text-lg font-medium">DevForge</span>}
      </div>
      <nav aria-label="Main" className="no-scrollbar flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto py-1">
        {NAV.map(({ to, label, icon: Icon, end, keys }) => (
          <NavLink key={to} to={to} end={end} aria-label={label} onClick={onNavigate} className="group relative block w-full">
            {({ isActive }) => (
              <span
                className={clsx(
                  'relative flex items-center gap-3 rounded-full transition',
                  expanded ? 'h-11 w-full px-3.5' : 'mx-auto h-10 w-10 justify-center',
                  isActive ? (expanded ? 'orb text-[rgb(10_46_36)]' : 'orb text-[rgb(10_46_36)]') : 'text-[rgb(190_222_208)] hover:bg-white/10 hover:text-white',
                )}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
                {expanded && <span className="text-sm font-medium">{label}</span>}
                {isActive && !expanded && <span aria-hidden className="absolute -right-[11px] top-1/2 h-4 w-1.5 -translate-y-1/2 rounded-r-full bg-rail" />}
                {!expanded && (
                  <span role="tooltip" className="pointer-events-none absolute left-full z-50 ml-4 flex items-center gap-2 whitespace-nowrap rounded-full bg-rail px-3 py-1.5 text-xs font-medium text-white opacity-0 shadow-pop transition group-hover:opacity-100 group-focus-visible:opacity-100">
                    {label}<span className="rounded bg-white/10 px-1 font-mono text-2xs text-[rgb(190_222_208)]">{keys}</span>
                  </span>
                )}
              </span>
            )}
          </NavLink>
        ))}
      </nav>
      <div className={clsx('mt-3 flex w-full flex-col items-center gap-1 border-t border-white/10 pt-3', expanded && 'items-stretch')}>
        <RailButton label="Search" expanded={expanded} onClick={() => { setPalette(true); onNavigate?.(); }}><Search className="h-[18px] w-[18px]" /></RailButton>
        <RailButton label={theme === 'dark' ? 'Light theme' : 'Dark theme'} expanded={expanded} onClick={toggleTheme}>{theme === 'dark' ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}</RailButton>
        <RailButton label="Sign out" expanded={expanded} onClick={() => { clear(); qc.clear(); navigate('/login'); }}><LogOut className="h-[18px] w-[18px]" /></RailButton>
        <div className={clsx('mt-2 flex items-center gap-3', expanded ? 'px-1.5' : 'flex-col')} title={user ? `${user.name} · ${user.email}` : undefined}>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-sm font-semibold" aria-hidden>{(user?.name ?? '?').slice(0, 1).toUpperCase()}</span>
          {expanded && <span className="min-w-0"><span className="block truncate text-sm font-medium">{user?.name}</span><span className="block truncate text-xs text-[rgb(190_222_208)]">{user?.email}</span></span>}
          <span className={clsx(expanded && 'ml-auto')}><ConnectionIndicator compact /></span>
        </div>
      </div>
    </div>
  );
}

export function Shell() {
  useShortcuts();
  const location = useLocation();
  const { sidebarOpen, setSidebar, setPalette } = useUi();
  const section = location.pathname.split('/')[1] ?? '';

  return (
    <div className="relative min-h-screen">
      <aside className="fixed bottom-4 left-4 top-4 z-30 hidden w-[60px] lg:block">
        <Rail />
      </aside>
      <AnimatePresence>
        {sidebarOpen && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden" onClick={() => setSidebar(false)} />
            <motion.aside initial={{ x: -280 }} animate={{ x: 0 }} exit={{ x: -280 }} transition={{ type: 'spring', stiffness: 380, damping: 36 }} className="fixed inset-y-0 left-0 z-50 w-64 lg:hidden">
              <button type="button" aria-label="Close navigation" onClick={() => setSidebar(false)} className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white"><X className="h-4 w-4" /></button>
              <Rail expanded onNavigate={() => setSidebar(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="lg:pl-[96px]">
        <OfflineBanner />
        <header className="sticky top-0 z-20 px-4 pt-4 sm:px-6">
          <div className="glass flex h-12 items-center gap-3 rounded-full border border-white/60 px-2 shadow-panel dark:border-white/10">
            <button type="button" aria-label="Open navigation" onClick={() => setSidebar(true)} className="flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-fg/5 lg:hidden"><Menu className="h-5 w-5" /></button>
            <button
              type="button"
              onClick={() => setPalette(true)}
              className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full px-3 text-sm text-faint transition-colors hover:text-muted"
            >
              <Search className="h-4 w-4 shrink-0" aria-hidden />
              <span className="flex-1 truncate text-left">Search or run a command</span>
              <span className="kbd">⌘K</span>
            </button>
            <div className="mr-3 hidden items-center gap-1.5 text-xs text-muted md:flex">
              <span>Jump with</span><span className="kbd">g</span><span>then</span><span className="kbd">d</span><span className="kbd">r</span><span className="kbd">t</span>
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1280px] px-4 pb-10 pt-6 sm:px-6">
          <motion.div key={section} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: 'easeOut' }}>
            <Outlet />
          </motion.div>
        </main>
      </div>

      <CommandPalette />
      <ConnectRepoModal />
      <Toaster />
    </div>
  );
}
