#!/usr/bin/env node
/**
 * Waits for the `CI green` check on a PR or commit and says what to do next.
 *
 * Why it reads check-runs by SHA instead of `gh pr checks`: the ruleset that
 * gates main reads the commit's check-runs, and `gh pr checks` does not list
 * the jobs of a workflow_dispatch run at all. On PR #339 GitHub dropped the
 * pull_request event, `gh workflow run ci.yml --ref <branch>` recovered it,
 * and `gh pr checks` kept showing only CodeQL and Mintlify while thirteen CI
 * jobs passed on that exact commit. Asking the commit is the only view that
 * cannot lie about the gate.
 *
 * Why the dropped-event exit exists: `gh run list --branch <b>` being empty
 * while the PR exists is the signature, and close/reopen does not fix it (also
 * measured on #339). The script prints the one command that does. For a
 * merged PR the head branch is gone, so the recovery command names the base.
 *
 * Why a completed gate is never polled: `CI green` runs with `if: always()`,
 * so once it has completed its conclusion is the verdict. A skipped or
 * neutral gate means its needs never ran (a job was skipped, or the workflow
 * was canceled upstream) and waiting for it to change would run to timeout.
 *
 * Why execFileSync and no shell: PowerShell 5.1 mangles quoted arguments to
 * native executables, and `jq` is absent on this machine and fails silently
 * inside loops. Everything goes through `gh` with argv arrays and the JSON is
 * parsed in Node.
 *
 * Usage:
 *   node wait-ci.mjs <pr-number|sha> [--timeout-min 9] [--grace-min 3]
 *                    [--interval-sec 25] [--repo owner/name]
 * Tests:
 *   node --test .claude/skills/ship-it/scripts/wait-ci.test.mjs
 * Exit 0 green, 1 red (failed jobs and a --log-failed command printed),
 * 2 dropped event (recovery command printed), 3 timeout, 4 gh or lookup error.
 * The 9 minute default sits under the 600 s tool-call cap; rerun to keep
 * waiting, the check-runs are re-read from scratch each time.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const GATE = 'CI green';
const CHANGES = 'Detect changed paths';
// GitHub's literal conclusion values; `cancelled` is the API's spelling.
const RED = new Set([
    'failure',
    'cancelled',
    'timed_out',
    'action_required',
    'startup_failure',
    'stale',
]);

function gh(args) {
    try {
        return execFileSync('gh', args, {
            encoding: 'utf8',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
    } catch (e) {
        const detail = (e.stderr || e.message || '').toString().trim();
        const err = new Error(detail || `gh ${args.join(' ')} failed`);
        err.status = e.status ?? 1;
        throw err;
    }
}

export function parseArgs(argv) {
    const opts = {
        target: null,
        timeoutMin: 9,
        graceMin: 3,
        intervalSec: 25,
        repo: null,
    };
    const value = (flag, v) => {
        if (v === undefined || v.startsWith('--'))
            throw new Error(`${flag} needs a value`);
        return v;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--timeout-min')
            opts.timeoutMin = Number(value(a, argv[++i]));
        else if (a === '--grace-min')
            opts.graceMin = Number(value(a, argv[++i]));
        else if (a === '--interval-sec')
            opts.intervalSec = Number(value(a, argv[++i]));
        else if (a === '--repo') opts.repo = value(a, argv[++i]);
        else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
        else if (opts.target === null) opts.target = a;
        else throw new Error(`unexpected argument ${a}`);
    }
    if (!opts.target)
        throw new Error(
            'usage: wait-ci.mjs <pr-number|sha> [--timeout-min N] [--grace-min N] [--interval-sec N] [--repo owner/name]'
        );
    if (!Number.isFinite(opts.timeoutMin) || opts.timeoutMin < 0)
        throw new Error('--timeout-min must be a non-negative number');
    if (!Number.isFinite(opts.graceMin) || opts.graceMin < 0)
        throw new Error('--grace-min must be a non-negative number');
    if (!Number.isFinite(opts.intervalSec) || opts.intervalSec < 1)
        throw new Error('--interval-sec must be at least 1');
    return opts;
}

// The ref a workflow_dispatch can target for this PR: the head branch while
// the PR is open, the base branch once it is merged (the head is deleted on
// merge here).
export function recoveryRef(pr) {
    if (!pr) return null;
    if (pr.state === 'MERGED') return pr.baseRefName || null;
    return pr.headRefName || null;
}

// Pure decision over one snapshot of github-actions check-runs. Exported so
// the synthetic cases in wait-ci.test.mjs cover every exit without a network.
// Returns { code, lines, corroborate } where code null means keep polling.
export function decide(runs, elapsedMin, opts) {
    const gates = runs
        .filter((r) => r.name === GATE)
        .sort((a, b) => b.id - a.id);
    const green = gates[0];
    const changesSeen = runs.some((r) => r.name === CHANGES);
    if (green && green.status === 'completed') {
        if (green.conclusion === 'success') {
            return { code: 0, lines: [`${GATE}: success (${green.html_url})`] };
        }
        const suite = green.check_suite?.id;
        const failed = runs.filter(
            (r) =>
                r.name !== GATE &&
                r.check_suite?.id === suite &&
                r.status === 'completed' &&
                RED.has(r.conclusion)
        );
        const runId = (green.html_url || '').match(/\/runs\/(\d+)\//)?.[1];
        const lines = [`${GATE}: ${green.conclusion} (${green.html_url})`];
        if (!RED.has(green.conclusion)) {
            lines.push(
                `  the gate completed as ${green.conclusion} without its needs running (a job was skipped, or the workflow was canceled upstream); treated as red`
            );
        }
        for (const f of failed)
            lines.push(`  ${f.conclusion}  ${f.name}  ${f.html_url}`);
        if (RED.has(green.conclusion) && !failed.length) {
            lines.push(
                '  no failed sibling job; the gate itself failed (a job was canceled or skipped unexpectedly)'
            );
        }
        lines.push(
            runId
                ? `gh run view ${runId} --log-failed`
                : 'run id not derivable from the gate URL; open it above'
        );
        return { code: 1, lines };
    }
    if (!green && !changesSeen && elapsedMin >= opts.graceMin) {
        return { code: 2, corroborate: true, lines: [] };
    }
    if (elapsedMin >= opts.timeoutMin) {
        const pending = runs
            .filter((r) => r.status !== 'completed')
            .map((r) => `  ${r.status}  ${r.name}`);
        return {
            code: 3,
            lines: [
                `timeout after ${opts.timeoutMin} min; still running:`,
                ...(pending.length ? pending : ['  (no check-runs at all)']),
            ],
        };
    }
    const done = runs.filter((r) => r.status === 'completed').length;
    return {
        code: null,
        lines: [
            `${GATE}: ${green ? green.status : 'queued'}, ${done}/${runs.length} jobs`,
        ],
    };
}

function clock() {
    return new Date().toTimeString().slice(0, 8);
}

function resolveTarget(target, repo) {
    if (/^\d{1,6}$/.test(target)) {
        let pr;
        try {
            pr = JSON.parse(
                gh([
                    'pr',
                    'view',
                    target,
                    '--repo',
                    repo,
                    '--json',
                    'headRefOid,headRefName,baseRefName,state,url',
                ])
            );
        } catch (e) {
            const err = new Error(
                `PR #${target} not found in ${repo}: ${e.message}`
            );
            err.status = 4;
            throw err;
        }
        return {
            sha: pr.headRefOid,
            branch: recoveryRef(pr),
            label: `PR #${target} (${pr.state}, ${pr.url})`,
        };
    }
    const sha = gh(['api', `repos/${repo}/commits/${target}`, '--jq', '.sha']);
    let branch = null;
    try {
        const found = JSON.parse(
            gh([
                'pr',
                'list',
                '--repo',
                repo,
                '--search',
                sha,
                '--state',
                'all',
                '--json',
                'headRefName,baseRefName,state',
                '--limit',
                '1',
            ])
        );
        branch = recoveryRef(found[0]);
    } catch {
        branch = null;
    }
    return { sha, branch, label: `commit ${sha.slice(0, 7)}` };
}

function fetchRuns(repo, sha) {
    const all = [];
    let total = Infinity;
    for (let page = 1; all.length < total && page <= 10; page++) {
        const body = JSON.parse(
            gh([
                'api',
                `repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`,
            ])
        );
        total = body.total_count;
        all.push(...body.check_runs);
        if (!body.check_runs.length) break;
    }
    return all.filter((r) => r.app?.slug === 'github-actions');
}

async function main(argv) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (e) {
        console.error(e.message);
        return 4;
    }
    let repo = opts.repo;
    let target;
    try {
        if (!repo)
            repo = gh([
                'repo',
                'view',
                '--json',
                'nameWithOwner',
                '--jq',
                '.nameWithOwner',
            ]);
        target = resolveTarget(opts.target, repo);
    } catch (e) {
        console.error(e.message);
        return 4;
    }
    console.log(
        `${clock()}  waiting for ${GATE} on ${target.label}, sha ${target.sha}${target.branch ? `, ref ${target.branch}` : ''}`
    );
    const started = Date.now();
    for (;;) {
        let runs;
        try {
            runs = fetchRuns(repo, target.sha);
        } catch (e) {
            console.error(e.message);
            return 4;
        }
        const elapsedMin = (Date.now() - started) / 60000;
        const d = decide(runs, elapsedMin, opts);
        if (d.corroborate) {
            let existing = [];
            if (target.branch) {
                try {
                    existing = JSON.parse(
                        gh([
                            'run',
                            'list',
                            '--repo',
                            repo,
                            '--branch',
                            target.branch,
                            '--workflow',
                            'ci.yml',
                            '--limit',
                            '1',
                            '--json',
                            'databaseId',
                        ])
                    );
                } catch {
                    existing = [];
                }
            }
            if (existing.length && elapsedMin < opts.timeoutMin) {
                console.log(
                    `${clock()}  ci.yml run ${existing[0].databaseId} exists on ${target.branch} but has no check-runs on this sha yet; still waiting`
                );
                await sleep(opts.intervalSec * 1000);
                continue;
            }
            const ref = target.branch || '<branch>';
            console.log(
                `dropped event: no ci.yml check-runs on ${target.sha.slice(0, 7)} after ${elapsedMin.toFixed(1)} min`
            );
            console.log(`gh workflow run ci.yml --ref ${ref}`);
            console.log(
                'rerun this script afterwards; gh pr checks will not show the dispatched jobs'
            );
            return 2;
        }
        if (d.code !== null) {
            for (const line of d.lines) console.log(line);
            return d.code;
        }
        console.log(`${clock()}  ${d.lines[0]}`);
        await sleep(opts.intervalSec * 1000);
    }
}

const invokedDirectly =
    process.argv[1] &&
    resolve(process.argv[1]).toLowerCase() ===
        fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly)
    main(process.argv.slice(2)).then((code) => process.exit(code));
