import { AgentClient } from '../integrations/aiService.js';
import { GithubClient } from '../integrations/github.js';
import type { Config } from './env.js';
import { SecretBox } from '../utils/crypto.js';
import { TASK_STATUSES } from '../models/domain.js';
import type { Logger } from './logger.js';
import { Metrics } from '../monitoring/metrics.js';
import { Bus } from '../realtime/bus.js';
import { Hub } from '../realtime/hub.js';
import { RunQueue } from '../realtime/queue.js';
import { IssueService } from '../services/issues.js';
import { MemoryService } from '../services/memory.js';
import { McpService } from '../services/mcp.js';
import { BudgetService } from '../services/budget.js';
import { CiService } from '../services/ci.js';
import { NotifyService } from '../services/notify.js';
import { ReviewService } from '../services/reviews.js';
import { OAuthService } from '../services/oauth.js';
import { AuditService } from '../services/audit.js';
import { AccountService, AuthService } from '../services/auth.js';
import { RepoService } from '../services/repos.js';
import { StatsService } from '../services/stats.js';
import { TaskService } from '../services/tasks.js';
import { createStore, type Store } from '../database/index.js';

export interface Container {
  config: Config;
  log: Logger;
  store: Store;
  bus: Bus;
  agent: AgentClient;
  github: GithubClient;
  audit: AuditService;
  auth: AuthService;
  oauth: OAuthService;
  budget: BudgetService;
  notify: NotifyService;
  reviews: ReviewService;
  ci: CiService;
  account: AccountService;
  repos: RepoService;
  tasks: TaskService;
  memory: MemoryService;
  mcp: McpService;
  issues: IssueService;
  stats: StatsService;
  queue: RunQueue;
  hub: Hub;
  metrics: Metrics;
  startedAt: number;
  close(): Promise<void>;
}


export async function buildContainer(config: Config, log: Logger): Promise<Container> {
  const store = await createStore(config);
  const bus = new Bus(config.redisUrl, log);
  await bus.start();
  const agent = new AgentClient(config);
  const github = new GithubClient(config);
  const box = new SecretBox(config.encryptionKey);
  const audit = new AuditService(store, log);
  const auth = new AuthService(store, config, audit);
  const oauth = new OAuthService(store, config, auth, audit, box);
  const account = new AccountService(store, github, agent, box, audit);
  const repos = new RepoService(store, agent, bus, account, audit, config, log);
  const tasks = new TaskService(store, agent, github, bus, repos, account, audit, config, log);
  const memory = new MemoryService(store, repos);
  tasks.attachMemory(memory);
  const mcp = new McpService(store, agent, box, audit);
  tasks.attachMcp(mcp);
  const budget = new BudgetService(store);
  const notify = new NotifyService(store, box, config);
  tasks.attachBudget(budget);
  tasks.attachNotify(notify);
  const reviews = new ReviewService(store, agent, github, account, repos, audit, notify);
  const ci = new CiService(store, agent, github, account, repos, tasks, audit, notify);
  const issues = new IssueService(store, github, account, repos, tasks, audit, config);
  const stats = new StatsService(store);
  const queue = new RunQueue(config, tasks, log);
  tasks.attachDispatcher(queue);
  queue.startWorker();

  const metrics = new Metrics({
    taskCounts: async () => {
      const entries = await Promise.all(TASK_STATUSES.map(async (s) => [s, await store.count('tasks', { status: s })] as const));
      return Object.fromEntries(entries);
    },
    queueDepth: () => queue.depth().catch(() => 0),
  });
  const hub = new Hub(auth, store, bus, metrics, log);

  return {
    config, log, store, bus, agent, github, audit, auth, oauth, budget, notify, reviews, ci, account, repos, tasks, memory, mcp, issues, stats, queue, hub, metrics,
    startedAt: Date.now(),
    async close() {
      hub.close();
      await queue.close();
      await bus.close();
      await store.close();
    },
  };
}
