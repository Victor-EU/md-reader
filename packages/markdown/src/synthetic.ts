/**
 * Deterministic synthetic markdown with a realistic mix of blocks, sized
 * in bytes. Generated at run time from a seed, never committed, so the
 * 10 MB fixture costs the repository nothing.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const words =
  'the model writes a plan and the reader marks it up with highlights comments and colour before handing it back for another round of edits until both agree on every sentence table and formula in the document'.split(
    ' ',
  );

export function generateDocument(targetBytes: number, seed = 1): string {
  const rnd = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)] as T;
  const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
  const word = () => pick(words);
  const sentence = (n = int(6, 18)) => {
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      const w = word();
      const r = rnd();
      parts.push(
        r < 0.03
          ? `**${w}**`
          : r < 0.06
            ? `*${w}*`
            : r < 0.08
              ? `==${w}==`
              : r < 0.1
                ? `\`${w}\``
                : r < 0.11
                  ? `$${w}_i$`
                  : r < 0.12
                    ? `[${w}](https://example.com/${w})`
                    : w,
      );
    }
    const s = parts.join(' ');
    return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
  };
  const paragraph = () => Array.from({ length: int(1, 5) }, () => sentence()).join(' ');

  const blocks: (() => string)[] = [
    paragraph,
    paragraph,
    paragraph,
    paragraph,
    () => `${'#'.repeat(int(1, 3))} ${sentence(int(2, 6)).replace(/\.$/, '')}`,
    () =>
      Array.from(
        { length: int(2, 6) },
        () => `- ${rnd() < 0.3 ? `[${rnd() < 0.5 ? ' ' : 'x'}] ` : ''}${sentence(int(3, 10))}`,
      ).join('\n'),
    () =>
      Array.from({ length: int(2, 5) }, (_, i) => `${i + 1}. ${sentence(int(3, 10))}`).join('\n'),
    () => {
      const cols = int(2, 4);
      const row = () => `| ${Array.from({ length: cols }, () => word()).join(' | ')} |`;
      return [row(), `|${' --- |'.repeat(cols)}`, ...Array.from({ length: int(2, 6) }, row)].join(
        '\n',
      );
    },
    () =>
      `\`\`\`${pick(['js', 'python', 'rust', ''])}\n${Array.from({ length: int(2, 8) }, () => `${word()} = ${word()}(${int(0, 99)})`).join('\n')}\n\`\`\``,
    () => `$$\n\\sum_{i=0}^{${int(2, 9)}} ${word()}_i = \\frac{${word()}}{${word()}}\n$$`,
    () => `> [!${pick(['note', 'warning', 'tip'])}] ${sentence(int(2, 5))}\n> ${sentence()}`,
    () => `> ${sentence()}\n> ${sentence()}`,
    () => `<!-- ${pick(['note', 'question', 'rewrite'])}: ${sentence(int(3, 8))} -->`,
    () => '---',
  ];

  const out: string[] = [`---\ntitle: bench ${seed}\nsize: ${targetBytes}\n---`];
  let size = out[0]?.length ?? 0;
  while (size < targetBytes) {
    const block = pick(blocks)();
    out.push(block);
    size += block.length + 2;
  }
  return `${out.join('\n\n')}\n`;
}
