export type DiffLineType = 'add' | 'del' | 'ctx';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface ParsedDiffFile {
  path: string;
  oldPath: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, '').replace(/\t.*$/, '');
}

/** Parses `git diff` style unified diff text into files, hunks and numbered lines. */
export function parseUnifiedDiff(text: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let file: ParsedDiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const startFile = (oldPath: string, path: string) => {
    file = { path, oldPath, status: 'modified', additions: 0, deletions: 0, binary: false, hunks: [] };
    files.push(file);
    hunk = null;
  };

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (git) {
      startFile(git[1], git[2]);
      continue;
    }
    if (!hunk && /^--- /.test(line)) {
      if (!file) startFile('', '');
      const f = file as ParsedDiffFile | null;
      if (f) {
        const p = line.slice(4);
        if (p.startsWith('/dev/null')) f.status = 'added';
        else if (!f.oldPath) f.oldPath = stripPrefix(p);
      }
      continue;
    }
    const f = file as ParsedDiffFile | null;
    if (!f) continue;
    if (!hunk) {
      if (/^\+\+\+ /.test(line)) {
        const p = line.slice(4);
        if (p.startsWith('/dev/null')) f.status = 'deleted';
        else if (!f.path) f.path = stripPrefix(p);
        continue;
      }
      if (line.startsWith('new file mode')) f.status = 'added';
      else if (line.startsWith('deleted file mode')) f.status = 'deleted';
      else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) f.binary = true;
    }
    const h = HUNK.exec(line);
    if (h) {
      hunk = { header: line, lines: [] };
      f.hunks.push(hunk);
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      continue;
    }
    if (!hunk) continue;
    const current: DiffHunk = hunk;
    if (line.startsWith('+')) {
      current.lines.push({ type: 'add', content: line.slice(1), oldNo: null, newNo: newNo++ });
      f.additions++;
    } else if (line.startsWith('-')) {
      current.lines.push({ type: 'del', content: line.slice(1), oldNo: oldNo++, newNo: null });
      f.deletions++;
    } else if (line.startsWith(' ')) {
      current.lines.push({ type: 'ctx', content: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
    // "\ No newline at end of file" and blank trailing lines are intentionally skipped.
  }
  return files;
}
