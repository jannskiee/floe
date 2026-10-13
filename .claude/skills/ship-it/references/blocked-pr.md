# When the PR does not move

1.  **Dropped event.** `gh run list --branch <b> --workflow ci.yml` is empty while the PR exists (CodeQL may still show; it is GitHub's default setup, different machinery). Close/reopen does not fix it. Run `gh workflow run ci.yml --ref <b>` once, then read the commit, not the PR, from the Bash tool:

        gh api repos/jannskiee/floe/commits/<sha>/check-runs --jq '.check_runs[] | "\(.status)\t\(.conclusion // "-")\t\(.name)"'

    From the PowerShell tool a `--jq` expression with spaces in it fails with "accepts at most 1 arg(s)", and a loop that polls on its output then ends at once on the empty result. Never plain `jq`: it is absent on this machine and a loop built on it fails silently. Cost: the dispatched run is the full suite even for a docs-only PR.

2.  **1Password strings.** "agent returned an error", "failed to fill whole buffer", "Could not connect to socket": a per-signature approval prompt is pending and cannot be shown from a non-interactive shell. Ask the user to approve it in 1Password, retry once, never loop. If the commit was made from the Bash tool it is unsigned with exit 0 (`%G?` = N): `git commit --amend --no-edit` from PowerShell.

3.  **Mintlify Deployment red on a docs PR.** Usually the ephemeral preview. Confirm production via the merge-commit check-run after merge, and do not block on it before.

4.  **`gh pr view N --json mergeStateStatus`:**
    - `BLOCKED`: the required `CI green` check is missing or failed (see 1 and 5).
    - `BEHIND`: mergeable; the ruleset does not require branches to be up to date.
    - `DIRTY`: conflicts. `git fetch origin; git merge origin/main`, resolve, commit from PowerShell. `gh pr update-branch` also works but produces a GitHub-signed merge commit on the branch.
    - `UNSTABLE`: a check outside the gate is red, and GitHub will merge the PR anyway. Find out which before you do. No ci.yml job is outside the gate (`Skill test suites` joined it on 2026-10-13, and a red there now reads `BLOCKED`), so this is a check from another app. A red Mintlify preview is item 3.
    - `UNKNOWN`: just pushed; re-query.
    - `CLEAN`: merge.

5.  **CI green red.** `gh run view <run> --log-failed` (wait-ci prints the exact command). It answers "still in progress" until the WHOLE run has ended, not just the job that failed, so wait for the run and ask again; do not read that answer as "no failure". The log lines carry ANSI color codes, which defeat a search anchored at the start of a line. Flaky e2e: download the evidence artifact first (a rerun overwrites it), then `gh run rerun <run> --failed`.

6.  **Push rejected with GH013.** You are on main. Branch, push the branch, open a PR.

7.  **`%G?` shows E on main.** Expected: the squash commit is signed with GitHub's web-flow GPG key, which is not in the local GPG keyring (allowed_signers governs SSH signatures and plays no part here). Only G on branch commits matters.

8.  **Repo squash defaults.** As of 2026-08-28 the repository setting is `squash_merge_commit_title: PR_TITLE` and `squash_merge_commit_message: PR_BODY` (previously `COMMIT_OR_PR_TITLE` / `COMMIT_MESSAGES`, which concatenated every branch commit into the squash body). ship-it passes `--subject` and `--body-file` explicitly regardless, so a setting change cannot bring the concatenation back.

9.  **wait-ci exits 4.** gh is not authenticated, the PR number does not exist, the SHA is not in the repo, or a flag is missing its value. Fix the target (`gh auth status`, `gh pr view <n>`, `git rev-parse <sha>`) and run it again once; do not retry the same command in a loop.

10. **wait-ci exits 3, or seems to exit 0 on a run that is not green.** Exit 3 is the script's own timeout, not a CI result: nothing failed, it stopped waiting (9 minutes by default, and most code runs take longer). Run it again, in the background with `--timeout-min 20` for a code PR. A wait-ci that "exited 0" while the run was red or still going was piped: `wait-ci.mjs ... | tail` reports the exit code of `tail`. Run it bare and read its last line.

11. **`gh pr merge --match-head-commit` refuses.** The PR's head is no longer the commit you named: a bot rebased it, someone pushed, or the SHA was typed and is not the full 40 characters. Read it again with `gh pr view <n> --json headRefOid --jq .headRefOid`, wait for `CI green` on that commit, then merge. Never drop the flag to get past this.

12. **The squash commit landed with the wrong body.** The body file was written in the same batch of tool calls as the merge, the write failed, and the merge ran with what was there (#526, 2026-10-12). A merged commit on main cannot be amended. Say so in the PR, and from then on write the body, read it back, and merge in a later step.
