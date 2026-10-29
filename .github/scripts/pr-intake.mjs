// The pull request intake sweep: everything .github/workflows/pr-intake.yml
// does after its checkout. It reads every open pull request through the API,
// never its code, and for each one from outside the repository plans one
// comment and up to three labels from facts GitHub holds: who holds the linked
// issue, whether another open pull request targets it, whether an issue is
// linked at all, and notes for a first pull request. Every text is a file in
// .github/intake/. Tests: pr-intake.test.mjs beside this file, run by ci.yml's
// Repo guardrails job.
//
// Rules the code below keeps, each with a reason:
// - Until the owner's go-live pull request sets LIVE_SINCE, every run is a dry
//   run: its plan goes to the job summary and the log, and nothing to GitHub
//   (research item 13: one week of dry runs first). After that only a schedule
//   or push run on main writes; a manual dispatch always previews.
// - A pull request's title, body, branch, file paths and comments are only
//   matched against the fixed patterns here. None of them reaches a comment,
//   the job summary or the log (a log line starting with :: would be read as a
//   workflow command). The texts carry plain numbers and nothing else of the
//   pull request's, and an error is logged by its status or name only. The one
//   exception is Octokit's own log line for a failed request, which names the
//   request's path: for the commit-history read that path holds the author's
//   login, which GitHub limits to letters, digits and hyphens.
// - No text carries #123 or a link to an issue or pull request: either would
//   put a "mentioned this" entry on that thread, so a number is written out
//   ("issue 729"). The claim bot keeps the same rule.
// - One comment per pull request: the oldest comment by the github-actions bot
//   that carries the marker. It is edited only when its text changes and never
//   posted twice. The bot is known by its user id, because GraphQL names it
//   github-actions and REST github-actions[bot] (measured 2026-10-28), and
//   other bots comment too (vercel on every pull request, mintlify on many).
// - The three labels are the bot's: every live run sets them from the facts,
//   whoever changed them in between. The owner's no-intake label turns the
//   sweep off for one pull request; contributors cannot set labels.
// - While an issue the pull request links is closed (another pull request
//   fixed it, or the owner closed it), the sweep leaves that pull request's
//   comment and labels as they are: they are what the owner decides by.
// - Owner decision D6: a pull request on an issue assigned to someone else
//   gets a label and a note and is never closed. D7 and D8: the title and
//   changelog notes are advice. The claim note follows the claim bot's own
//   rules (claim.mjs), so the two bots never contradict each other.
// - A read that fails writes nothing for what it would have decided: the
//   whole run for the pull request list, one pull request for its comments or
//   its author's commit history.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { CLAIM_LABEL, HELP_URL, MAINTAINER, RETURNER_ASSOCIATIONS } from './claim.mjs';

// null: every run is a dry run, and pr-intake.yml's token cannot write
// (pull-requests: read; pr-intake.test.mjs keeps the two in step). The go-live
// pull request sets the moment, in milliseconds (Date.parse('...Z')), from
// which new pull requests get the comment and the labels, and raises the
// token to write. The ones opened before it were answered by hand, as
// LAUNCH_AT says for the claim bot.
export const LIVE_SINCE = null;

// The github-actions bot: GraphQL Bot.databaseId and REST user.id, both
// 41898282 (read 2026-10-28 on issue 784's claim reply).
export const BOT_USER_ID = 41898282;
export const MARKER_PREFIX = '<!-- floe-pr-intake';
export const MARKER_VERSION = 1;

export const LABEL_UNCLAIMED = 'unclaimed';
export const LABEL_CONFLICT = 'claim-conflict';
export const LABEL_COMPETING = 'competing-pr';
export const BOT_LABELS = [LABEL_UNCLAIMED, LABEL_CONFLICT, LABEL_COMPETING];
export const OPT_OUT_LABEL = 'no-intake';

// The notes in the order a comment lists them; each is a file in
// .github/intake/, as are the comment's first line and the all-clear note.
export const SECTIONS = [
    'claim-take',
    'claim-returner',
    'claim-ask',
    'claim-other',
    'competing',
    'no-issue',
    'first-pr',
    'title',
    'changelog',
];
export const TEXTS = ['intro', ...SECTIONS, 'all-clear'];
export const PLACEHOLDERS = ['issue', 'others', 'help_url'];

export const DEFAULTS = Object.freeze({
    liveSince: LIVE_SINCE,
    // Pull requests by these are not from outside: the owner's own, and those
    // of anyone with write access.
    maintainer: MAINTAINER,
    skipAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
    authorTypes: ['User'],
    // Closing keywords link only into the default branch.
    baseRef: 'main',
    liveRef: 'refs/heads/main',
    // A closing reference links a moment after a pull request opens, and the
    // first comment is the one that notifies, so a new pull request waits a run.
    minAgeMs: 10 * 60 * 1000,
    // A bound on what one run can write, so a bug cannot flood. GitHub asks for
    // a pause between content-creating requests.
    maxWrites: 10,
    writeGapMs: 1000,
    retryDelayMs: 5000,
    maxPages: 10,
});

// Labels and assignees are read in full or the pull request is skipped; more
// than 100 files only costs the changelog note, and more than 100 comments are
// read again over REST so the marker is never missed.
export const QUERY = `query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 50, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        createdAt
        isDraft
        isCrossRepository
        authorAssociation
        baseRefName
        title
        body
        author { __typename login }
        labels(first: 20) { totalCount nodes { name } }
        files(first: 100) { totalCount nodes { path } }
        closingIssuesReferences(first: 10) {
          totalCount
          nodes {
            number
            state
            title
            repository { nameWithOwner }
            labels(first: 20) { totalCount nodes { name } }
            assignees(first: 10) { totalCount nodes { login } }
          }
        }
        comments(first: 100) {
          totalCount
          nodes {
            databaseId
            createdAt
            body
            author { __typename login ... on Bot { databaseId } }
          }
        }
      }
    }
  }
}`;

const lower = (s) => String(s ?? '').toLowerCase();
const namesOf = (conn) => (conn?.nodes ?? []).filter(Boolean).map((n) => lower(n.name));
const complete = (conn) => !conn || (conn.totalCount ?? 0) <= (conn.nodes?.length ?? 0);
const errLabel = (err) => err?.status ?? err?.name ?? 'error';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function loadTexts(dir = new URL('../intake/', import.meta.url)) {
    const texts = {};
    for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md')) continue;
        texts[name.slice(0, -3)] = readFileSync(new URL(name, dir), 'utf8')
            .replace(/\r\n?/g, '\n')
            .trimEnd();
    }
    return texts;
}

export function render(template, vars) {
    return template.replace(/\{\{([a-z_]+)\}\}/g, (_, key) => {
        if (!PLACEHOLDERS.includes(key) || vars[key] === undefined) {
            throw new Error(`intake placeholder {{${key}}} has no value`);
        }
        return vars[key];
    });
}

// "pull request 733", "pull requests 733 and 752": written out, never #733.
export function othersText(numbers) {
    const list = [...numbers].sort((a, b) => a - b).map(String);
    if (list.length === 1) return `pull request ${list[0]}`;
    return `pull requests ${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

export function stateOf(text) {
    return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

export function marker(state) {
    return `${MARKER_PREFIX} v=${MARKER_VERSION} state=${state} -->`;
}

// Any version: a later marker format still finds the same comment, and a
// damaged one reads as a change, so the next write repairs it.
const STATE_RE = /<!-- floe-pr-intake v=\d+ state=([0-9a-f]{12}) -->/;

export function parseState(body) {
    const m = STATE_RE.exec(String(body ?? ''));
    return m ? m[1] : null;
}

function fromGraphQL(c) {
    return {
        id: c.databaseId,
        createdAt: Date.parse(c.createdAt),
        body: String(c.body ?? ''),
        own: c.author?.__typename === 'Bot' && c.author?.databaseId === BOT_USER_ID,
    };
}

function fromRest(c) {
    return {
        id: c.id,
        createdAt: Date.parse(c.created_at),
        body: String(c.body ?? ''),
        own: c.user?.type === 'Bot' && c.user?.id === BOT_USER_ID,
    };
}

// The bot's own marked comments, oldest first. Only the first is ever written.
export function ownComments(comments) {
    return comments
        .filter((c) => c.own && c.body.includes(MARKER_PREFIX))
        .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
}

export function normalize(node) {
    const issues = (node.closingIssuesReferences?.nodes ?? []).filter(Boolean).map((i) => ({
        number: i.number,
        open: i.state === 'OPEN',
        title: String(i.title ?? ''),
        repo: lower(i.repository?.nameWithOwner),
        labels: namesOf(i.labels),
        assignees: (i.assignees?.nodes ?? []).filter(Boolean).map((a) => lower(a.login)),
        complete: complete(i.labels) && complete(i.assignees),
    }));
    return {
        number: node.number,
        createdAt: Date.parse(node.createdAt),
        isDraft: node.isDraft === true,
        isFork: node.isCrossRepository === true,
        association: String(node.authorAssociation ?? ''),
        base: String(node.baseRefName ?? ''),
        title: String(node.title ?? ''),
        body: String(node.body ?? ''),
        author: node.author ? { type: String(node.author.__typename ?? ''), login: String(node.author.login ?? '') } : null,
        labels: namesOf(node.labels),
        complete: complete(node.labels) && complete(node.closingIssuesReferences) && issues.every((i) => i.complete),
        files: (node.files?.nodes ?? []).filter(Boolean).map((f) => String(f.path ?? '')),
        filesComplete: complete(node.files),
        issues,
        comments: (node.comments?.nodes ?? []).filter(Boolean).map(fromGraphQL),
        commentsComplete: complete(node.comments),
    };
}

// A GraphQL error that still carries the list, with every error inside one or
// more pull requests' closing references (an issue in a repository the token
// cannot read): those pull requests are skipped, the rest are used. Anything
// else is not a partial answer.
export function partialIndexes(err) {
    if (!err?.data?.repository?.pullRequests || !Array.isArray(err.errors) || err.errors.length === 0) return null;
    const bad = new Set();
    for (const e of err.errors) {
        const p = e?.path;
        if (
            !Array.isArray(p) ||
            p[0] !== 'repository' ||
            p[1] !== 'pullRequests' ||
            p[2] !== 'nodes' ||
            !Number.isInteger(p[3]) ||
            p[4] !== 'closingIssuesReferences'
        ) {
            return null;
        }
        bad.add(p[3]);
    }
    return bad;
}

// One retry, after a pause, for a server error (Octokit reports a dropped
// connection as a 500 too) or a GraphQL error answer, which comes with HTTP
// 200 and no status. A rate limit is never retried, whether a 403 or 429 or a
// GraphQL RATE_LIMITED answer: GitHub asks for a wait of a minute or more,
// and the next scheduled run is the retry.
export function retryable(err) {
    if (err?.errors?.some?.((e) => e?.type === 'RATE_LIMITED')) return false;
    if (err?.name === 'GraphqlResponseError') return true;
    return Number.isInteger(err?.status) && err.status >= 500;
}

async function readPage(github, vars, cfg, sleep) {
    for (let attempt = 0; ; attempt++) {
        try {
            return { data: await github.graphql(QUERY, vars), bad: new Set() };
        } catch (err) {
            const bad = partialIndexes(err);
            if (bad) return { data: err.data, bad };
            if (attempt > 0 || !retryable(err)) throw err;
            await sleep(cfg.retryDelayMs);
        }
    }
}

export async function readPullRequests(github, { owner, repo }, cfg, sleep) {
    const prs = [];
    let cursor = null;
    for (let page = 0; page < cfg.maxPages; page++) {
        const { data, bad } = await readPage(github, { owner, repo, cursor }, cfg, sleep);
        const conn = data?.repository?.pullRequests;
        if (!conn || !Array.isArray(conn.nodes)) throw new TypeError('the response holds no pull request list');
        conn.nodes.forEach((node, i) => {
            if (!node) return;
            const pr = normalize(node);
            if (bad.has(i)) pr.complete = false;
            prs.push(pr);
        });
        if (!conn.pageInfo?.hasNextPage) return prs;
        cursor = conn.pageInfo.endCursor;
    }
    throw new RangeError('more open pull requests than the sweep reads');
}

// The style CONTRIBUTING step 9 asks for. Advice only (D7).
const TITLE_RE = /^(?:feat|fix|docs|test|refactor|chore|ci|perf|build|revert|style)(?:\([a-z0-9][a-z0-9 ,./-]*\))?!?: [a-z0-9`]/;

export function titleIsConventional(title) {
    return TITLE_RE.test(String(title ?? ''));
}

// The template's own Changelog comment names both words, so comments go first.
export function stripHtmlComments(text) {
    return String(text ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
}

export function mentionsChangelogWord(body) {
    return /not\s+user[\s-]*visible|needs\s+a\s+(?:changelog\s+)?bullet/i.test(stripHtmlComments(body));
}

export const isProductPath = (path) => /^(?:client|cli|desktop|server)\//.test(path);
export const isTestPath = (path) =>
    /(?:^|\/)(?:e2e|testdata|__tests__)\//.test(path) || /(?:_test\.go|\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?)$/.test(path);

// D8: the bullet is asked for, never required.
export function needsChangelogNote(pr) {
    if (!pr.filesComplete) return false;
    if (pr.files.includes('docs/changelog.mdx')) return false;
    if (!pr.files.some((p) => isProductPath(p) && !isTestPath(p))) return false;
    return !mentionsChangelogWord(pr.body);
}

export function isOutside(pr, cfg) {
    if (!pr.author || lower(pr.author.login) === 'ghost') return false;
    if (!cfg.authorTypes.includes(pr.author.type)) return false;
    if (lower(pr.author.login) === lower(cfg.maintainer)) return false;
    return !cfg.skipAssociations.includes(pr.association);
}

// Issue number to the open pull requests (any author, drafts too) that close
// it into the default branch. Built from the open pull requests' own closing
// references, so a merged or closed one and one in another repository never
// count.
export function siblingsOf(prs, repoName, cfg) {
    const siblings = new Map();
    for (const pr of prs) {
        if (pr.base !== cfg.baseRef) continue;
        for (const issue of pr.issues) {
            if (issue.repo !== repoName || !issue.open) continue;
            if (!siblings.has(issue.number)) siblings.set(issue.number, []);
            siblings.get(issue.number).push(pr.number);
        }
    }
    return siblings;
}

// The notes and labels for one pull request. isReturner answers the claim
// bot's first-pull-request rule (D2) the way /take would: true, false, or null
// when the commit history could not be read, which leaves the plan unread.
export async function planFor(pr, { siblings, repoName, cfg, isReturner }) {
    const sections = [];
    const labels = new Set();
    const author = lower(pr.author.login);
    const linked = pr.issues.filter((i) => i.repo === repoName);
    for (const issue of linked) {
        if (!issue.open || issue.assignees.includes(author)) continue;
        if (issue.assignees.length > 0) {
            sections.push({ id: 'claim-other', issue: issue.number });
            labels.add(LABEL_CONFLICT);
            continue;
        }
        labels.add(LABEL_UNCLAIMED);
        const others = (siblings.get(issue.number) ?? []).filter((n) => n !== pr.number);
        if (others.length > 0) {
            // CONTRIBUTING judges these on merit (the first that matches the
            // issue is merged), so the note names no order and /take is not
            // offered: the claim bot would refuse it while another pull
            // request targets the issue.
            sections.push({ id: 'competing', issue: issue.number, others });
            labels.add(LABEL_COMPETING);
            continue;
        }
        // The claim bot's own order: help wanted and unlabeled issues are
        // assigned by hand; a good first issue is for a first pull request.
        if (!issue.labels.includes(CLAIM_LABEL)) {
            sections.push({ id: 'claim-ask', issue: issue.number });
            continue;
        }
        const returner = await isReturner(pr);
        if (returner === null) return { sections: [], labels: new Set(), unread: true };
        sections.push({ id: returner ? 'claim-returner' : 'claim-take', issue: issue.number });
    }
    if (linked.length === 0) sections.push({ id: 'no-issue' });
    // A draft is work in progress: only the notes that keep two people from
    // doing the same work.
    if (!pr.isDraft) {
        // A first pull request is one whose author has no commit here: what
        // the repository's fork policy (first_time_contributors) holds runs
        // for, and the claim bot's returner rule. Not the association: the
        // workflow's token never sees FIRST_TIME_CONTRIBUTOR or FIRST_TIMER
        // (2026-10-29: the owner's token read both open first-timer pull
        // requests as FIRST_TIME_CONTRIBUTOR, and the first push run on main
        // planned no first-pull-request note for either). Every outside pull
        // request comes from a fork, so that needs no check either.
        const returner = await isReturner(pr);
        if (returner === null) return { sections: [], labels: new Set(), unread: true };
        if (!returner) sections.push({ id: 'first-pr' });
        const sameTitle = linked.some((i) => lower(i.title.trim()) === lower(pr.title.trim()));
        if (!titleIsConventional(pr.title) || sameTitle) sections.push({ id: 'title' });
        if (needsChangelogNote(pr)) sections.push({ id: 'changelog' });
    }
    sections.sort((a, b) => SECTIONS.indexOf(a.id) - SECTIONS.indexOf(b.id) || (a.issue ?? 0) - (b.issue ?? 0));
    return { sections, labels, unread: false };
}

// Every text goes through render(), the intro and the all-clear note too, so
// a placeholder that has no value stops the run instead of reaching a comment.
export function commentText(sections, texts) {
    if (sections.length === 0) return null;
    const notes = sections.map((s) =>
        render(texts[s.id], {
            issue: s.issue === undefined ? undefined : String(s.issue),
            others: s.others ? othersText(s.others) : undefined,
            help_url: HELP_URL,
        })
    );
    return `${render(texts.intro, {})}\n\n${notes.join('\n')}`;
}

export function allClearText(texts) {
    return `${render(texts.intro, {})}\n\n${render(texts['all-clear'], {})}`;
}

// What a live run would write for one pull request, from the plan and the
// pull request as read. The comment's text decides the comment; the labels are
// compared with the pull request's own, every run.
export function actionFor(pr, plan, texts) {
    const mine = ownComments(pr.comments);
    const existing = mine[0] ?? null;
    let text = commentText(plan.sections, texts);
    if (text === null && existing) text = allClearText(texts);
    let comment = null;
    let state = null;
    if (text !== null) {
        state = stateOf(text);
        if (!existing) comment = 'create';
        else if (parseState(existing.body) !== state) comment = 'edit';
    }
    const current = new Set(pr.labels.filter((l) => BOT_LABELS.includes(l)));
    const add = BOT_LABELS.filter((l) => plan.labels.has(l) && !current.has(l));
    const remove = BOT_LABELS.filter((l) => current.has(l) && !plan.labels.has(l));
    return {
        comment,
        commentId: existing?.id ?? null,
        duplicates: Math.max(0, mine.length - 1),
        text,
        state,
        add,
        remove,
        writes: (comment ? 1 : 0) + (add.length ? 1 : 0) + remove.length,
    };
}

export async function main({ github, context, core, config = {}, now = Date.now(), sleep = wait, texts = loadTexts() }) {
    const cfg = { ...DEFAULTS, ...config };
    // A date string here would read every pull request as opened after the
    // launch, so the first live run would comment on all of them.
    if (cfg.liveSince !== null && !Number.isFinite(cfg.liveSince)) {
        core.setFailed("LIVE_SINCE must be null or a time in milliseconds, such as Date.parse('2026-11-05T00:00:00Z')");
        return;
    }
    const { owner, repo } = context.repo;
    const repoName = lower(`${owner}/${repo}`);
    const live = cfg.liveSince !== null && ['schedule', 'push'].includes(context.eventName) && context.ref === cfg.liveRef;
    core.info(
        `mode: ${live ? 'live' : 'preview'} (event ${context.eventName}${cfg.liveSince === null ? ', LIVE_SINCE not set' : ''})`
    );

    let prs;
    try {
        prs = await readPullRequests(github, { owner, repo }, cfg, sleep);
    } catch (err) {
        core.setFailed(`could not read the open pull requests (${errLabel(err)}); nothing was written`);
        return;
    }
    const siblings = siblingsOf(prs, repoName, cfg);

    const returners = new Map();
    const isReturner = async (pr) => {
        if (RETURNER_ASSOCIATIONS.includes(pr.association)) return true;
        const key = lower(pr.author.login);
        if (!returners.has(key)) {
            try {
                const { data } = await github.rest.repos.listCommits({ owner, repo, author: pr.author.login, per_page: 1 });
                returners.set(key, data.length > 0);
            } catch (err) {
                // Unknown, not guessed: a guess would be written, and the next
                // run would write again once the history reads.
                core.warning(`pull request ${pr.number}: its author's commit history could not be read (${errLabel(err)}); skipped`);
                returners.set(key, null);
            }
        }
        return returners.get(key);
    };

    const rows = [];
    for (const pr of prs) {
        if (pr.base !== cfg.baseRef || !isOutside(pr, cfg)) continue;
        const row = { number: pr.number, would: null, plan: null, action: null, result: null };
        rows.push(row);
        if (pr.labels.includes(OPT_OUT_LABEL)) {
            row.would = 'opted-out';
            continue;
        }
        if (!pr.complete) {
            row.would = 'incomplete';
            continue;
        }
        if (!pr.commentsComplete) {
            try {
                const all = await github.paginate(github.rest.issues.listComments, {
                    owner,
                    repo,
                    issue_number: pr.number,
                    per_page: 100,
                });
                pr.comments = all.map(fromRest);
            } catch (err) {
                core.warning(`pull request ${pr.number}: its comments could not be read (${errLabel(err)}); skipped`);
                row.would = 'comments-unread';
                continue;
            }
        }
        // The issue was fixed by another pull request, or closed by the owner:
        // what this pull request's comment and labels say is what the owner
        // closes it by, so they are not rewritten to "all set". A pull request
        // that carries neither has nothing to keep, and is planned with the
        // closed issue left out. A kept comment can still hold claim advice
        // for another issue it links, until the owner closes it.
        const closedIssue = pr.issues.some((i) => i.repo === repoName && !i.open);
        const ours = ownComments(pr.comments).length > 0 || pr.labels.some((l) => BOT_LABELS.includes(l));
        if (closedIssue && ours) {
            row.would = 'issue-closed';
            continue;
        }
        row.plan = await planFor(pr, { siblings, repoName, cfg, isReturner });
        if (row.plan.unread) {
            row.plan = null;
            row.would = 'commits-unread';
            continue;
        }
        row.action = actionFor(pr, row.plan, texts);
        if (row.action.duplicates > 0) {
            core.warning(`pull request ${pr.number}: ${row.action.duplicates} extra intake comment(s); only the oldest is written`);
        }
        if (row.action.writes === 0) row.would = 'none';
        else if (cfg.liveSince !== null && pr.createdAt < cfg.liveSince) row.would = 'before-launch';
        else if (now - pr.createdAt < cfg.minAgeMs) row.would = 'too-new';
        else row.would = row.action.comment ?? 'labels';
    }

    let failed = 0;
    if (live) {
        const due = rows.filter((r) => WRITING.has(r.would));
        const start = due.length ? (Number(context.runNumber) || 0) % due.length : 0;
        let budget = cfg.maxWrites;
        let written = 0;
        const gap = async () => {
            if (written > 0) await sleep(cfg.writeGapMs);
            written += 1;
        };
        for (const row of [...due.slice(start), ...due.slice(0, start)]) {
            const a = row.action;
            if (a.writes > budget) {
                row.result = 'deferred';
                continue;
            }
            budget -= a.writes;
            try {
                const body = a.text === null ? null : `${a.text}\n\n${marker(a.state)}`;
                if (a.comment === 'create') {
                    await gap();
                    await github.rest.issues.createComment({ owner, repo, issue_number: row.number, body });
                } else if (a.comment === 'edit') {
                    await gap();
                    await github.rest.issues.updateComment({ owner, repo, comment_id: a.commentId, body });
                }
                if (a.add.length) {
                    await gap();
                    await github.rest.issues.addLabels({ owner, repo, issue_number: row.number, labels: a.add });
                }
                for (const name of a.remove) {
                    await gap();
                    try {
                        await github.rest.issues.removeLabel({ owner, repo, issue_number: row.number, name });
                    } catch (err) {
                        // Already gone (the owner removed it): what was wanted.
                        if (err.status !== 404) throw err;
                    }
                }
                row.result = 'done';
            } catch (err) {
                failed += 1;
                row.result = `failed-${errLabel(err)}`;
                core.warning(`pull request ${row.number}: a write failed (${errLabel(err)})`);
            }
        }
    }

    // One line per pull request in a fixed shape, which the dry-run review reads
    // back from the logs: codes, a hash, note ids and label names only.
    for (const row of rows) {
        const a = row.action;
        const notes = row.plan ? row.plan.sections.map((s) => s.id).join(',') || 'none' : '-';
        const labels = a ? labelChanges(a).join(',') || 'none' : '-';
        core.info(
            `plan #${row.number} would=${row.would} state=${a?.state ?? 'none'} notes=${notes} labels=${labels}${row.result ? ` result=${row.result}` : ''}`
        );
        if (!live && a?.text && a.writes > 0) {
            core.startGroup(`planned comment for pull request ${row.number}`);
            for (const line of a.text.split('\n')) core.info(`  ${line}`);
            core.endGroup();
        }
    }

    try {
        await core.summary.addRaw(summaryText({ rows, live, cfg, read: prs.length }), true).write();
    } catch (err) {
        core.warning(`the job summary was not written (${errLabel(err)})`);
    }
    if (failed > 0) core.setFailed(`${failed} pull request(s) had a write that failed`);
}

// The codes a row can carry, and the words the job summary shows for them.
export const WOULD = {
    create: 'post the comment',
    edit: 'edit the comment',
    labels: 'change the labels only',
    none: 'nothing: up to date',
    'opted-out': 'nothing: no-intake label',
    incomplete: 'nothing: data incomplete',
    'issue-closed': 'nothing: a linked issue is closed',
    'comments-unread': 'nothing: comments unread',
    'commits-unread': 'nothing: commit history unread',
    'before-launch': 'nothing: opened before LIVE_SINCE',
    'too-new': 'wait: opened under 10 minutes ago',
};
const WRITING = new Set(['create', 'edit', 'labels']);

const labelChanges = (a) => [...a.add.map((l) => `+${l}`), ...a.remove.map((l) => `-${l}`)];

export function summaryText({ rows, live, cfg, read }) {
    const lines = [`## PR intake: ${live ? 'live run' : 'preview'}`, ''];
    if (live) lines.push('This run wrote to GitHub what the table says.');
    else if (cfg.liveSince === null) lines.push('LIVE_SINCE is not set, so this run wrote nothing. The table says what a live run would do.');
    else lines.push('A manual run only previews, so this run wrote nothing. The table says what a live run would do.');
    lines.push('', `Open pull requests read: ${read}. From outside: ${rows.length}.`);
    if (rows.length === 0) return lines.join('\n');
    lines.push('', `| Pull request | A live run would | Notes | Labels |${live ? ' Result |' : ''}`);
    lines.push(`| --- | --- | --- | --- |${live ? ' --- |' : ''}`);
    for (const row of rows) {
        const a = row.action;
        const notes = row.plan ? row.plan.sections.map((s) => s.id).join(', ') || 'none' : '-';
        const labels = a ? labelChanges(a).join(', ') || 'none' : '-';
        lines.push(`| ${row.number} | ${WOULD[row.would]} | ${notes} | ${labels} |${live ? ` ${row.result ?? '-'} |` : ''}`);
    }
    for (const row of rows) {
        if (!row.action?.text || row.action.writes === 0) continue;
        lines.push('', `<details><summary>Pull request ${row.number}: the comment</summary>`, '', row.action.text, '', '</details>');
    }
    return lines.join('\n');
}
