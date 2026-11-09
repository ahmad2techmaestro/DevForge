import { addUsage, emptyUsage, type EventDoc, type RepoDoc, type TaskDoc, type Usage } from '../models/domain.js';
import { toTask } from '../models/mappers.js';
import type { Store } from '../database/index.js';

const DAY_MS = 86_400_000;

export class StatsService {
  constructor(private readonly store: Store) {}

  async forUser(userId: string, today: Date = new Date()) {
    const [repos, tasks] = await Promise.all([
      this.store.find<RepoDoc>('repos', { userId }),
      this.store.find<TaskDoc>('tasks', { userId }, { sort: { createdAt: -1 } }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    const completed = byStatus.completed ?? 0;
    const failed = byStatus.failed ?? 0;
    const finished = completed + failed;

    let usage: Usage = emptyUsage();
    for (const t of tasks) usage = addUsage(usage, t.usage);
    for (const r of repos) if (r.usage) usage = addUsage(usage, r.usage);

    const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const days = Array.from({ length: 14 }, (_, i) => new Date(midnight - (13 - i) * DAY_MS).toISOString().slice(0, 10));
    const buckets = new Map(days.map((d) => [d, { date: d, tasks: 0, costUsd: 0 }]));
    for (const t of tasks) {
      const bucket = buckets.get(t.createdAt.slice(0, 10));
      if (bucket) {
        bucket.tasks += 1;
        bucket.costUsd += t.usage.costUsd;
      }
    }

    return {
      repos: repos.length,
      tasks: { total: tasks.length, byStatus },
      successRate: finished === 0 ? 0 : completed / finished,
      usage,
      daily: [...buckets.values()],
      byKind: this.byKind(tasks),
      avgDurationSec: this.avgDuration(tasks),
      recent: tasks.slice(0, 5).map(toTask),
    };
  }

  private byKind(tasks: TaskDoc[]): Record<string, { count: number; completed: number; failed: number; costUsd: number }> {
    const out: Record<string, { count: number; completed: number; failed: number; costUsd: number }> = {};
    for (const t of tasks) {
      const k = (out[t.kind] ??= { count: 0, completed: 0, failed: 0, costUsd: 0 });
      k.count += 1;
      if (t.status === 'completed') k.completed += 1;
      if (t.status === 'failed') k.failed += 1;
      k.costUsd += t.usage.costUsd;
    }
    return out;
  }

  private avgDuration(tasks: TaskDoc[]): number {
    const done = tasks.filter((t) => t.status === 'completed' && t.finishedAt);
    if (!done.length) return 0;
    const total = done.reduce((n, t) => n + (Date.parse(t.finishedAt as string) - Date.parse(t.createdAt)), 0);
    return Math.round(total / done.length / 1000);
  }

  /** Newest meaningful events across all of the user's tasks (tool calls, file edits, approvals, results). */
  async activity(userId: string, limit = 60) {
    const types = ['run.started', 'plan.proposed', 'approval.requested', 'approval.resolved', 'tool.call', 'file.changed', 'tests.result', 'review.result', 'pr.draft', 'run.completed', 'run.failed', 'run.cancelled'];
    const events = await this.store.find<EventDoc>('events', { userId, type: { $in: types } }, { sort: { receivedAt: -1 }, limit: Math.min(Math.max(limit, 1), 200) });
    const ids = [...new Set(events.map((e) => e.taskId))];
    const tasks = ids.length ? await this.store.find<TaskDoc>('tasks', { userId, id: { $in: ids } }) : [];
    const titles = new Map(tasks.map((t) => [t.id, t.title]));
    return events.map((e) => ({ taskId: e.taskId, taskTitle: titles.get(e.taskId) ?? 'Task', seq: e.seq, type: e.type, ts: e.ts, data: e.data }));
  }
}
