/// <reference types="vite/client" />
import { generateDocument } from '@mdreader/markdown';

export interface CorpusFile {
  name: string;
  text: string;
  kind: 'adversarial' | 'generated' | 'synthetic';
}

/** Committed corpus files, read raw so BOM, CRLF, and a missing final newline survive. */
const committed = import.meta.glob('/corpus/{adversarial,generated}/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * The corpus: every committed file plus `synthetic` deterministic
 * documents from the generator, sized 2 KB to 22 KB. The synthetic set
 * gives the harness volume before the generated set exists; it is never
 * a substitute for real model output, which is what the plan's 1000 files
 * are for.
 */
export function corpusFiles(synthetic = 200): CorpusFile[] {
  const files: CorpusFile[] = Object.entries(committed)
    .map(([path, text]) => ({
      name: path.replace(/^\/corpus\//, ''),
      text,
      kind: (path.includes('/generated/') ? 'generated' : 'adversarial') as CorpusFile['kind'],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (let i = 0; i < synthetic; i++) {
    files.push({
      name: `synthetic/${String(i).padStart(4, '0')}.md`,
      text: generateDocument(2000 + ((i * 7919) % 20000), 1000 + i),
      kind: 'synthetic',
    });
  }
  return files;
}
