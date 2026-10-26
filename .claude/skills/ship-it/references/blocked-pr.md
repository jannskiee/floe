# When the PR does not move

1.  **Dropped event.** `gh run list --branch <b> --workflow ci.yml` is empty while the PR exists (CodeQL may still show; it is GitHub's default setup, different machinery). Close/reopen does not fix it. For a pull request from a fork this is not the recovery: its branch is not in this repository, and a held first run is item 13. Run `gh workflow run ci.yml --ref <b>` once, then read the commit, not the PR, from the Bash tool:

        gh api repos/jannskiee/floe/commits/<sha>/check-runs --jq '.check_runs[] | "\(.status)\t\(.conclusion // "-")\t\(.name)"'

    From the PowerShell tool a `--jq` expression with spaces in it fails with "accepts at most 1 arg(s)", and a loop that polls on its output then ends at once on the empty result. Never plain `jq`: it is absent on this machine and a loop built on it fails silently. Cost: the dispatched run is the full suite even for a docs-only PR.

2.  **1Password strings.** "agent returned an error", "failed to fill whole buffer", "Could not connect to socket": a per-signature approval prompt is pending and cannot be shown from a non-interactive shell. Ask the user to approve it in 1Password, retry once, never loop. If the commit was made from the Bash tool it is unsigned with exit 0 (`%G?` = N): `git commit --amend --no-edit` from PowerShell.

3.  **Mintlify Deployment red on a docs PR.** Usually the ephemeral preview. Confirm production via the merge-commit check-run after merge, and do not block on it before.

4.  **`gh pr view N --json mergeStateStatus`:**
    - `BLOCKED`: the required `CI green` check is missing or failed (see 1 and 5).
    - `BEHIND`: mergeable; the ruleset does not require branches to be up to date.
    - `DIRTY`: conflicts. With a merge queued, run `gh pr merge <n> --disable-auto` first. Then `git fetch origin; git merge origin/main`, resolve, commit from PowerShell, and queue again at the new head. `gh pr update-branch` also works but produces a GitHub-signed merge commit on the branch.
    - `UNSTABLE`: a check outside the gate is red, and GitHub will merge the PR anyway: a queued merge waits for `CI green` alone, and `gh pr merge --auto` on an `UNSTABLE` PR merges at once. Find out which check is red; SKILL.md step 7 says which ones should make you stop the merge yourself with `--disable-auto` (a red CodeQL does, the Vercel status on a fork PR does not). No ci.yml job is outside the gate (`Skill test suites` joined it on 2026-10-13, and a red there now reads `BLOCKED`), so this is a check from another app. A red Mintlify preview is item 3.
    - `UNKNOWN`: just pushed; re-query.
    - `CLEAN`: merge.

    `gh pr merge --auto` (SKILL.md step 7) merges at once on `CLEAN`, `HAS_HOOKS` and `UNSTABLE`, and queues the merge on anything else.

5.  **CI green red.** `gh run view <run> --log-failed` (wait-ci prints the exact command). It answers "still in progress" until the WHOLE run has ended, not just the job that failed, so wait for the run and ask again; do not read that answer as "no failure". The log lines carry ANSI color codes, which defeat a search anchored at the start of a line. Flaky e2e: download the evidence artifact first (a rerun overwrites it), then `gh run rerun <run> --failed`; a queued merge stays queued and goes through when the rerun is green. For a real failure with a merge queued, run `gh pr merge <n> --disable-auto` before you push the fix, and queue again at the new head.

6.  **Push rejected with GH013.** You are on main. Branch, push the branch, open a PR.

7.  **`%G?` shows E on main.** Expected: the squash commit is signed with GitHub's web-flow GPG key, which is not in the local GPG keyring (allowed_signers governs SSH signatures and plays no part here). Only G on branch commits matters.

8.  **Repo squash defaults.** As of 2026-08-28 the repository setting is `squash_merge_commit_title: PR_TITLE` and `squash_merge_commit_message: PR_BODY` (previously `COMMIT_OR_PR_TITLE` / `COMMIT_MESSAGES`, which concatenated every branch commit into the squash body). ship-it passes `--subject` and `--body-file` explicitly regardless, so a setting change cannot bring the concatenation back. Since 2026-10-26 squash is also the only merge method the repository allows (`allow_merge_commit` and `allow_rebase_merge` false, matching the `main-protection` ruleset), and `allow_auto_merge` is true, so `gh pr merge --merge` and `--rebase` are refused and a queued merge can only be a squash.

9.  **wait-ci exits 4.** gh is not authenticated, the PR number does not exist, the SHA is not in the repo, or a flag is missing its value. Fix the target (`gh auth status`, `gh pr view <n>`, `git rev-parse <sha>`) and run it again once; do not retry the same command in a loop. A "not logged in" from gh while `gh auth status` in your own shell is fine means APPDATA was redirected for the run: gh reads its login from `%APPDATA%\GitHub CLI` unless `GH_CONFIG_DIR` or `XDG_CONFIG_HOME` is set, so set `GH_CONFIG_DIR` to `%USERPROFILE%\AppData\Roaming\GitHub CLI` for that run.

10. **wait-ci exits 3, or seems to exit 0 on a run that is not green.** Exit 3 is the script's own timeout, not a CI result: nothing failed, it stopped waiting (9 minutes by default, and most code runs take longer). Run it again, in the background with `--timeout-min 20` for a code PR. A wait-ci that "exited 0" while the run was red or still going was piped: `wait-ci.mjs ... | tail` reports the exit code of `tail`. Run it bare and read its last line.

11. **`gh pr merge --match-head-commit` refuses.** With `--auto` on a PR that still waits for `CI green`, the refusal reads "expected head oid does not match the current head oid (enablePullRequestAutoMerge)", and nothing is queued; on one that can merge now, gh merges directly and GitHub refuses with its own head-mismatch message. The PR's head is no longer the commit you named: a bot rebased it, someone pushed, or the SHA was typed and is not the full 40 characters. Read it again with `gh pr view <n> --json headRefOid --jq .headRefOid`, read what changed, and queue again with that SHA. Never drop the flag to get past this.

12. **The squash commit landed with the wrong body.** The body file was written in the same batch of tool calls as the merge, the write failed, and the merge ran with what was there (#526, 2026-10-12). A merged commit on main cannot be amended. Say so in the PR, and from then on write the body, read it back, and merge in a later step.

13. **A queued merge has not happened.** Read `gh pr view <n> --json state,mergeStateStatus,autoMergeRequest,headRefOid` from the Bash tool:
    - `autoMergeRequest` null on an open PR: nothing is queued. A push of new changes, or a switch of base branch, by someone without write access cancels a queued merge, and the PR's timeline says so. Read what changed and queue again at the new head (SKILL.md step 7).
    - `BLOCKED` with a red `CI green`: the merge stays queued and goes through if a rerun is green (item 5). Before you push a fix, run `gh pr merge <n> --disable-auto`, then queue again at the new head.
    - `BLOCKED` with no ci.yml check-runs on the head of a branch in this repository: a dropped event, item 1. A `CI green` from the dispatched run counts like any other on that commit.
    - `BLOCKED` with no check-runs on a pull request from a fork: a first-time contributor's run is held for approval (the repository approves first-time contributors' runs by hand). `gh run list --repo jannskiee/floe --workflow ci.yml --branch <head branch>` shows it as `action_required`. Approve it on the run's page only after you have read every file at the recorded SHA, `.github/**` included. Dispatching ci.yml never helps a fork PR.
    - `DIRTY`: a conflict, item 4. Resolving it is a push, so disable first and queue again after.
    - `autoMergeRequest` still set, `CI green` passed, and the PR still open a few minutes later: run `gh pr merge <n> --disable-auto`, then step 7's command again at the same recorded head, which merges at once on `CLEAN` or `UNSTABLE`. On #772 the merge came 38 s after `CI green`.
