# When the PR does not move

1.  **Dropped event.** `gh run list --branch <b> --workflow ci.yml` is empty while the PR exists (CodeQL may still show; it is GitHub's default setup, different machinery). Close/reopen does not fix it. Run `gh workflow run ci.yml --ref <b>` once, then read the commit, not the PR:

        gh api repos/jannskiee/floe/commits/<sha>/check-runs --jq '.check_runs[] | "\(.status)\t\(.conclusion // "-")\t\(.name)"'

    Never plain `jq`: it is absent on this machine and a loop built on it fails silently. Cost: the dispatched run is the full suite even for a docs-only PR.

2.  **1Password strings.** "agent returned an error", "failed to fill whole buffer", "Could not connect to socket": a per-signature approval prompt is pending and cannot be shown from a non-interactive shell. Ask the user to approve it in 1Password, retry once, never loop. If the commit was made from the Bash tool it is unsigned with exit 0 (`%G?` = N): `git commit --amend --no-edit` from PowerShell.

3.  **Mintlify Deployment red on a docs PR.** Usually the ephemeral preview. Confirm production via the merge-commit check-run after merge, and do not block on it before.

4.  **`gh pr view N --json mergeStateStatus`:**
    - `BLOCKED`: the required `CI green` check is missing or failed (see 1 and 5).
    - `BEHIND`: mergeable; the ruleset does not require branches to be up to date.
    - `DIRTY`: conflicts. `git fetch origin; git merge origin/main`, resolve, commit from PowerShell. `gh pr update-branch` also works but produces a GitHub-signed merge commit on the branch.
    - `UNSTABLE`: a non-required check is red; mergeable.
    - `UNKNOWN`: just pushed; re-query.
    - `CLEAN`: merge.

5.  **CI green red.** `gh run view <run> --log-failed` (wait-ci prints the exact command). Flaky e2e: download the evidence artifact first (a rerun overwrites it), then `gh run rerun <run> --failed`.

6.  **Push rejected with GH013.** You are on main. Branch, push the branch, open a PR.

7.  **`%G?` shows E on main.** Expected: the squash commit is signed with GitHub's web-flow GPG key, which is not in the local GPG keyring (allowed_signers governs SSH signatures and plays no part here). Only G on branch commits matters.

8.  **Repo squash defaults.** As of 2026-08-28 the repository setting is `squash_merge_commit_title: PR_TITLE` and `squash_merge_commit_message: PR_BODY` (previously `COMMIT_OR_PR_TITLE` / `COMMIT_MESSAGES`, which concatenated every branch commit into the squash body). ship-it passes `--subject` and `--body-file` explicitly regardless, so a setting change cannot bring the concatenation back.

9.  **wait-ci exits 4.** gh is not authenticated, the PR number does not exist, the SHA is not in the repo, or a flag is missing its value. Fix the target (`gh auth status`, `gh pr view <n>`, `git rev-parse <sha>`) and run it again once; do not retry the same command in a loop.
