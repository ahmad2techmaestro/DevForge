import clsx from 'clsx';
import { Highlight, Prism, type PrismTheme } from 'prism-react-renderer';
import { useEffect, useRef } from 'react';
import { extension } from '../../utils/format';

const tok = (name: string) => `rgb(var(--tok-${name}))`;

export const codeTheme: PrismTheme = {
  plain: { color: 'rgb(var(--fg))', backgroundColor: 'transparent' },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: tok('comment'), fontStyle: 'italic' } },
    { types: ['keyword', 'operator', 'atrule', 'selector', 'important'], style: { color: tok('keyword') } },
    { types: ['string', 'char', 'attr-value', 'template-string', 'inserted'], style: { color: tok('string') } },
    { types: ['number', 'boolean', 'constant', 'symbol'], style: { color: tok('number') } },
    { types: ['function', 'method', 'attr-name', 'property'], style: { color: tok('func') } },
    { types: ['class-name', 'builtin', 'tag', 'type'], style: { color: tok('type') } },
    { types: ['punctuation'], style: { color: 'rgb(var(--muted))' } },
  ],
};

const BY_EXTENSION: Record<string, string> = {
  ts: 'tsx', tsx: 'tsx', js: 'jsx', jsx: 'jsx', mjs: 'jsx', cjs: 'jsx', json: 'json', py: 'python', go: 'go', rs: 'rust',
  css: 'css', html: 'markup', xml: 'markup', svg: 'markup', md: 'markdown', yml: 'yaml', yaml: 'yaml', sql: 'sql',
  kt: 'kotlin', swift: 'swift', cpp: 'cpp', cc: 'cpp', h: 'cpp', graphql: 'graphql',
};

/** Maps a file path (or language label) to a Prism grammar that is actually loaded, else "plain". */
export function prismLanguage(path: string, language?: string): string {
  const candidate = BY_EXTENSION[extension(path)] ?? (language ? language.toLowerCase() : '');
  const mapped = candidate === 'typescript' ? 'tsx' : candidate === 'javascript' ? 'jsx' : candidate;
  return mapped && Prism.languages[mapped] ? mapped : 'plain';
}

const MAX_HIGHLIGHT_LINES = 3000;

interface CodeViewerProps {
  code: string;
  path: string;
  language?: string;
  highlightLine?: number | null;
}

export function CodeViewer({ code, path, language, highlightLine }: CodeViewerProps) {
  const target = useRef<HTMLDivElement>(null);
  const lineCount = code.split('\n').length;
  const lang = lineCount > MAX_HIGHLIGHT_LINES ? 'plain' : prismLanguage(path, language);

  useEffect(() => {
    target.current?.scrollIntoView({ block: 'center' });
  }, [highlightLine, path]);

  return (
    <Highlight theme={codeTheme} code={code.replace(/\n$/, '')} language={lang}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre className="min-w-max py-3 font-mono text-[12.5px] leading-[1.65]">
          {tokens.map((line, i) => {
            const n = i + 1;
            const active = n === highlightLine;
            return (
              <div
                key={i}
                ref={active ? target : undefined}
                {...getLineProps({ line })}
                className={clsx('flex px-0', active && 'bg-accent/15 shadow-[inset_2px_0_0_rgb(var(--accent))]')}
              >
                <span className="sticky left-0 w-12 shrink-0 select-none bg-surface pr-4 text-right text-faint">{n}</span>
                <span className="whitespace-pre pr-6">
                  {line.map((token, k) => (
                    <span key={k} {...getTokenProps({ token })} />
                  ))}
                  {line.length === 0 && ' '}
                </span>
              </div>
            );
          })}
        </pre>
      )}
    </Highlight>
  );
}

/** Single highlighted line, used by the diff viewer for syntax tint. */
export function CodeSpan({ code, path }: { code: string; path: string }) {
  const lang = prismLanguage(path);
  if (lang === 'plain') return <>{code}</>;
  return (
    <Highlight theme={codeTheme} code={code} language={lang}>
      {({ tokens, getTokenProps }) => (
        <>
          {tokens[0]?.map((token, k) => (
            <span key={k} {...getTokenProps({ token })} />
          ))}
        </>
      )}
    </Highlight>
  );
}
