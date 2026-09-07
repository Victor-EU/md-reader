# corpus-gen

Produces `corpus/generated/*.md` from model APIs with a manifest recording
model, prompt category, and date (plan section 7.1). Plain Node, no
dependencies; keys come from the environment.

```
ANTHROPIC_API_KEY=... node tools/corpus-gen/generate.mjs --provider anthropic --model claude-sonnet-5 --category plan --count 20
OPENAI_API_KEY=...    node tools/corpus-gen/generate.mjs --provider openai --model gpt-5 --category report --count 20
```

Categories: `plan`, `report`, `notes`, `spec`, `review`, matching the
design's audience list. Each prompt asks for tables, code, math, callouts,
task lists, and nested lists in varying measure, and tells the model not to
quote external sources, because the output is committed under the
repository license. Nothing is run in CI; a person runs it, reviews the
files, and commits them with the updated `manifest.json`.
