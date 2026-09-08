/// <reference types="vite/client" />
import { generateDocument } from './synthetic.ts';

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

/**
 * The golden set of plan 7.2: every adversarial file plus a fixed sample of
 * the generated ones, spread evenly over the sorted list so the sample
 * covers every prompt category and model. Snapshotting the whole corpus
 * would turn one CSS change into a two-thousand-file diff that no human
 * would read.
 */
export function goldenSet(sample = 100): CorpusFile[] {
  const files = corpusFiles(0);
  const generated = files.filter((file) => file.kind === 'generated');
  const take = Math.min(sample, generated.length);
  const chosen: CorpusFile[] = [];
  for (let i = 0; i < take; i++) {
    const at = take === 1 ? 0 : Math.round((i * (generated.length - 1)) / (take - 1));
    chosen.push(generated[at] as CorpusFile);
  }
  return [...files.filter((file) => file.kind === 'adversarial'), ...chosen];
}
