# Fix the class, not the site

Read this before replying `applied`. Most findings after the first review are bugs written by the
previous round's fix, and more than half repeat the defect class of a finding already fixed, at another
site. Each one costs another review round, or ships unverified once the reviews run out.

1. **Name the class in one sentence.** Name the rule the finding showed broken, not the line: "a caller
   reads the cache before the refresh settles", not "line 42 lacks a guard".
2. **Sweep the pull request for it.** Check every hunk of `gh pr diff <n>` (GitHub's own diff, so no local
   base ref can be stale) plus everything you changed since the reviewed head: `git diff <head>`, with
   `head` from `crysk status`, covers unpushed commits and the working tree. If you cannot get the pull
   request's diff, say so in the reply and do not claim a sweep. Search by shape (the same call, field,
   guard, state change or fallback), not only by the identifier the finding named. Fix every instance this
   pull request introduced in the same push, each with a test that fails without its fix.
3. **Re-read your own fix as the next reviewer will.** The next round hunts the code you just wrote: new
   branches, early returns, fallbacks, and every caller that now sees a different value. Check each against
   the same class before you push.
4. **Leave instances the pull request did not introduce alone.** Fixing them here grows the delta the next
   round reviews. Name them in the reply instead.
5. **Say what you swept.** End the reply with one line: the class, then how many sites you checked and how
   many you fixed.

Several findings on one head that share a class are one sweep, not several.

Do not restate the diff in the reply. A pointer to the commit or file, plus the sweep line, is enough:

```
Fixed: `parseConfig` now validates `retries` before use.
Class: a config value used before validation. Swept 4 reads of parsed config in this PR, fixed 2.
```

`applied` runs no adjudicator, because the next review verifies the fix. When no review is left, nobody
verifies it, so `applied` must mean you fixed it and ran the tests.
