# ADR 0033: MIT for the repository

Status: accepted 2026-09-10 and superseded the same day by
[ADR 0034](0034-gpl-3.0-license.md), which moves the repository to
GPL-3.0-only. Kept as the record of why MIT was chosen first. Settled the
question ADR 0001 left open.

The repository is MIT licensed, copyright 2026 Victor Zhang. `LICENSE` is
at the root; every `package.json` and every crate carries the SPDX
identifier so a consumer of any one piece can read it without the root.

## It is late

Build plan WP 0.1 asked for the licence first, and said why: "The license
must exist before the first corpus file is committed." Section 12 lists it
beside the bundle identifier as one of the two things that are hard to
change once file associations, the updater, and the corpus exist. All three
now exist, and 182 generated corpus files went in without it. ADR 0001 said
a placeholder would be worse than none and that this had to be settled
before the first corpus file landed; ADR 0005 and ADR 0017 each recorded it
still open as they went past.

That is worth writing down rather than quietly tidying, because the cost
was real: `corpus/README.md` has been telling anyone who read it that
`generated/` is "empty until the repository license is decided" while a
hundred and eighty-two files sat in it. A rule the repository states about
itself and then breaks is worse than no rule, and it went unnoticed for
four work packages because nothing checks it.

## Why MIT

The generated corpus is the constraint that made the choice, not the
application. Those files are model output committed as test fixtures; the
prompts already tell the model to invent everything and quote nothing, so
what is committed is the author's to license. A permissive licence keeps
them usable as fixtures by anything that wants them — including a future
extraction of `packages/markdown` or `packages/editor-core`, which are
libraries in everything but distribution.

A copyleft licence would have been a live option for the application alone.
It is a poor fit for a repository whose middle three packages are meant to
be depended on, and it would have made the corpus awkward for exactly the
audience that would find it useful.

MIT rather than Apache-2.0 because there is no patent position to grant and
no contributor agreement to run, and MIT is the shorter document. The
bundled fonts are unaffected: they ship under the SIL Open Font License and
`THIRD-PARTY-NOTICES.md` is where that is recorded, inside the application
as well as in the repository.

## What it does not cover

`tools/corpus-gen` calls a model API. What that model's terms say about its
output is between the operator and the vendor; this licence is the author's
grant over what is committed here, which is the only thing it can be.
