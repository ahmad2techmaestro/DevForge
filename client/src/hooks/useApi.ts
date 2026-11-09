import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api/endpoints';
import type { ApprovalDecision, CreatePrInput, CreateRepoInput, CreateTaskInput, Repo, Task, TaskStatus } from '../types/index';

export const keys = {
  me: ['me'] as const,
  stats: ['stats'] as const,
  repos: ['repos'] as const,
  repo: (id: string) => ['repo', id] as const,
  tree: (id: string) => ['tree', id] as const,
  file: (id: string, path: string) => ['file', id, path] as const,
  graph: (id: string) => ['graph', id] as const,
  health: (id: string) => ['health', id] as const,
  chats: (id: string) => ['chats', id] as const,
  chat: (id: string, threadId: string) => ['chat', id, threadId] as const,
  tasks: (filters: object) => ['tasks', filters] as const,
  task: (id: string) => ['task', id] as const,
  diff: (id: string) => ['diff', id] as const,
  issues: (id: string) => ['issues', id] as const,
  memory: (id: string) => ['memory', id] as const,
  audit: ['audit'] as const,
  reviews: (id: string) => ['reviews', id] as const,
  ci: (id: string) => ['ci', id] as const,
  budget: ['budget'] as const,
  notifications: ['notifications'] as const,
  mcp: ['mcp'] as const,
  activity: ['activity'] as const,
  benchmark: ['benchmark'] as const,
  benchStatus: ['benchmark', 'status'] as const,
  github: (q: string) => ['github-repos', q] as const,
  apiHealth: ['api-health'] as const,
};

export const useMe = (enabled = true) => useQuery({ queryKey: keys.me, queryFn: api.me, enabled, staleTime: 30_000 });
export const useStats = () => useQuery({ queryKey: keys.stats, queryFn: api.stats, refetchInterval: 30_000 });
export const useApiHealth = () => useQuery({ queryKey: keys.apiHealth, queryFn: api.apiHealth, refetchInterval: 15_000, retry: false });

export const useRepos = () =>
  useQuery({
    queryKey: keys.repos,
    queryFn: async () => (await api.repos()).items,
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'indexing') ? 3000 : false),
  });

export const useRepo = (id: string) =>
  useQuery({
    queryKey: keys.repo(id),
    queryFn: () => api.repo(id),
    refetchInterval: (q) => (q.state.data?.status === 'indexing' ? 3000 : false),
  });

export const useTree = (id: string, enabled = true) =>
  useQuery({ queryKey: keys.tree(id), queryFn: async () => (await api.tree(id)).files, enabled, staleTime: 60_000 });

export const useFile = (id: string, path: string | null) =>
  useQuery({ queryKey: keys.file(id, path ?? ''), queryFn: () => api.file(id, path ?? ''), enabled: !!path, staleTime: 60_000 });

export const useGraph = (id: string) => useQuery({ queryKey: keys.graph(id), queryFn: () => api.graph(id), staleTime: 60_000 });
export const useHealth = (id: string, enabled = true) =>
  useQuery({ queryKey: keys.health(id), queryFn: () => api.health(id), enabled, staleTime: 60_000 });

export const useChats = (id: string) => useQuery({ queryKey: keys.chats(id), queryFn: async () => (await api.chats(id)).items });
export const useChatThread = (id: string, threadId: string | null) =>
  useQuery({ queryKey: keys.chat(id, threadId ?? ''), queryFn: () => api.chatThread(id, threadId ?? ''), enabled: !!threadId });

export const useGithubRepos = (query: string, enabled: boolean) =>
  useQuery({
    queryKey: keys.github(query),
    queryFn: async () => (await api.githubRepos(query)).items,
    enabled,
    placeholderData: keepPreviousData,
  });

export interface TaskFilters {
  repoId?: string;
  status?: TaskStatus;
}

export const useTasks = (filters: TaskFilters = {}) =>
  useInfiniteQuery({
    queryKey: keys.tasks(filters),
    queryFn: ({ pageParam }) => api.tasks({ ...filters, limit: 20, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const useTask = (id: string) => useQuery({ queryKey: keys.task(id), queryFn: () => api.task(id) });
export const useTaskDiff = (id: string, enabled: boolean) =>
  useQuery({ queryKey: keys.diff(id), queryFn: () => api.taskDiff(id), enabled, staleTime: 30_000 });

export const useAudit = () =>
  useInfiniteQuery({
    queryKey: keys.audit,
    queryFn: ({ pageParam }) => api.audit(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export function useCreateRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRepoInput) => api.createRepo(input),
    onSuccess: (repo) => {
      qc.setQueryData<Repo[]>(keys.repos, (old) => (old ? [repo, ...old.filter((r) => r.id !== repo.id)] : [repo]));
      void qc.invalidateQueries({ queryKey: keys.stats });
    },
  });
}

export function useDeleteRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteRepo(id),
    onSuccess: (_r, id) => {
      qc.setQueryData<Repo[]>(keys.repos, (old) => old?.filter((r) => r.id !== id));
      void qc.invalidateQueries({ queryKey: keys.stats });
    },
  });
}

export function useReindexRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.reindexRepo(id),
    onSuccess: (repo) => {
      qc.setQueryData(keys.repo(repo.id), repo);
      void qc.invalidateQueries({ queryKey: keys.repos });
    },
  });
}

export function useCreateTask(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => api.createTask(repoId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: keys.stats });
    },
  });
}

function useTaskMutationCache(taskId: string) {
  const qc = useQueryClient();
  return (task: Task) => {
    qc.setQueryData<{ task: Task } | undefined>(keys.task(taskId), (old) => (old ? { ...old, task } : old));
    void qc.invalidateQueries({ queryKey: ['tasks'] });
  };
}

export function useCancelTask(taskId: string) {
  const update = useTaskMutationCache(taskId);
  return useMutation({ mutationFn: () => api.cancelTask(taskId), onSuccess: update });
}

export function useResolveApproval(taskId: string) {
  const qc = useQueryClient();
  const update = useTaskMutationCache(taskId);
  return useMutation({
    mutationFn: ({ approvalId, ...decision }: ApprovalDecision & { approvalId: string }) =>
      api.resolveApproval(taskId, approvalId, decision),
    onSuccess: ({ task }) => {
      update(task);
      void qc.invalidateQueries({ queryKey: keys.task(taskId) });
    },
  });
}

export function useCreatePr(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePrInput) => api.createPr(taskId, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.task(taskId) }),
  });
}

export const useIssues = (id: string, enabled: boolean) =>
  useQuery({ queryKey: keys.issues(id), queryFn: async () => (await api.issues(id)).items, enabled, retry: false });

export function useRunIssue(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (number: number) => api.runIssue(repoId, number),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.issues(repoId) });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: keys.stats });
    },
  });
}

export const useMemoryNotes = (id: string) => useQuery({ queryKey: keys.memory(id), queryFn: async () => (await api.memory(id)).items });

export function useMemoryMutations(repoId: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: keys.memory(repoId) });
  return {
    add: useMutation({ mutationFn: (text: string) => api.addMemory(repoId, text), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (noteId: string) => api.deleteMemory(repoId, noteId), onSuccess: refresh }),
  };
}

export const useReviews = (id: string) => useQuery({ queryKey: keys.reviews(id), queryFn: async () => (await api.reviews(id)).items });
export const useCiRuns = (id: string, enabled = true) => useQuery({ queryKey: keys.ci(id), queryFn: async () => (await api.ciRuns(id)).items, enabled, retry: false });
export const useBudget = () => useQuery({ queryKey: keys.budget, queryFn: api.budget });
export const useNotifications = () => useQuery({ queryKey: keys.notifications, queryFn: api.notifications });
export const useBenchmark = () => useQuery({ queryKey: keys.benchmark, queryFn: api.benchmark, retry: false });
export const useBenchStatus = () =>
  useQuery({ queryKey: keys.benchStatus, queryFn: api.benchmarkStatus, retry: false, refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false) });
export function useRunBenchmark() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (limit?: number) => api.runBenchmark(limit), onSuccess: (status) => qc.setQueryData(keys.benchStatus, status) });
}

export const useMcpServers = () => useQuery({ queryKey: keys.mcp, queryFn: async () => (await api.mcpServers()).items });
export function useMcpMutations() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: keys.mcp });
  return {
    add: useMutation({ mutationFn: api.addMcp, onSuccess: refresh }),
    toggle: useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.toggleMcp(id, enabled), onSuccess: refresh }),
    test: useMutation({ mutationFn: api.testMcp, onSuccess: refresh }),
    remove: useMutation({ mutationFn: api.deleteMcp, onSuccess: refresh }),
  };
}

export const useActivity = () => useQuery({ queryKey: keys.activity, queryFn: async () => (await api.activity(80)).items, refetchInterval: 5_000 });
