import type { QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { WS_URL } from '../../config/index';
import { useConnection } from '../../store/connection';
import { mergeEvent } from '../../utils/run';
import { keys } from '../../hooks/useApi';
import type { Repo, ServerMessage, TaskDetail } from '../../types/index';
import { WsClient } from './ws';

let client: WsClient | null = null;
const wanted = new Map<string, number>();

/** Applies one server push to the react-query cache so every screen updates without refetching. */
export function applyServerMessage(qc: QueryClient, msg: ServerMessage): void {
  switch (msg.type) {
    case 'task.updated': {
      const { task } = msg;
      qc.setQueryData<TaskDetail | undefined>(keys.task(task.id), (old) => (old ? { ...old, task } : old));
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: keys.stats });
      break;
    }
    case 'repo.updated': {
      const { repo } = msg;
      qc.setQueryData<Repo>(keys.repo(repo.id), repo);
      qc.setQueryData<Repo[]>(keys.repos, (old) => {
        if (!old) return old;
        return old.some((r) => r.id === repo.id) ? old.map((r) => (r.id === repo.id ? repo : r)) : [repo, ...old];
      });
      break;
    }
    case 'event': {
      qc.setQueryData<TaskDetail | undefined>(keys.task(msg.taskId), (old) =>
        old ? { ...old, events: mergeEvent(old.events, msg.event) } : old,
      );
      const type = msg.event.type;
      if (type === 'approval.requested' || type === 'approval.resolved') void qc.invalidateQueries({ queryKey: keys.task(msg.taskId) });
      if (type === 'diff.ready') void qc.invalidateQueries({ queryKey: keys.diff(msg.taskId) });
      break;
    }
    default:
      break;
  }
}

export function startLive(qc: QueryClient, getToken: () => string | null, onAuthFailure: () => void): () => void {
  const setStatus = useConnection.getState().set;
  client = new WsClient({
    url: () => {
      const token = getToken();
      return token ? `${WS_URL}?token=${encodeURIComponent(token)}` : null;
    },
    onMessage: (msg) => applyServerMessage(qc, msg),
    onStatus: setStatus,
    onAuthFailure,
    onReconnected: () => void qc.invalidateQueries(),
  });
  for (const id of wanted.keys()) client.subscribe(id);
  client.start();
  return () => {
    client?.stop();
    client = null;
  };
}

/** Streams live events for a task while the component is mounted. */
export function useTaskSubscription(taskId: string): void {
  useEffect(() => {
    wanted.set(taskId, (wanted.get(taskId) ?? 0) + 1);
    client?.subscribe(taskId);
    return () => {
      const left = (wanted.get(taskId) ?? 1) - 1;
      if (left > 0) {
        wanted.set(taskId, left);
        return;
      }
      wanted.delete(taskId);
      client?.unsubscribe(taskId);
    };
  }, [taskId]);
}
