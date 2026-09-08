# Corpus

The round-trip corpus from design section 10 and plan section 7.1.

- `adversarial/` hand-written edge cases. Every file has a header comment naming
  what it exercises. Files are byte-exact (`-text` in `.gitattributes`): some carry
  CRLF, a BOM, tabs, or no final newline on purpose. Every bug found in the wild
  adds its reduced file here with a comment naming the bug.
- `generated/` AI-generated documents produced by `tools/corpus-gen`, with
  `manifest.json` recording model, prompt category, and date. Regenerated
  quarterly; the old set is kept; a file that once failed is never deleted.
  Empty until the repository license is decided, because generated text is
  committed under it.
- `goldens/read/` the rendered document for every adversarial file and a fixed
  sample of a hundred generated ones, from WP 1.4. One file per source file
  rather than one per engine: the renderer is ours and builds the same nodes
  everywhere, and the browser test mounts them in Chromium and WebKit and
  compares both against this one file. `vitest -u` rewrites them, and the
  diff in the pull request is the review.
- `goldens/copy-for-ai/` what Copy for AI writes for the fixtures that carry
  marks or comments, from WP 1.6. The generated annotations section is the
  only thing the app ever puts in front of a model that the file itself does
  not say, so its wording is reviewed the same way a rendering is.

WP 1.5 added the design 5.2 leniency cases that had no file of their own
(`leniency.md`), and one file per construct that work package brought in:
`footnotes.md`, `callout-types.md`, `html-whitelist.md`, `images.md`,
`frontmatter-properties.md`, and `mdx-as-markdown.md`. Their goldens are
the record of what "most plausible intent" means for each case, so a
change to any of them is a rendering decision to be reviewed as one.

WP 1.6 added the four annotation commands to the action catalog — highlight,
strikethrough, a palette colour with its pre-filled note, and a comment in
both its anchored and its block form — so the round-trip test now exercises
every edit design 4.3 describes.

`packages/markdown/src/corpus.ts` is the one list of what the corpus is;
the round-trip test over it lives in `packages/editor-core/src/corpus/` and
the read-mode tests in `packages/markdown/src/render/`. Both also run over
deterministic synthetic documents, so the harness has volume before the
generated set grows.
