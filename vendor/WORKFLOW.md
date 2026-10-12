# HexLore workflow

How every change to HexLore is made, in either app. One person, three
repositories, two machines: this is the minimum process that keeps the two
apps in step and the docs true. Claude Code sessions follow it too (both
`CLAUDE.md` files load it).

This file lives in `software_hexlore` and is copied into the plugin as
`vendor/WORKFLOW.md` by `npm run vendor`. Edit it only here.

## 1. The three repositories

```
temp2/                          (any parent folder; the three sit side by side)
  software_hexlore/             aleMode/software_hexlore          private
  hexlore-obsidian/             aleMode/hexlore-obsidian-plugin   private, may go public
  obsidian-test-vault/          aleMode/obsidian-test-vault       private, ALWAYS
```

| Repository | Holds | Owns |
|---|---|---|
| `software_hexlore` | the Flutter app | **the shared contract**: `docs/format-2.md`, `docs/converter.md`, `docs/decisions/`, the conformance and converter fixtures, `assets/player/` (render spec, art tables), `tool/variant_ids.lock`, this file |
| `hexlore-obsidian` | the Obsidian plugin | its own code and docs; `vendor/` is a COPY of the contract |
| `obsidian-test-vault` | the dev vault with a real campaign | nothing shared; the plugin build copies itself into it |

**The contract flows one way: Flutter → `npm run vendor` → plugin.**

## 2. The rules

1. **`main` always works.** Every change happens on a branch and is merged
   only when its checks pass.
2. **Shared changes start in `software_hexlore`.** Commit and push there
   first; the plugin follows by `npm run vendor`.
3. **Every bug fix comes with a test** that failed before the fix.
4. **Docs and changelog change in the same commit as the code** (§7).
5. **Never edit `vendor/`, `*.g.dart` or the generated `.js` tables by
   hand.** Regenerate them.
6. **Never work on the real campaign.** Test on a copy
   (`~/hexlore-campaigns/purezza` is live data).

## 3. Every session

| When | Do |
|---|---|
| Start | `git pull` in each repository you will touch (the vault too, if you build the plugin). |
| Stop | Commit or stash, then `git push` everywhere you committed. The other machine starts from what you pushed. |

## 4. The loop (every change)

1. **Issue.** Open a GitHub issue in the repository the change starts in
   (templates: *Feature* or *Bug*). One or two sentences are enough. It is
   the to-do list and the link between repositories.
2. **Branch** from an up-to-date `main`:
   `git switch main && git pull && git switch -c <type>/<short-name>`.
   Types: `feat/`, `fix/`, `perf/`, `docs/`, `chore/`.
3. **Change, test, document.**
   - logic in the pure layer (`core` in both apps), UI as thin wiring;
   - a test for the new behaviour, or the failing test for the bug;
   - the docs from §7, and a line in `CHANGELOG.md` under *Unreleased* for
     anything a user would notice.
4. **Check** (§9 for the commands): every test green, analyzer / lint clean.
5. **Commit** with a message that says what and why:
   `Plugin: "Create a new map…" command for vaults with no map`.
   Add `Fixes #12` to close the issue.
6. **Merge and push:**
   `git switch main && git merge --no-ff <branch> && git push && git branch -d <branch>`.
   Open a pull request instead when you want CI to check it before it lands
   (the PR template carries the checklist).

## 5. The three kinds of change

### A. A feature in ONE app

First question: **does it touch the shared contract?**

The contract is: the map files (any key or value written to them), the
converter (notes, NPCs, quests, pages, the `.hexmap.md` index), the player
filter (what players see), the art tables and variant ids, `core` behaviour
covered by the conformance fixtures.

- **No** (a panel, a menu entry, a shortcut, a Flutter-only view, an
  Obsidian-only integration): run the loop (§4) in that repository. Done.
- **Yes:** it is kind B, even if the other app needs no visible change.
  For example, a key the plugin wants to save must first be recorded in
  `docs/format-2.md`, and Flutter must keep it.
- **Not sure:** run the tests. Flutter's `conformance_test` and
  `converter_contract_test` fail when the contract moved.

### B. A feature in BOTH apps (or any contract change)

One issue in `software_hexlore` for the whole feature; one short issue in
the plugin repository that links to it.

1. **Flutter first.**
   - update the contract docs FIRST (`docs/converter.md`, `docs/format-2.md`);
   - a change to what players see bumps `format` (decision 31);
   - a new variant appends its id to `tool/variant_ids.lock`;
   - the Dart code and its tests;
   - regenerate the fixtures:
     `HEXLORE_WRITE_CONFORMANCE=1 flutter test test/conformance_test.dart`,
     `HEXLORE_WRITE_CONVERTER=1 flutter test test/notes_export_test.dart`;
   - check, commit, **push**.
2. **Plugin second.**
   - `npm run vendor` (CI rejects a `vendor/SOURCE` that says "(dirty)");
   - the tests that now fail are the to-do list: port until they pass;
   - commit naming the Flutter commit:
     `Port river widths (software_hexlore@a1b2c3d)`;
   - if the plugin's converter output changed, regenerate the reverse
     fixture (`HEXLORE_WRITE_CONVERTER=1 npm test -- convert`), then commit
     it in `software_hexlore` and vendor again.
3. A change that is only UI in both apps (no contract) can be done in either
   order: two loops, linked by their issues.

### C. A bug fix or an optimization

**Bug**

1. Reproduce it, on a copy of a campaign.
2. Write the test that fails because of it. Then fix until it passes.
3. **Look for the same bug in the other app.** Much of the plugin is a
   line-by-line port of Flutter's `core`, importer and converter:
   - a bug in shared logic: fix Flutter first, regenerate the fixtures, then
     vendor and fix the plugin (kind B);
   - a bug in code only one app has (a view, the plugin's renderer, the
     Obsidian integration): that repository only.

**Optimization**

1. Measure BEFORE, with the existing tools:
   - Flutter: `test/render_capture_test.dart` (`HEXLORE_RENDER_OUT`) and the
     pan harness (`docs/pan-performance.md`);
   - plugin: map menu → HexLore → *Benchmark the renderer*
     (`docs/performance.md`).
2. Change one thing at a time.
3. Measure AFTER, same tool, same machine. Keep the change only if the
   numbers improve and the render captures still match
   (`HEXLORE_RENDER_REF`).
4. Record the new numbers in the performance doc; a choice between
   approaches becomes a decision record.

## 6. Commits and branches, briefly

- One logical change per commit. "fix vari" tells nobody anything, least of
  all you in six months.
- Branches live hours or days, not weeks. Delete them once merged.
- Both apps use semantic versions: patch = a fix, minor = a feature,
  major = a breaking format change (with a `format` bump).

## 7. Where each kind of information goes

| You changed… | Update, in the same commit |
|---|---|
| something the user sees (tool, menu, shortcut, dialog) | that app's `docs/user-guide.md`, and `CHANGELOG.md` |
| structure (a layer, a module, the build, a file on disk) | that app's `docs/technical-manual.md` |
| a design choice with a "why" or a rejected alternative | a decision record (Flutter: `docs/decisions/` + its index line; plugin: `docs/design.md`) |
| the format, the converter, the index grammar | `docs/format-2.md` / `docs/converter.md`, in Flutter, FIRST |
| plugin progress (an item built, something new open) | `docs/design.md` §3 |
| a rule a coding session must not break | that repository's `CLAUDE.md`: one short line pointing at the record |
| an idea, a bug, a "not built yet" | a GitHub issue, not a doc |

## 8. Releases

**Flutter**
1. Move *Unreleased* in `CHANGELOG.md` under the new version and date.
2. Commit and push.
3. Run the *Release* workflow (GitHub → Actions → Release) with that
   version. It builds Windows and Linux, creates the `vX.Y.Z` tag and
   publishes the release.

**Plugin**
1. Move *Unreleased* in `CHANGELOG.md` under the new version and date;
   commit.
2. `npm version X.Y.Z` (updates `manifest.json`, `versions.json`, tags
   without a `v`), then `git push --follow-tags`.
3. The release workflow makes a DRAFT release. Test it in a real vault, then
   publish it.

## 9. Command sheet

| Task | Flutter (`software_hexlore`) | Plugin (`hexlore-obsidian`) |
|---|---|---|
| All checks | `./check.sh` or `check.bat` | `npm run check` |
| Tests only | `cd hexlore_flutter && flutter test` | `npm test` |
| Run | `./run.sh` or `run.bat` | `npm run dev`, then reload Obsidian |
| Regenerate fixtures | `HEXLORE_WRITE_CONFORMANCE=1` / `HEXLORE_WRITE_CONVERTER=1` + the test | `HEXLORE_WRITE_CONVERTER=1 npm test -- convert` |
| Copy the contract | — | `npm run vendor` |
| Regenerate art tables | `dart run tool/glyphs/gen_glyphs.dart`, `dart run tool/texture_gen/gen_textures.dart` | — (vendored) |

## 10. With Claude Code

- Open the session in the repository the change starts in. For kind B,
  open `software_hexlore` and add the plugin with
  `/add-dir ../hexlore-obsidian`.
- **`/start-change`** at the beginning: it classifies the change (A, B or C),
  makes the branch and lists what will need updating.
- **`/finish-change`** at the end: it runs the checks, updates docs and
  changelog, says whether the other app needs the same change, and proposes
  the commit message.
- Claude does not commit to `main`, push, or tag unless you ask.

## 11. One-time setup (tick when done)

- [ ] GitHub: `main` is the default branch of every repository.
- [ ] Your Flutter matches CI (3.47.6): `flutter upgrade`, or pin it with
      FVM. A different version rewrites `pubspec.lock` on every run
      (`check.sh` warns; `git restore hexlore_flutter/pubspec.lock`).
- [ ] Node 24 (`.node-version` in the plugin; fnm picks it up).
- [ ] The plugin's `test-vault` link:
      `mklink /D test-vault ..\obsidian-test-vault` (cmd, inside
      `hexlore-obsidian`).
