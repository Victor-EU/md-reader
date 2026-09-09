# ADR 0027: the Phase 2 gate

Status: accepted, 2026-09-09. Covers the gate run in
[docs/manual-runs/2026-09-09-phase2-gate.md](../manual-runs/2026-09-09-phase2-gate.md).

The plan's Phase 2 gate is four criteria: S5 and S6 by hand on both
platforms, the merge property tests and semantic diff cases green, bench
numbers within budget, and a beta build to a handful of outside users.

Two are met outright. The first is met on the one platform there is.
**The gate is not passed**, and what stands between here and passing it is
not code.

## What the run did not find

The Phase 1 gate run found six things, three of them shipped defects, and
that is why ADR 0018 is mostly a list of fixes. This one found none: S5 and
S6 both ran end to end on the installed build, first time, and the byte diff
of the merged document is exactly what S5 asks for.

That is worth recording rather than passing over. Everything the two
scenarios touch — the conflict widget, the semantic diff behind the gutter,
the folder tree, fuzzy open, content search, session restore, and the title
bar the tabs now live in — was checked by hand in its own work package
first, against the same installed build, and each of those runs found and
fixed its own defects. The gate found nothing because the gate was not the
first time anybody looked.

Two things looked wrong and were checked against the code before being
written off, both deliberate:

- **An explicit save clears the change marks.** `markSaved(written, seen)`
  passes `seen: true` for Cmd+S — the reader was here and pressed the key —
  and `seen: false` for the autosave timer, so marks on a write that arrived
  from somebody else are never cleared by a clock. Design 4.4's "last
  reviewed" pointer is advanced by a save the reader asked for and by
  nothing else.
- **An empty `THEIRS` panel** is the honest report of a side that deleted
  what we are editing, not a missing value.

## The budgets are not measured where the promise was made

Plan 7.4 asks the performance harness to run in two places: Vitest browser
mode for the inner loop, and inside the real app behind a `--bench` flag,
"because the budgets are promises about WKWebView and WebView2, not about
Playwright's browsers".

The flag does not exist. Every number in the gate's bench table comes from
Playwright's Chromium and WebKit, on a developer laptop rather than one of
the two pinned machines 7.4 asks for.

The margins are wide — first paint at 1 MB is four times under its budget
on the slower of the two engines, the 1 MB merge is twenty times under, and
the tightest of them, keystroke p95, still has a third of its budget spare —
so the conclusion is unlikely to change. But "unlikely to change" is an
argument, and the criterion asks for a measurement. The flag belongs to WP
3.3, which is where the plan already says to profile the real thing and
tighten the thresholds to the measured numbers.

Recorded here so that the Phase 3 gate, which asks for all eight scenarios
on both platforms and a release candidate, does not inherit the gap
silently.

## What passing it would take

- **A Windows machine.** S5 and S6 there, and the bench numbers under
  WebView2. Parked since 2026-09-08; nothing in Phase 2 assumes otherwise.
- **A handful of outside users**, and a build in front of them. Who they are
  is not an engineering decision, and the updater, the signing and the
  `.dmg` that a beta needs are the parts of WP 1.12 that stop at the Apple
  Developer Program enrolment.

Both are the developer's to supply. Neither blocks WP 3.1, which is the next
work package and needs neither.
