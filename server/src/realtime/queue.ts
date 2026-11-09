import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { Config } from '../config/env.js';
import type { Logger } from '../config/logger.js';
import type { RunDispatcher, TaskService } from '../services/tasks.js';

type QueueConfig = Pick<Config, 'redisUrl' | 'queueName' | 'queueConcurrency' | 'queueAttempts' | 'queueBackoffMs'>;

/** BullMQ queue that hands queued tasks to the agent service, retrying when it is unreachable. */
export class RunQueue implements RunDispatcher {
  private readonly queueConn: Redis;
  private readonly workerConn: Redis;
  private readonly queue: Queue<{ taskId: string }>;
  private worker: Worker<{ taskId: string }> | null = null;

  constructor(
    private readonly config: QueueConfig,
    private readonly tasks: TaskService,
    private readonly log: Logger,
  ) {
    this.queueConn = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    this.workerConn = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    for (const c of [this.queueConn, this.workerConn]) c.on('error', (err: Error) => this.log.warn({ err: err.message }, 'queue redis error'));
    this.queue = new Queue(config.queueName, { connection: this.queueConn });
  }

  startWorker(): void {
    this.worker = new Worker(this.config.queueName, (job: Job<{ taskId: string }>) => this.tasks.dispatch(job.data.taskId), {
      connection: this.workerConn,
      concurrency: this.config.queueConcurrency,
    });
    this.worker.on('failed', (job, err) => {
      if (!job) return;
      const final = job.attemptsMade >= (job.opts.attempts ?? 1);
      this.log.warn({ taskId: job.data.taskId, attempt: job.attemptsMade, final, err: err.message }, 'run dispatch failed');
      if (final) void this.tasks.fail(job.data.taskId, `Could not start the agent run: ${err.message}`);
    });
    this.worker.on('error', (err) => this.log.warn({ err: err.message }, 'worker error'));
  }

  async enqueue(taskId: string): Promise<void> {
    await this.queue.add(
      'run',
      { taskId },
      {
        jobId: taskId,
        attempts: this.config.queueAttempts,
        backoff: { type: 'exponential', delay: this.config.queueBackoffMs },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    );
  }

  async remove(taskId: string): Promise<void> {
    const job = await this.queue.getJob(taskId);
    await job?.remove();
  }

  async depth(): Promise<number> {
    const c = await this.queue.getJobCounts('waiting', 'active', 'delayed');
    return (c.waiting ?? 0) + (c.active ?? 0) + (c.delayed ?? 0);
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.queueConn.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    await Promise.allSettled([this.queueConn.quit(), this.workerConn.quit()]);
  }
}
