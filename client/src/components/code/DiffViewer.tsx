import clsx from 'clsx';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { parseUnifiedDiff, type ParsedDiffFile } from '../../utils/diff';
import { CodeSpan } from './CodeViewer';

const LINE_CAP = 600;

function FileDiff({ file, defaultOpen }: { file: ParsedDiffFile; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [all, setAll] = useState(false);
  const lines = file.hunks.flatMap((h) => [{ header: h.header, line: null as null }, ...h.lines.map((l) => ({ header: '', line: l }))]);
  const shown = all ? lines : lines.slice(0, LINE_CAP);
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 bg-raised px-3 py-2 text-left text-sm hover:bg-overlay">
        {open ? <ChevronDown className="h-4 w-4 text-faint" aria-hidden /> : <ChevronRight className="h-4 w-4 text-faint" aria-hidden />}
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
        <span className="text-xs capitalize text-faint">{file.status}</span>
        <span className="font-mono text-xs text-ok">+{file.additions}</span>
        <span className="font-mono text-xs text-bad">−{file.deletions}</span>
      </button>
      {open && (
        <div className="overflow-x-auto bg-surface">
          {file.binary ? <p className="p-3 text-xs text-muted">Binary file not shown.</p> : (
            <table className="w-full border-collapse font-mono text-[12.5px] leading-[1.6]">
              <tbody>
                {shown.map((row, i) =>
                  row.line === null ? (
                    <tr key={i} className="bg-info/10 text-info"><td colSpan={3} className="px-3 py-0.5 text-xs">{row.header}</td></tr>
                  ) : (
                    <tr key={i} className={clsx(row.line.type === 'add' && 'bg-ok/10', row.line.type === 'del' && 'bg-bad/10')}>
                      <td className="w-10 select-none px-2 text-right text-faint">{row.line.oldNo ?? ''}</td>
                      <td className="w-10 select-none px-2 text-right text-faint">{row.line.newNo ?? ''}</td>
                      <td className="whitespace-pre px-2">
                        <span aria-hidden className="mr-2 select-none text-faint">{row.line.type === 'add' ? '+' : row.line.type === 'del' ? '−' : ' '}</span>
                        <CodeSpan code={row.line.content} path={file.path} />
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          )}
          {!all && lines.length > LINE_CAP && <button type="button" onClick={() => setAll(true)} className="w-full border-t border-line py-2 text-xs text-accent2 hover:bg-fg/5">Show {lines.length - LINE_CAP} more lines</button>}
        </div>
      )}
    </div>
  );
}

export function DiffViewer({ diff }: { diff: string }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  if (files.length === 0) return <p className="text-sm text-muted">No changes.</p>;
  return <div className="space-y-3">{files.map((f, i) => <FileDiff key={f.path + i} file={f} defaultOpen={files.length <= 4} />)}</div>;
}
