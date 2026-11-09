import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { configureClient } from './services/api/client';
import { startLive } from './services/realtime/live';
import { Shell } from './layouts/Shell';
import { AuditPage } from './pages/Audit';
import { BenchmarksPage } from './pages/Benchmarks';
import { McpPage } from './pages/Mcp';
import { BoardPage } from './pages/Board';
import { ActivityPage } from './pages/Activity';
import { AuthPage } from './pages/Auth';
import { OAuthCallback } from './pages/OAuthCallback';
import { Dashboard } from './pages/Dashboard';
import { Landing } from './pages/Landing';
import { NotFound } from './pages/NotFound';
import { Repos } from './pages/Repos';
import { SettingsPage } from './pages/Settings';
import { AllTasks } from './pages/Tasks';
import { TaskDetail } from './pages/TaskDetail';
import { CiTab } from './pages/repo/CI';
import { ImpactTab } from './pages/repo/Impact';
import { ReviewsTab } from './pages/repo/Reviews';
import { SearchTab } from './pages/repo/Search';
import { BugsTab } from './pages/repo/Bugs';
import { ChatTab } from './pages/repo/Chat';
import { FilesTab } from './pages/repo/Files';
import { GraphTab } from './pages/repo/Graph';
import { HealthTab } from './pages/repo/Health';
import { Overview } from './pages/repo/Overview';
import { RepoLayout } from './pages/repo/RepoLayout';
import { IssuesTab } from './pages/repo/Issues';
import { MemoryTab } from './pages/repo/Memory';
import { RepoTasks } from './pages/repo/RepoTasks';
import { SecurityTab } from './pages/repo/Security';
import { useAuth } from './store/auth';

function Protected() {
  const token = useAuth((s) => s.token);
  const location = useLocation();
  if (!token) {
    return location.pathname === '/' ? <Navigate to="/welcome" replace /> : <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Shell />;
}

export function App() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const token = useAuth((s) => s.token);

  useEffect(() => {
    configureClient({
      getToken: () => useAuth.getState().token,
      onUnauthorized: () => {
        useAuth.getState().clear();
        qc.clear();
        navigate('/login', { replace: true });
      },
    });
  }, [navigate, qc]);

  useEffect(() => {
    if (!token) return;
    return startLive(qc, () => useAuth.getState().token, () => {
      useAuth.getState().clear();
      navigate('/login', { replace: true });
    });
  }, [token, qc, navigate]);

  return (
    <Routes>
      <Route path="/auth/callback" element={<OAuthCallback />} />
      <Route path="/welcome" element={<Landing />} />
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route element={<Protected />}>
        <Route index element={<Dashboard />} />
        <Route path="repos" element={<Repos />} />
        <Route path="repos/:repoId" element={<RepoLayout />}>
          <Route index element={<Overview />} />
          <Route path="files" element={<FilesTab />} />
          <Route path="chat" element={<ChatTab />} />
          <Route path="graph" element={<GraphTab />} />
          <Route path="search" element={<SearchTab />} />
          <Route path="impact" element={<ImpactTab />} />
          <Route path="reviews" element={<ReviewsTab />} />
          <Route path="ci" element={<CiTab />} />
          <Route path="health" element={<HealthTab />} />
          <Route path="bugs" element={<BugsTab />} />
          <Route path="security" element={<SecurityTab />} />
          <Route path="issues" element={<IssuesTab />} />
          <Route path="memory" element={<MemoryTab />} />
          <Route path="tasks" element={<RepoTasks />} />
        </Route>
        <Route path="tasks" element={<AllTasks />} />
        <Route path="tasks/:taskId" element={<TaskDetail />} />
        <Route path="board" element={<BoardPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="mcp" element={<McpPage />} />
        <Route path="benchmarks" element={<BenchmarksPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
