# ADR 0038: The bench on a shared runner fails on a disaster

Status: accepted, 2026-09-11. Amends "Thresholds that fail the build" in
ADR 0030, for the one runner the bench job has: GitHub's macOS runner.

The bench job had failed on every run in the repository's history. Each
failure was a time over its budget, and which ones failed changed from
run to run. Across the eleven runs whose numbers were kept, restoring two
hundred tabs took from 244 ms to 815 against a budget of 600, and
building Read mode at ten megabytes from 72 ms to 402 against 250. On the
machine the budgets were set on, the same two measure 160 to 220 ms and
54.

None of it was the code getting slower. The session bench run here three
times on each side of the day's commits, and the keystroke bench twice,
gave the same numbers on both sides.

ADR 0030 made the design's promises the thresholds, and the rest what the
harness measures with room over the top, and took that to be what plan
7.4 asks of a shared runner. But the room was measured here, and the
runner is three cores shared with other work: from one run to the next,
over commits that change nothing here, it measures anything from this
machine's numbers to ten times them. Plan 1.3 had already said that
shared runners are too noisy for the sixteen millisecond keystroke.
Fourteen red runs are that sentence, measured.

## Five times the budget, and only for time

Plan 7.4 has a shared runner run the harness and fail only on a
regression of half as much again, "to catch disasters without
flakiness". Half as much again over what the runner usually measures is
inside its noise, so it is taken over the worst it has measured: three
times a budget, blockdiff's megabyte scan in WebKit at 137 ms against 45.
Five is that and half as much again, rounded up. A keystroke that takes
eighty milliseconds on the runner fails the build, and so does Read mode
taking a second and a quarter to build at ten megabytes.

Counts are not scaled. How many calls cross to Rust, how many blocks are
in the page and how many bytes a typed change sends are the same on any
machine, and are held to the same numbers everywhere.

The workflow says the runner is shared, `BENCH_RUNNER: shared`, rather
than the bench guessing it from `CI`. The pinned machines of plan 1.1
would run under CI as well, and theirs are the numbers the budgets are
promises about.

## Where the promises are held now

Design 12 says the budgets are measured in CI with thresholds that fail
the build. On this runner that is now true of disasters and not of the
promises: sixteen milliseconds is held at eighty. Held at sixteen, it
failed on runs where nothing had changed, and a threshold that fails
whatever the code does says nothing about the code. `pnpm bench` holds
the promises themselves on whatever machine runs it, which is where they
were set, and they are what the pinned machines would hold when there
are some.

## What was left

- **A promise at its edge on this machine too.** A keystroke in a
  megabyte in WebKit measures 7 to 21 ms at its slowest place from one
  run to the next, against 16. Whether that is the budget or the code is
  not something the runner can say.
- **The noise itself.** Taking the best of several measurements would
  narrow it, and would change what is measured: a first open is a cold
  one.
- **No baseline.** Comparing each run with the runner's own history
  would catch regressions far smaller than five times a budget. It needs
  that history kept where a run can read it, and a way to say that a
  change is meant to be slower.
