// The /take claim bot: everything .github/workflows/claim.yml does after its
// checkout of main. A contributor starts a comment with /take on a good first
// issue and is assigned, usually within a minute, or gets one of the fixed
// replies in .github/claim/ saying why not; /untake gives the issue back.
// Tests: claim.test.mjs beside this file, run by ci.yml's Repo guardrails job.
// A live smoke test on 2026-10-27 measured 13 s from comment to assignment,
// and one run that waited about 5 minutes for a GitHub runner.
//
// Rules the code below keeps, each with a reason:
// - Anyone on GitHub can trigger it, so a comment's text is only ever matched
//   against the fixed patterns here. It is never rendered into a reply, never
//   logged (a line starting with :: would be read as a workflow command) and
//   never handed to a shell. The only value of the commenter's that a reply
//   renders is their login, which GitHub limits to letters, digits and dashes.
// - Every run re-reads the issue and all its comments and answers EVERY
//   command that has no reply yet, oldest first. claim.yml serializes the runs
//   on one issue, but a concurrency group keeps only one pending run, so in a
//   burst a newer run replaces an older pending one (actionlint 1.7.12 rejects
//   queue: max). The newer run answers the replaced run's comment too, and the
//   earliest /take still wins.
// - A reply carries a marker naming the comment ids it answers. Only markers
//   in comments written by github-actions[bot] count, so nobody can mark
//   someone else's claim as answered.
// - GitHub silently drops an assignment it will not make, so the result of
//   every assign and unassign is read back before the reply says it happened.

import { readdirSync, readFileSync } from 'node:fs';

export const CLAIM_LABEL = 'good first issue';
export const HELP_LABEL = 'help wanted';
export const MAINTAINER = 'jannskiee';
export const BOT_LOGIN = 'github-actions[bot]';

// The owner assigns by hand and is never a claimant. claim.yml's if: skips
// the owner's own comments; this keeps a later run from acting on them.
export const EXEMPT_ASSOCIATIONS = ['OWNER'];

// Good first issues are for a first pull request (owner decision D2,
// 2026-10-25). GitHub reports CONTRIBUTOR once a person has a commit here,
// which every squash-merged pull request gives its author. One merged author
// (2026-10-27) still reads NONE, so the commit history is asked as well.
export const RETURNER_ASSOCIATIONS = ['CONTRIBUTOR', 'COLLABORATOR', 'MEMBER'];

// Comments older than the bot, or older than a week, are left alone: the owner
// answered claims by hand until LAUNCH_AT, and a week bounds how far back a
// run looks for a command that a dropped run never answered.
export const LAUNCH_AT = Date.parse('2026-10-27T15:30:00Z');
export const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// An owner comment marks the comments before it as seen, so a claim the owner
// handled by hand is not answered again. A comment newer than this may still
// be waiting for its run (a runner start took about 5 minutes once, and the
// job's timeout is 5), so it is answered whatever the owner said meanwhile.
export const OWNER_GRACE_MS = 10 * 60 * 1000;

const REPO_URL = 'https://github.com/jannskiee/floe';
const CONTRIBUTING_URL = `${REPO_URL}/blob/main/CONTRIBUTING.md`;
// Good first issues that nobody holds and no pull request targets. The same
// search is linked from CONTRIBUTING.md, README.md and the issue chooser
// (claim.test.mjs keeps the copies equal). -linked:pr also hides an issue
// whose only linked pull request was closed: a closing reference outlives the
// close (measured 2026-10-27). The bot still assigns such an issue; to list
// it again, edit the closed pull request's body to drop its "Closes #N".
export const FREE_URL = `${REPO_URL}/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22%20no%3Aassignee%20-linked%3Apr`;
export const HELP_URL = `${REPO_URL}/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22help%20wanted%22%20no%3Aassignee`;

export function heldUrl(login) {
    return `${REPO_URL}/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22%20assignee%3A${encodeURIComponent(login)}`;
}

// The setup section of CONTRIBUTING.md the go-ahead links, by the title prefix
// the issues use ("Desktop: ..."). claim.test.mjs checks every anchor against
// CONTRIBUTING.md's headings, which no other check reads.
export const SETUP = {
    desktop: ['Desktop app', 'desktop-app-only-needed-if-youre-changing-the-desktop-app'],
    cli: ['CLI', 'cli-only-needed-if-youre-changing-cli-code'],
    'self-hosting': ['Full stack with Docker', 'full-stack-with-docker-no-local-toolchain-needed'],
    docs: ['Documentation', 'documentation-only-needed-if-youre-changing-docs'],
    server: ['Client + Server', 'client--server-for-server-changes-and-for-test-transfers'],
};
export const DEFAULT_SETUP = ['Development Setup', 'development-setup'];

export function setupFor(title) {
    const m = /^\s*([A-Za-z-]+)\s*:/.exec(String(title ?? ''));
    // The prefix is the issue author's text: own keys only, so "Constructor:"
    // finds nothing on the object's prototype.
    const key = m && m[1].toLowerCase();
    const [name, anchor] = (key && Object.hasOwn(SETUP, key) && SETUP[key]) || DEFAULT_SETUP;
    return { name, url: `${CONTRIBUTING_URL}#${anchor}` };
}

// Every reply, one file each in .github/claim/. assigned and untaken change
// the issue and are always posted; any other reply that would repeat the last
// one sent to the same person on the issue edits that one instead.
export const KINDS = [
    'assigned',
    'already-yours',
    'not-claimable-help',
    'not-claimable',
    'returner',
    'released',
    'holds-one',
    'taken',
    'has-pr',
    'hint',
    'untake-hint',
    'untaken',
    'not-assigned',
    'refused',
    'error',
];
const ACTING = new Set(['assigned', 'untaken']);
export const PLACEHOLDERS = ['login', 'free_url', 'help_url', 'held_url', 'setup_name', 'setup_url', 'run_url'];

export function loadReplies(dir = new URL('../claim/', import.meta.url)) {
    const replies = {};
    for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md')) continue;
        replies[name.slice(0, -3)] = readFileSync(new URL(name, dir), 'utf8')
            .replace(/\r\n?/g, '\n')
            .trimEnd();
    }
    return replies;
}

export function render(template, vars) {
    return template.replace(/\{\{([a-z_]+)\}\}/g, (_, key) => {
        if (!PLACEHOLDERS.includes(key) || vars[key] === undefined) {
            throw new Error(`reply placeholder {{${key}}} has no value`);
        }
        return vars[key];
    });
}

const MARKER_RE = /<!-- floe-claim kind=([a-z-]+) login=([A-Za-z0-9-]+) reply-to=([0-9]+(?:,[0-9]+)*) -->/;

export function marker({ kind, login, replyTo }) {
    return `<!-- floe-claim kind=${kind} login=${login} reply-to=${replyTo.join(',')} -->`;
}

export function parseMarker(body) {
    const m = MARKER_RE.exec(String(body ?? ''));
    if (!m) return null;
    return { kind: m[1], login: m[2], replyTo: m[3].split(',').map(Number) };
}

// The command is the first line that is neither empty nor a quote, so a reply
// that quotes the issue first still counts. Text after the command is fine:
// pandas lost a claim that read "/take  I'd like to work on this" to an exact
// match (pandas-dev/pandas#71278). /takeover is not /take.
export function parseCommand(body) {
    for (const raw of String(body ?? '').replace(/\r\n?/g, '\n').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('>')) continue;
        const m = /^\/(take|untake)(?![\w-])/i.exec(line);
        return m ? m[1].toLowerCase() : null;
    }
    return null;
}

// Every claim on Floe before the bot was plain language ("I'd like to work on
// this", "Could you please assign it to me?"). Such a comment on a good first
// issue is answered once, with how to claim or the reason /take would refuse,
// and never acted on, so a phrase this misreads costs one reply. A /take that
// is not at the start ("Hi! /take") is answered the same way, so it is never
// lost in silence.
const CLAIM_PATTERNS = [
    /\bwork(?:ing)? on (?:this|it)\b/i,
    /\b(?:i'?d|i would|i'?ll|i will|let me|can i|could i|may i)\s+(?:(?:really\s+)?(?:like|love) to\s+)?(?:take(?!\s+a\s+(?:look|peek))\b|work on\b|pick (?:this |it )?up\b|tackle\b|claim\b)/i,
    /\bassign (?:it|this|me)\b/i,
    /\bassigned to me\b/i,
];

// A phone types curly apostrophes: they read as straight ones. Built from code
// points so this file stays plain ASCII.
const CURLY_QUOTES = new RegExp(`[${String.fromCharCode(0x2018, 0x2019)}]`, 'g');

export function looksLikeClaim(body) {
    const text = String(body ?? '').replace(CURLY_QUOTES, "'");
    return CLAIM_PATTERNS.some((re) => re.test(text));
}

// The comment's own words: quoted lines dropped.
function unquoted(body) {
    return String(body ?? '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .filter((line) => !line.trim().startsWith('>'))
        .join('\n');
}

// A /take anywhere outside a quote, for the hint above. One that speaks to
// someone else ("@newbie, just comment /take here") is advice, not a claim.
// The maintainer's login is the one @-mention that still counts as a claim.
export function mentionsTake(body) {
    const text = unquoted(body);
    return /(?:^|\s)\/take(?![\w-])/im.test(text) && !/(?:^|[^\w@])@(?!jannskiee\b)[A-Za-z0-9-]+/i.test(text);
}

// The holder writing "/untake" after other words gets told how to give the
// issue back, rather than nothing.
export function mentionsUntake(body) {
    return /(?:^|\s)\/untake(?![\w-])/im.test(unquoted(body));
}

// The /take rules, first match wins. Each question is asked only when the
// rules before it have passed, because most of them cost an API call.
export async function decideTake(q) {
    if (q.isAssignee) return 'already-yours';
    if (!q.isGoodFirstIssue) return q.isHelpWanted ? 'not-claimable-help' : 'not-claimable';
    if (q.returnerByAssociation || (await q.hasCommits())) return 'returner';
    if (await q.releasedByMaintainer()) return 'released';
    if (q.hasAssignee) return 'taken';
    if (await q.otherOpenPullRequest()) return 'has-pr';
    // Last, so the reply's advice (give that one back, then /take this one)
    // is true: this issue is free in every other way.
    if (await q.holdsAnotherGoodFirstIssue()) return 'holds-one';
    return 'assign';
}

const lower = (s) => String(s ?? '').toLowerCase();
const loginsOf = (users) => new Set((users ?? []).map((u) => lower(u?.login)));
const isBotReply = (c) => c.user?.login === BOT_LOGIN && c.user?.type === 'Bot';
const byTime = (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id;

export async function main({ github, context, core, now = Date.now(), replies = loadReplies() }) {
    const { owner, repo } = context.repo;
    const number = context.payload.issue.number;
    const trigger = context.payload.comment;
    const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
    const base = { owner, repo, issue_number: number };

    let issue;
    let comments;
    try {
        ({ data: issue } = await github.rest.issues.get(base));
        if (issue.state !== 'open' || issue.pull_request) {
            core.info(`issue ${number} is not an open issue; nothing to do`);
            return;
        }
        comments = await github.paginate(github.rest.issues.listComments, { ...base, per_page: 100 });
        // The list can lag the webhook by a moment. A comment that is gone
        // was deleted, and a deleted /take is not acted on.
        if (trigger && !comments.some((c) => c.id === trigger.id)) {
            try {
                const { data } = await github.rest.issues.getComment({ owner, repo, comment_id: trigger.id });
                comments.push(data);
            } catch (err) {
                if (err.status !== 404) throw err;
                core.info(`comment ${trigger.id} was deleted`);
            }
        }
    } catch (err) {
        core.warning(`issue ${number}: could not read the issue (${err.status ?? err.name})`);
        // Without the thread there is nothing to reconcile, but a command
        // still gets an answer, so the commenter is not left waiting.
        if (trigger && parseCommand(trigger.body)) {
            try {
                const body = render(replies.error, varsFor(trigger.user.login, issue, runUrl));
                await github.rest.issues.createComment({
                    ...base,
                    body: `${body}\n\n${marker({ kind: 'error', login: trigger.user.login, replyTo: [trigger.id] })}`,
                });
            } catch {
                core.setFailed(`issue ${number}: could not read the issue or reply`);
            }
        }
        return;
    }
    comments.sort(byTime);

    let assignees = loginsOf(issue.assignees);
    const labels = new Set((issue.labels ?? []).map((l) => lower(typeof l === 'string' ? l : l.name)));
    const isGoodFirstIssue = labels.has(CLAIM_LABEL);

    // What the bot has already said on this issue.
    const answered = new Set();
    const lastReply = new Map();
    for (const c of comments) {
        if (!isBotReply(c)) continue;
        const m = parseMarker(c.body);
        if (!m) continue;
        for (const id of m.replyTo) answered.add(id);
        lastReply.set(lower(m.login), { id: c.id, ...m });
    }
    const lastOwnerComment = comments
        .filter((c) => !isBotReply(c) && EXEMPT_ASSOCIATIONS.includes(c.author_association))
        .reduce((t, c) => Math.max(t, Date.parse(c.created_at)), 0);

    const work = [];
    for (const c of comments) {
        // ghost is the placeholder GitHub shows for a deleted account.
        if (isBotReply(c) || c.user?.type !== 'User' || lower(c.user?.login) === 'ghost') continue;
        if (EXEMPT_ASSOCIATIONS.includes(c.author_association)) continue;
        if (answered.has(c.id)) continue;
        const t = Date.parse(c.created_at);
        if (t < LAUNCH_AT || now - t > WINDOW_MS) continue;
        // The owner commented after an older comment: the owner has seen it
        // and answered. Never the comment that started this run, and never
        // one recent enough that its own run may still be waiting.
        if (lastOwnerComment > t && c.id !== trigger?.id && now - t > OWNER_GRACE_MS) continue;
        const command = parseCommand(c.body);
        if (command) work.push({ comment: c, kind: command });
        else if (assignees.has(lower(c.user.login)) && mentionsUntake(c.body)) {
            work.push({ comment: c, kind: 'untake-hint' });
        } else if (isGoodFirstIssue && (looksLikeClaim(c.body) || mentionsTake(c.body))) {
            work.push({ comment: c, kind: 'hint' });
        }
    }
    if (work.length === 0) {
        core.info(`issue ${number}: nothing to answer`);
        return;
    }

    // Answers that cost an API call, asked at most once per run.
    let pullRequests;
    let events;
    const commitsBy = new Map();
    const heldBy = new Map();
    const openPullRequestAuthors = async () => {
        if (!pullRequests) {
            const data = await github.graphql(
                `query($owner: String!, $repo: String!, $number: Int!) {
                    repository(owner: $owner, name: $repo) {
                        issue(number: $number) {
                            closedByPullRequestsReferences(first: 50, includeClosedPrs: false) {
                                nodes { number state author { login } }
                            }
                        }
                    }
                }`,
                { owner, repo, number }
            );
            const nodes = data?.repository?.issue?.closedByPullRequestsReferences?.nodes ?? [];
            core.info(
                `issue ${number}: linked pull requests ${nodes.map((n) => `${n.number}:${n.state}:${n.author?.login ?? 'ghost'}`).join(', ') || 'none'}`
            );
            // includeClosedPrs:false still returns merged pull requests.
            // A ghost (deleted) author is someone else.
            pullRequests = nodes.filter((n) => n.state === 'OPEN').map((n) => (n.author ? lower(n.author.login) : null));
        }
        return pullRequests;
    };
    const questions = (login, association) => ({
        isAssignee: assignees.has(lower(login)),
        hasAssignee: assignees.size > 0,
        isGoodFirstIssue,
        isHelpWanted: labels.has(HELP_LABEL),
        returnerByAssociation: RETURNER_ASSOCIATIONS.includes(association),
        hasCommits: async () => {
            if (!commitsBy.has(lower(login))) {
                const { data } = await github.rest.repos.listCommits({ owner, repo, author: login, per_page: 1 });
                commitsBy.set(lower(login), data.length > 0);
            }
            return commitsBy.get(lower(login));
        },
        releasedByMaintainer: async () => {
            events ??= await github.paginate(github.rest.issues.listEvents, { ...base, per_page: 100 });
            // The issue events API puts the person unassigned in both actor
            // and assignee; whoever made the change is assigner (measured on
            // #692, 2026-10-27). Without an assigner the fallback is that same
            // person, so the rule fails open rather than blocking a claim.
            return events.some(
                (e) =>
                    e.event === 'unassigned' &&
                    lower(e.assignee?.login) === lower(login) &&
                    ![lower(login), BOT_LOGIN].includes(lower((e.assigner ?? e.actor)?.login))
            );
        },
        holdsAnotherGoodFirstIssue: async () => {
            if (!heldBy.has(lower(login))) {
                const held = await github.paginate(github.rest.issues.listForRepo, {
                    owner,
                    repo,
                    assignee: login,
                    state: 'open',
                    labels: CLAIM_LABEL,
                    per_page: 100,
                });
                heldBy.set(lower(login), held.some((i) => !i.pull_request && i.number !== number));
            }
            return heldBy.get(lower(login));
        },
        otherOpenPullRequest: async () => (await openPullRequestAuthors()).some((a) => a !== lower(login)),
    });

    const react = async (commentId, content) => {
        try {
            await github.rest.reactions.createForIssueComment({ owner, repo, comment_id: commentId, content });
        } catch (err) {
            core.info(`comment ${commentId}: reaction not added (${err.status ?? err.name})`);
        }
    };

    const reply = async (comment, kind) => {
        const login = comment.user.login;
        const last = lastReply.get(lower(login));
        const text = render(replies[kind], varsFor(login, issue, runUrl));
        if (!ACTING.has(kind) && last && last.kind === kind) {
            const replyTo = [...last.replyTo, comment.id];
            await github.rest.issues.updateComment({
                owner,
                repo,
                comment_id: last.id,
                body: `${text}\n\n${marker({ kind, login, replyTo })}`,
            });
            last.replyTo = replyTo;
            await react(comment.id, 'eyes');
        } else {
            const { data } = await github.rest.issues.createComment({
                ...base,
                body: `${text}\n\n${marker({ kind, login, replyTo: [comment.id] })}`,
            });
            lastReply.set(lower(login), { id: data.id, kind, login, replyTo: [comment.id] });
        }
        answered.add(comment.id);
        core.info(`issue ${number}: comment ${comment.id} by ${login}: ${kind}`);
    };

    const take = async (comment) => {
        const login = comment.user.login;
        const verdict = await decideTake(questions(login, comment.author_association));
        if (verdict !== 'assign') return reply(comment, verdict);
        const { data: added } = await github.rest.issues.addAssignees({ ...base, assignees: [login] });
        const after = loginsOf(added.assignees);
        if (!after.has(lower(login))) return reply(comment, 'refused');
        if ([...after].some((a) => a !== lower(login))) {
            // Someone else was assigned in the same moment (the owner, by
            // hand): the claim gives way.
            const { data: removed } = await github.rest.issues.removeAssignees({ ...base, assignees: [login] });
            assignees = loginsOf(removed.assignees);
            return reply(comment, assignees.has(lower(login)) ? 'refused' : 'taken');
        }
        assignees = after;
        await react(comment.id, '+1');
        return reply(comment, 'assigned');
    };

    const untake = async (comment) => {
        const login = comment.user.login;
        if (!assignees.has(lower(login))) return reply(comment, 'not-assigned');
        const { data: removed } = await github.rest.issues.removeAssignees({ ...base, assignees: [login] });
        const after = loginsOf(removed.assignees);
        if (after.has(lower(login))) return reply(comment, 'refused');
        assignees = after;
        await react(comment.id, '+1');
        return reply(comment, 'untaken');
    };

    const hint = async (comment) => {
        const login = comment.user.login;
        // Once per person per issue, never to the person who holds it, and
        // never to someone whose own open pull request already targets it.
        if (lastReply.has(lower(login)) || assignees.has(lower(login))) return;
        if ((await openPullRequestAuthors()).includes(lower(login))) return;
        const verdict = await decideTake(questions(login, comment.author_association));
        if (verdict === 'already-yours') return;
        return reply(comment, verdict === 'assign' ? 'hint' : verdict);
    };

    const untakeHint = async (comment) => {
        if (!assignees.has(lower(comment.user.login))) return;
        return reply(comment, 'untake-hint');
    };

    let unanswered = 0;
    for (const { comment, kind } of work) {
        try {
            if (kind === 'take') await take(comment);
            else if (kind === 'untake') await untake(comment);
            else if (kind === 'untake-hint') await untakeHint(comment);
            else await hint(comment);
        } catch (err) {
            core.warning(`issue ${number}: comment ${comment.id} failed (${err.status ?? err.name})`);
            // Only a command gets the error reply; a hint is retried later.
            if (kind === 'hint' || kind === 'untake-hint') continue;
            try {
                await reply(comment, 'error');
            } catch {
                unanswered += 1;
            }
        }
    }
    // A failed run emails the person who triggered it, who is the commenter,
    // not the owner. So the run fails only when a command got no answer at
    // all; the error reply already names the owner.
    if (unanswered > 0) core.setFailed(`issue ${number}: ${unanswered} command(s) got no reply`);
}

function varsFor(login, issue, runUrl) {
    const setup = setupFor(issue?.title);
    return {
        login,
        free_url: FREE_URL,
        help_url: HELP_URL,
        held_url: heldUrl(login),
        setup_name: setup.name,
        setup_url: setup.url,
        run_url: runUrl,
    };
}
