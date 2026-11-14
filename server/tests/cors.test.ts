import { describe, expect, it } from 'vitest';
import { corsMatchers } from '../src/config/env.js';

const allowed = (list: string[], origin: string): boolean =>
  corsMatchers(list).some((m) => (typeof m === 'string' ? m === origin : m.test(origin)));

describe('corsMatchers', () => {
  it('matches exact origins and ignores a trailing slash', () => {
    expect(allowed(['https://devforget.vercel.app/'], 'https://devforget.vercel.app')).toBe(true);
    expect(allowed(['https://devforget.vercel.app'], 'https://other.vercel.app')).toBe(false);
  });

  it('supports a wildcard for preview deployments', () => {
    const list = ['https://devforget-*.vercel.app'];
    expect(allowed(list, 'https://devforget-git-main-me.vercel.app')).toBe(true);
    expect(allowed(list, 'https://evil.com')).toBe(false);
    expect(allowed(list, 'https://devforget-x.vercel.app.evil.com')).toBe(false);
  });
});
