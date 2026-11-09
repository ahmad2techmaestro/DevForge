import type { Store } from '../database/index.js';
import type { TaskDoc, UserDoc } from '../models/domain.js';
import { AppError, badRequest } from '../utils/errors.js';

const monthStart = (d = new Date()): string => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();

/** Monthly spend cap for agent runs (model cost reported by the agent service). */
export class BudgetService {
  constructor(private readonly store: Store) {}

  async spent(userId: string): Promise<number> {
    const tasks = await this.store.find<TaskDoc>('tasks', { userId, createdAt: { $gte: monthStart() } });
    return Math.round(tasks.reduce((s, t) => s + (t.usage?.costUsd ?? 0), 0) * 1e6) / 1e6;
  }

  async status(userId: string): Promise<{ budgetUsd: number | null; spentUsd: number; remainingUsd: number | null; monthStart: string }> {
    const user = await this.store.findOne<UserDoc>('users', { id: userId });
    const budgetUsd = user?.budgetUsd ?? null;
    const spentUsd = await this.spent(userId);
    return { budgetUsd, spentUsd, remainingUsd: budgetUsd === null ? null : Math.max(0, Math.round((budgetUsd - spentUsd) * 1e6) / 1e6), monthStart: monthStart() };
  }

  async set(userId: string, budgetUsd: number | null): Promise<ReturnType<BudgetService['status']>> {
    if (budgetUsd !== null && (!Number.isFinite(budgetUsd) || budgetUsd < 0 || budgetUsd > 100_000)) throw badRequest('validation_error', 'Budget must be between 0 and 100000 USD');
    await this.store.updateOne('users', { id: userId }, { $set: { budgetUsd } });
    return this.status(userId);
  }

  /** Throws 402 when this month's spend has reached the cap. */
  async assertWithinBudget(userId: string): Promise<void> {
    const s = await this.status(userId);
    if (s.budgetUsd !== null && s.spentUsd >= s.budgetUsd) {
      throw new AppError(402, 'budget_exceeded', `Monthly budget of $${s.budgetUsd.toFixed(2)} reached ($${s.spentUsd.toFixed(2)} spent). Raise it in Settings to continue.`);
    }
  }
}
