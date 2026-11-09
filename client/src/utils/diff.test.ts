import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from './diff';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 one
-two
+two!
+three
 four
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
`;

describe('parseUnifiedDiff', () => {
  it('parses files, counts and line numbers', () => {
    const files = parseUnifiedDiff(DIFF);
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'new.txt']);
    expect(files[0]).toMatchObject({ additions: 2, deletions: 1, status: 'modified' });
    expect(files[0].hunks[0].lines[1]).toMatchObject({ type: 'del', oldNo: 2, newNo: null });
    expect(files[0].hunks[0].lines[2]).toMatchObject({ type: 'add', oldNo: null, newNo: 2 });
    expect(files[1].status).toBe('added');
  });
  it('returns nothing for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});
