import type { NextFunction, Request, Response } from 'express';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { TASK_STATUSES } from '../models/domain.js';

/** Per-app registry so tests (and multiple apps in one process) never collide. */
export class Metrics {
  readonly registry = new Registry();
  readonly requests = new Counter({
    name: 'devforge_http_requests_total',
    help: 'HTTP requests',
    labelNames: ['method', 'route', 'status'],
    registers: [this.registry],
  });
  readonly duration = new Histogram({
    name: 'devforge_http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.02, 0.05, 0.1, 0.3, 1, 3, 10],
    registers: [this.registry],
  });
  readonly ws = new Gauge({ name: 'devforge_ws_connections', help: 'Open WebSocket connections', registers: [this.registry] });
  readonly tasks: Gauge<'status'>;
  readonly queueDepth: Gauge;

  constructor(collect: { taskCounts: () => Promise<Record<string, number>>; queueDepth: () => Promise<number> }) {
    collectDefaultMetrics({ register: this.registry, prefix: 'devforge_' });
    this.tasks = new Gauge({
      name: 'devforge_tasks_total',
      help: 'Tasks by status',
      labelNames: ['status'],
      registers: [this.registry],
      async collect() {
        const counts = await collect.taskCounts();
        for (const s of TASK_STATUSES) this.set({ status: s }, counts[s] ?? 0);
      },
    });
    this.queueDepth = new Gauge({
      name: 'devforge_queue_depth',
      help: 'Jobs waiting or active in the run queue',
      registers: [this.registry],
      async collect() {
        this.set(await collect.queueDepth());
      },
    });
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const end = this.duration.startTimer();
      res.on('finish', () => {
        const route = req.route ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched';
        const labels = { method: req.method, route, status: String(res.statusCode) };
        this.requests.inc(labels);
        end(labels);
      });
      next();
    };
  }
}
