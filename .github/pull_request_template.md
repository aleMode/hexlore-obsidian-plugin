<!-- WORKFLOW.md §4. Delete what does not apply. -->

**What and why**

Fixes #

**Checklist**
- [ ] Checks pass (`./check.sh` / `check.bat`, or `npm run check`)
- [ ] A test covers it (for a bug: it failed before the fix)
- [ ] Docs updated (WORKFLOW.md §7) and a `CHANGELOG.md` line under *Unreleased*
- [ ] Shared contract touched? Flutter committed and pushed first; plugin re-vendored, its commit names the Flutter commit
- [ ] The other app checked for the same change or bug
