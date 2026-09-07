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
- `goldens/` rendered DOM snapshots per engine, from WP 1.4.

The test lives in `packages/editor-core/src/corpus/`. It also runs over
deterministic synthetic documents, so the harness has volume before the
generated set exists.
