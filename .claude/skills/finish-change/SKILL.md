---
name: finish-change
description: Finish a change to HexLore the way WORKFLOW.md prescribes - run the checks, update docs and changelog, check the other app, propose the commit. Use when the work of a change is done, before saying it is complete, and whenever the user asks to wrap up, commit or merge.
---

# Finish a change

This repository is the Obsidian plugin; the workflow is `vendor/WORKFLOW.md`. Report each step's
outcome plainly; a failing check is reported with its output, never hidden.

1. **Checks:** run `npm run check`. All must pass. If `pubspec.lock` changed
   without `pubspec.yaml` changing, restore it and tell the user their
   Flutter differs from CI's.
2. **Tests:** confirm the change has a test (for a bug: one that failed
   before the fix). If not, write it now.
3. **Docs** (WORKFLOW.md §7): update every one that applies, in this change:
   user guide, technical manual, decision record or design record,
   `CLAUDE.md` rule. Add a line to `CHANGELOG.md` under *Unreleased* for
   anything a user would notice.
4. **The contract** (kind B): in the Flutter repository, were the contract
   docs updated first and the fixtures regenerated? In the plugin, was
   `npm run vendor` run from a PUSHED Flutter commit (`vendor/SOURCE`
   without "(dirty)")?
5. **The other app:** say whether `../software_hexlore` needs the same change or has the
   same bug (shared `core`, importer and converter are line-by-line ports).
   If yes, offer to open that work next; do not leave it unmentioned.
6. **Commit message:** propose one: an imperative summary saying what and
   why, `Fixes #N` when there is an issue, and for a plugin port the Flutter
   commit (`Port X (software_hexlore@abc1234)`).
7. **Next steps for the user**, as commands: commit, merge into `main`
   (`git switch main && git merge --no-ff <branch>`), push, delete the
   branch. Do not commit, merge, push or tag yourself unless the user asks.
