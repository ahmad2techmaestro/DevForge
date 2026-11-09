import { describe, expect, it } from 'vitest';
import { fuzzyMatch, rank } from './fuzzy';

describe('fuzzy', () => {
  it('matches subsequences and rejects others', () => {
    expect(fuzzyMatch('tsk', 'tasks')).not.toBeNull();
    expect(fuzzyMatch('xyz', 'tasks')).toBeNull();
  });
  it('ranks prefix and word-start matches first', () => {
    const out = rank(['src/lib/a-task.ts', 'tasks.ts', 'x_t_a_s_k.ts'], 'task', (s) => s).map((r) => r.item);
    expect(out[0]).toBe('tasks.ts');
  });
  it('returns everything for an empty query, capped by limit', () => {
    expect(rank(['a', 'b', 'c'], '', (s) => s, 2)).toHaveLength(2);
  });
});
