#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const categories = {
  plan: 'a project plan with phases, milestones, owners, and risks',
  report: 'a status report on a technical project, with metrics and next steps',
  notes: 'research notes comparing three approaches to a technical problem',
  spec: 'a short technical specification with requirements and an API sketch',
  review: 'a review summary of a document, with findings, questions, and recommended changes',
};

const features = [
  'at least one GFM table',
  'a fenced code block with a language',
  'inline math and one block of display math using dollar signs',
  'a callout such as > [!note] or > [!warning]',
  'a task list with some items checked',
  'a nested list at least three levels deep',
  'a numbered list',
  'bold, italic, and ==highlighted== text',
  'a blockquote',
  'a horizontal rule',
];

function args() {
  const out = {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    category: 'plan',
    count: 5,
    out: 'corpus/generated',
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (key && key in out) out[key] = key === 'count' ? Number(argv[i + 1]) : argv[i + 1];
  }
  if (!(out.category in categories)) throw new Error(`unknown category ${out.category}`);
  return out;
}

function prompt(category, seed) {
  const picked = features.filter((_, i) => (seed >> i) & 1);
  const wanted = picked.length ? picked : features.slice(0, 3);
  const words = 300 + (seed % 7) * 250;
  return [
    `Write ${categories[category]} in Markdown, about ${words} words.`,
    `Include: ${wanted.join('; ')}.`,
    'Invent all names, numbers, and content. Do not quote or reproduce any existing text, book, article, or website.',
    'Output only the Markdown document, no preamble and no code fence around the whole document.',
  ].join('\n');
}

async function anthropic(model, text) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 4000, messages: [{ role: 'user', content: text }] }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content.map((c) => c.text ?? '').join('');
}

async function openai(model, text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function main() {
  const opts = args();
  const call = opts.provider === 'openai' ? openai : anthropic;
  await mkdir(opts.out, { recursive: true });
  const manifestPath = join(opts.out, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => '[]'));
  const date = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < opts.count; i++) {
    const seed = (manifest.length * 31 + i * 17) % 1024;
    const text = prompt(opts.category, seed);
    const body = await call(opts.model, text);
    const promptSha = createHash('sha256').update(text).digest('hex').slice(0, 12);
    const file = `${String(manifest.length).padStart(4, '0')}-${opts.category}-${opts.model.replace(/[^a-z0-9]+/gi, '-')}.md`;
    await writeFile(join(opts.out, file), body.endsWith('\n') ? body : `${body}\n`);
    manifest.push({
      file,
      provider: opts.provider,
      model: opts.model,
      category: opts.category,
      promptSha,
      date,
      bytes: Buffer.byteLength(body),
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`wrote ${file}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
