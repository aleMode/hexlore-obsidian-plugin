---
name: start-change
description: Start any change to HexLore (a feature, a bug fix, an optimization, a refactor) the way WORKFLOW.md prescribes. Use at the beginning of every piece of work that will edit code or docs in this repository, before the first edit, even when the user just says "add X" or "fix Y".
---

# Start a change

This repository is the Obsidian plugin. The workflow is `vendor/WORKFLOW.md` (§4 the loop, §5 the
three kinds of change). Follow it; when the user asks to skip a step, say
which one and why it exists, then do as they decide.

1. **Understand the request.** If it is unclear what "done" means, ask one
   short question; otherwise go on.
2. **Classify it** (WORKFLOW.md §5) and say so in one line:
   - **A**: one app, no shared contract;
   - **B**: both apps, or anything touching the contract (map files,
     converter, player filter, art tables, variant ids, `core` behaviour
     covered by the conformance fixtures). The Flutter repository goes FIRST;
   - **C**: a bug fix or an optimization. Bug: the failing test comes first.
     Optimization: measure before.
   When it is B and this is the plugin, stop and say the change starts in
   `../software_hexlore` (offer to work there with `/add-dir`).
3. **Check the state** with git: current branch, uncommitted changes, and
   whether `main` is behind its remote. Uncommitted work that is not part
   of this change: ask before touching it.
4. **Branch** from an up-to-date `main`: `feat/`, `fix/`, `perf/`,
   `docs/` or `chore/` plus a short name. Never edit on `main`. If the
   user already made a branch for it, stay on it.
5. **Issue.** Ask for the GitHub issue number if there is one (for the commit
   message); do not insist on one for a small change.
6. **Plan out loud, briefly:** the files you expect to change, the test you
   will write, the docs from WORKFLOW.md §7 that will need a line, and, for
   kind B or a bug in shared code, what the other repository will need.
   Read the decision record for the area before changing it.

Then do the work. Finish with `/finish-change`.
