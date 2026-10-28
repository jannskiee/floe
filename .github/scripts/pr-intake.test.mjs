// Tests for pr-intake.mjs: its rules, whole runs against an in-memory GitHub
// whose shapes were recorded from the real API on 2026-10-28, the texts in
// .github/intake/, CONTRIBUTING.md's headings and .github/workflows/pr-intake.yml.
// Run: node --test ".github/scripts/*.test.mjs"
//
// A pull request never runs the sweep (it runs from main, on a schedule and on
// pushes), so these tests are the only check its rules get before they run.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { HELP_URL, decideTake } from './claim.mjs';
import {
    BOT_LABELS,
    BOT_USER_ID,
    DEFAULTS,
    LIVE_SINCE,
    MARKER_PREFIX,
    PLACEHOLDERS,
    QUERY,
    SECTIONS,
    TEXTS,
    WOULD,
    isOutside,
    isProductPath,
    isTestPath,
    loadTexts,
    main,
    marker,
    mentionsChangelogWord,
    needsChangelogNote,
    allClearText,
    commentText,
    normalize,
    othersText,
    ownComments,
    parseState,
    partialIndexes,
    planFor,
    render,
    stateOf,
    stripHtmlComments,
    titleIsConventional,
} from './pr-intake.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8').replace(/\r\n?/g, '\n');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-10-28T16:00:00Z');
const LAUNCH = Date.parse('2026-10-01T00:00:00Z');
const iso = (t) => new Date(t).toISOString();
const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
const texts = loadTexts();

// ---------------------------------------------------------------- recorded shapes

// Pull request 700 as the sweep's query returned it on 2026-10-28, with the
// author's words replaced. The fake below must build exactly this shape.
const RECORDED_NODE = {
    number: 700,
    createdAt: '2026-10-20T16:30:20Z',
    isDraft: false,
    isCrossRepository: true,
    authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
    baseRefName: 'main',
    title: 'TITLE',
    body: 'BODY',
    author: { __typename: 'User', login: 'someone' },
    labels: { totalCount: 1, nodes: [{ name: 'bug' }] },
    files: { totalCount: 1, nodes: [{ path: 'client/lib/a.ts' }] },
    closingIssuesReferences: {
        totalCount: 1,
        nodes: [
            {
                number: 699,
                state: 'OPEN',
                title: 'TITLE',
                repository: { nameWithOwner: 'jannskiee/floe' },
                labels: { totalCount: 2, nodes: [{ name: 'bug' }, { name: 'good first issue' }] },
                assignees: { totalCount: 1, nodes: [{ login: 'someone' }] },
            },
        ],
    },
    comments: {
        totalCount: 1,
        nodes: [
            {
                databaseId: 6295849761,
                createdAt: '2026-10-20T16:30:29Z',
                body: 'BODY',
                author: { __typename: 'Bot', login: 'vercel', databaseId: 35613825 },
            },
        ],
    },
};

// The claim bot's reply on issue 784, as each API names its author.
const BOT_GRAPHQL = { __typename: 'Bot', login: 'github-actions', databaseId: 41898282 };
const BOT_REST = { login: 'github-actions[bot]', id: 41898282, type: 'Bot' };
const VERCEL_GRAPHQL = { __typename: 'Bot', login: 'vercel', databaseId: 35613825 };

function issueNode({
    number,
    state = 'OPEN',
    title = 'Browser: a small bug',
    repo = 'jannskiee/floe',
    labels = ['bug', 'good first issue'],
    labelsTotal,
    assignees = [],
    assigneesTotal,
}) {
    return {
        number,
        state,
        title,
        repository: { nameWithOwner: repo },
        labels: { totalCount: labelsTotal ?? labels.length, nodes: labels.map((name) => ({ name })) },
        assignees: { totalCount: assigneesTotal ?? assignees.length, nodes: assignees.map((login) => ({ login })) },
    };
}

// A pull request node. The defaults are a quiet one: a returning contributor
// who holds the linked issue, a title in style, and a changelog word.
function pr(number, o = {}) {
    const author = o.author === undefined ? `user${number}` : o.author;
    const issues = (o.issues ?? [{ number: 100 + number, assignees: author ? [author] : [] }]).map(issueNode);
    const labels = o.labels ?? [];
    const files = o.files ?? ['client/lib/x.ts'];
    const comments = o.comments ?? [];
    return {
        number,
        createdAt: o.createdAt ?? iso(T0 - DAY),
        isDraft: o.draft ?? false,
        isCrossRepository: o.fork ?? true,
        authorAssociation: o.association ?? 'CONTRIBUTOR',
        baseRefName: o.base ?? 'main',
        title: o.title ?? 'fix(client): keep the bar visible',
        body: o.body ?? 'Closes #1\n\n## Changelog\n\nnot user-visible',
        author: author === null ? null : { __typename: o.type ?? 'User', login: author },
        labels: { totalCount: o.labelsTotal ?? labels.length, nodes: labels.map((name) => ({ name })) },
        files: { totalCount: o.filesTotal ?? files.length, nodes: files.map((path) => ({ path })) },
        closingIssuesReferences: { totalCount: o.issuesTotal ?? issues.length, nodes: issues },
        comments: { totalCount: o.commentsTotal ?? comments.length, nodes: comments },
    };
}

function comment(id, body, author, at = T0 - HOUR) {
    return { databaseId: id, createdAt: iso(at), body, author };
}

function toRest(c) {
    let user;
    if (c.author?.__typename === 'Bot' && c.author.databaseId === BOT_USER_ID) user = { ...BOT_REST };
    else if (c.author?.__typename === 'Bot') user = { login: `${c.author.login}[bot]`, id: c.author.databaseId, type: 'Bot' };
    else user = { login: c.author?.login ?? 'ghost', id: 1, type: 'User' };
    return { id: c.databaseId, created_at: c.createdAt, body: c.body, user };
}

// ---------------------------------------------------------------- the fake API

function httpError(status, message = 'SENTINEL-ERROR-TEXT') {
    return Object.assign(new Error(message), { status });
}

function fakeCore(summaryError) {
    return {
        logs: [],
        warnings: [],
        groups: [],
        failed: null,
        info(m) {
            this.logs.push(String(m));
        },
        warning(m) {
            this.warnings.push(String(m));
        },
        setFailed(m) {
            this.failed = String(m);
        },
        startGroup(name) {
            this.groups.push(String(name));
        },
        endGroup() {},
        summary: {
            text: '',
            written: false,
            addRaw(t, eol) {
                this.text += t + (eol ? '\n' : '');
                return this;
            },
            async write() {
                if (summaryError) throw summaryError;
                this.written = true;
                return this;
            },
        },
    };
}

function fakeGitHub(setup = {}) {
    const s = {
        prs: (setup.prs ?? []).map((p) => structuredClone(p)),
        commitsBy: new Set((setup.commitsBy ?? []).map((l) => l.toLowerCase())),
        fail: setup.fail ?? {},
        pageSize: setup.pageSize ?? 50,
        created: [],
        updated: [],
        added: [],
        removed: [],
        removeAttempts: [],
        commitCalls: [],
        listCommentCalls: [],
        graphqlCalls: 0,
        sleeps: [],
        nextId: 9000,
    };
    const check = (name, ...args) => {
        const f = s.fail[name];
        if (!f) return;
        const err = typeof f === 'function' ? f(...args) : f;
        if (err) throw err;
    };
    const prOf = (n) => {
        const p = s.prs.find((x) => x.number === n);
        if (!p) throw httpError(404);
        return p;
    };
    // Like the real query: comments(first: 100), with the full totalCount.
    const page = (vars) => {
        const start = vars.cursor ? Number(vars.cursor) : 0;
        const nodes = s.prs.slice(start, start + s.pageSize).map((p) => {
            const c = structuredClone(p);
            c.comments.nodes = c.comments.nodes.slice(0, 100);
            return c;
        });
        const next = start + s.pageSize < s.prs.length;
        return { repository: { pullRequests: { pageInfo: { hasNextPage: next, endCursor: next ? String(start + s.pageSize) : null }, nodes } } };
    };
    const github = {
        graphql: async (query, vars) => {
            s.graphqlCalls += 1;
            assert.equal(query, QUERY);
            check('graphql', s.graphqlCalls, vars);
            const data = page(vars);
            if (setup.partial) {
                // GitHub answers with what it could read and errors for the rest.
                throw Object.assign(new Error('partial'), { name: 'GraphqlResponseError', data, errors: setup.partial });
            }
            return data;
        },
        paginate: async (fn, params) => (await fn(params)).data,
        rest: {
            issues: {
                createComment: async ({ issue_number, body }) => {
                    check('createComment', issue_number);
                    const p = prOf(issue_number);
                    const c = comment(s.nextId++, body, { ...BOT_GRAPHQL }, T0);
                    p.comments.nodes.push(c);
                    p.comments.totalCount += 1;
                    s.created.push({ number: issue_number, id: c.databaseId, body });
                    return { data: { id: c.databaseId } };
                },
                updateComment: async ({ comment_id, body }) => {
                    check('updateComment', comment_id);
                    for (const p of s.prs) {
                        const c = p.comments.nodes.find((x) => x.databaseId === comment_id);
                        if (c) {
                            c.body = body;
                            s.updated.push({ number: p.number, id: comment_id, body });
                            return { data: {} };
                        }
                    }
                    throw httpError(404);
                },
                addLabels: async ({ issue_number, labels }) => {
                    check('addLabels', issue_number);
                    const p = prOf(issue_number);
                    for (const name of labels) if (!p.labels.nodes.some((l) => l.name === name)) p.labels.nodes.push({ name });
                    p.labels.totalCount = p.labels.nodes.length;
                    s.added.push({ number: issue_number, labels: [...labels] });
                    return { data: [] };
                },
                removeLabel: async ({ issue_number, name }) => {
                    s.removeAttempts.push({ number: issue_number, name });
                    check('removeLabel', issue_number, name);
                    const p = prOf(issue_number);
                    const i = p.labels.nodes.findIndex((l) => l.name === name);
                    if (i < 0) throw httpError(404, 'Label does not exist');
                    p.labels.nodes.splice(i, 1);
                    p.labels.totalCount = p.labels.nodes.length;
                    s.removed.push({ number: issue_number, name });
                    return { data: [] };
                },
                listComments: async ({ issue_number }) => {
                    s.listCommentCalls.push(issue_number);
                    check('listComments', issue_number);
                    const extra = setup.restOnly?.[issue_number] ?? [];
                    return { data: [...prOf(issue_number).comments.nodes.map(toRest), ...extra] };
                },
            },
            repos: {
                listCommits: async ({ author }) => {
                    s.commitCalls.push(author);
                    check('listCommits', author);
                    return { data: s.commitsBy.has(author.toLowerCase()) ? [{ sha: 'abc' }] : [] };
                },
            },
        },
    };
    const run = async ({ event = 'schedule', ref = 'refs/heads/main', runNumber = 1, config = {}, now = T0, live = true } = {}) => {
        const core = fakeCore(setup.summaryError);
        const context = { repo: { owner: 'jannskiee', repo: 'floe' }, eventName: event, ref, runNumber, runId: 99 };
        await main({
            github,
            context,
            core,
            config: { liveSince: live ? LAUNCH : null, ...config },
            now,
            sleep: async (ms) => {
                s.sleeps.push(ms);
            },
        });
        return core;
    };
    const writes = () => s.created.length + s.updated.length + s.added.length + s.removed.length;
    const node = (n) => s.prs.find((p) => p.number === n);
    return { s, run, writes, node };
}

// The fixed plan line of each pull request a run logged, by number.
function plans(core) {
    const out = {};
    for (const line of core.logs) {
        const m = /^plan #(\d+) would=(\S+) state=(\S+) notes=(\S+) labels=(\S+)(?: result=(\S+))?$/.exec(line);
        if (m) out[m[1]] = { would: m[2], state: m[3], notes: m[4], labels: m[5], result: m[6] };
    }
    return out;
}

const bodyText = (body) => body.slice(0, body.lastIndexOf(MARKER_PREFIX)).trimEnd();

// ---------------------------------------------------------------- pure rules

test('the sweep ships as a dry run: LIVE_SINCE is set only by the go-live pull request', () => {
    assert.equal(LIVE_SINCE, null);
    assert.equal(DEFAULTS.liveSince, null);
});

test('titleIsConventional accepts the house style and nothing else', () => {
    for (const t of [
        'fix(client): keep the progress bar visible while verifying',
        'docs: clarify the relay cap',
        'feat(cli,engine): add a flag',
        'test(e2e): pin the 2 s wait',
        'fix(desktop)!: drop the old path',
        'chore: `pnpm` lockfile',
    ]) {
        assert.ok(titleIsConventional(t), t);
    }
    for (const t of [
        'Fix the progress bar',
        'fix: Keep the progress bar',
        'fix(Client): keep it',
        'Desktop: Reset all settings? opens with focus on Reset',
        'fix(cli) keep it',
        'fixes(cli): keep it',
        '',
    ]) {
        assert.ok(!titleIsConventional(t), t);
    }
});

test('the changelog words count only outside HTML comments, so the template alone does not', () => {
    const template = read('.github/PULL_REQUEST_TEMPLATE.md');
    assert.ok(template.includes('not user-visible') && template.includes('needs a bullet'));
    assert.equal(mentionsChangelogWord(template), false);
    for (const b of ['not user-visible', 'Not user visible.', 'This needs a bullet', 'needs a changelog bullet']) {
        assert.ok(mentionsChangelogWord(b), b);
    }
    assert.equal(stripHtmlComments('a <!-- b --> c <!-- unclosed'), 'a  c ');
});

test('the changelog note asks only about product code with no bullet and no word', () => {
    const base = normalize(pr(1, { body: 'Closes #1' }));
    assert.equal(needsChangelogNote(base), true);
    assert.equal(needsChangelogNote({ ...base, files: ['client/lib/x.ts', 'docs/changelog.mdx'] }), false);
    assert.equal(needsChangelogNote({ ...base, files: ['docs/guide.mdx'] }), false);
    assert.equal(needsChangelogNote({ ...base, files: ['cli/engine/a_test.go', 'client/lib/a.test.ts', 'client/e2e/x.spec.ts'] }), false);
    assert.equal(needsChangelogNote({ ...base, body: 'Closes #1\n\nneeds a bullet' }), false);
    assert.equal(needsChangelogNote({ ...base, filesComplete: false }), false);
    assert.ok(isProductPath('server/server.js') && isProductPath('desktop/app.go') && !isProductPath('docs/a.mdx'));
    assert.ok(isTestPath('cli/engine/testdata/x') && isTestPath('desktop/frontend/src/a.test.tsx') && !isTestPath('client/lib/x.ts'));
});

test('othersText writes numbers out, never as references', () => {
    assert.equal(othersText([733]), 'pull request 733');
    assert.equal(othersText([752, 733]), 'pull requests 733 and 752');
    assert.equal(othersText([9, 3, 5]), 'pull requests 3, 5 and 9');
});

test('render fills known placeholders and refuses any other or a missing value', () => {
    assert.equal(render('issue {{issue}}: {{others}}', { issue: '7', others: 'pull request 8' }), 'issue 7: pull request 8');
    assert.throws(() => render('{{login}}', { login: 'x' }), /\{\{login\}\}/);
    assert.throws(() => render('{{issue}}', {}), /\{\{issue\}\}/);
});

test('the marker round-trips, any version counts, and a damaged one reads as none', () => {
    const state = stateOf('some text');
    assert.match(state, /^[0-9a-f]{12}$/);
    assert.equal(parseState(`x\n\n${marker(state)}`), state);
    assert.equal(parseState(`<!-- floe-pr-intake v=2 state=${state} -->`), state);
    assert.equal(parseState('<!-- floe-pr-intake v=1 -->'), null);
    assert.equal(parseState('nothing'), null);
});

test('only the github-actions bot, told by its id in either API, owns a marked comment', () => {
    const m = `${MARKER_PREFIX} v=1 state=000000000000 -->`;
    const node = pr(1, {
        comments: [
            comment(5, m, { ...BOT_GRAPHQL }, T0 - 2 * HOUR),
            comment(6, m, { ...VERCEL_GRAPHQL }),
            comment(7, m, { __typename: 'User', login: 'github-actions' }),
            comment(8, 'no marker', { ...BOT_GRAPHQL }),
            comment(4, m, { ...BOT_GRAPHQL }, T0 - 3 * HOUR),
        ],
    });
    assert.deepEqual(
        ownComments(normalize(node).comments).map((c) => c.id),
        [4, 5]
    );
    const rest = node.comments.nodes.map(toRest);
    assert.deepEqual(rest[0].user, BOT_REST);
});

test('partialIndexes accepts errors inside closing references only', () => {
    const data = { repository: { pullRequests: { nodes: [] } } };
    const at = (i) => ({ path: ['repository', 'pullRequests', 'nodes', i, 'closingIssuesReferences', 'nodes', 0] });
    assert.deepEqual([...partialIndexes({ data, errors: [at(1), at(3)] })], [1, 3]);
    assert.equal(partialIndexes({ data, errors: [{ path: ['repository', 'pullRequests', 'nodes', 1, 'author'] }] }), null);
    assert.equal(partialIndexes({ data, errors: [{ message: 'no path' }] }), null);
    assert.equal(partialIndexes({ errors: [at(1)] }), null);
    assert.equal(partialIndexes({ data, errors: [] }), null);
});

test('who is from outside', () => {
    const cfg = { ...DEFAULTS };
    const who = (o) => isOutside(normalize(pr(1, o)), cfg);
    for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE']) assert.ok(who({ association }), association);
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) assert.ok(!who({ association }), association);
    assert.ok(!who({ author: 'JannSkiee', association: 'CONTRIBUTOR' }), 'the maintainer, any letter case');
    assert.ok(!who({ type: 'Bot', author: 'dependabot' }), 'a bot');
    assert.ok(!who({ author: null }), 'a deleted account');
    assert.ok(!who({ author: 'ghost' }), 'the ghost placeholder');
});

// ---------------------------------------------------------------- whole runs

// The open pull requests of 2026-10-28 15:53Z as facts (logins and words
// replaced): who holds which issue, its labels, the author's association.
const TODAY = [
    pr(700, { association: 'FIRST_TIME_CONTRIBUTOR', createdAt: '2026-10-20T16:30:20Z', issues: [{ number: 699, assignees: ['user700'] }] }),
    pr(731, {
        author: 'user731',
        createdAt: '2026-10-24T13:11:00Z',
        issues: [{ number: 727, labels: ['enhancement', 'good first issue'] }],
    }),
    pr(732, { author: 'user731', createdAt: '2026-10-24T13:38:00Z', issues: [{ number: 726 }] }),
    pr(733, { author: 'user731', createdAt: '2026-10-24T13:47:00Z', issues: [{ number: 729 }] }),
    pr(752, { association: 'FIRST_TIME_CONTRIBUTOR', createdAt: '2026-10-24T17:05:00Z', issues: [{ number: 729 }] }),
    pr(761, { createdAt: '2026-10-24T22:28:00Z', issues: [{ number: 738, assignees: ['user761'] }] }),
    pr(780, {
        createdAt: '2026-10-26T22:44:00Z',
        issues: [{ number: 687, labels: ['enhancement', 'help wanted'], assignees: ['user780'] }],
    }),
    pr(798, {
        association: 'FIRST_TIME_CONTRIBUTOR',
        createdAt: '2026-10-28T13:44:00Z',
        issues: [{ number: 793, labels: ['documentation', 'enhancement', 'help wanted'], assignees: ['user798'] }],
    }),
    pr(803, { author: 'jannskiee', association: 'OWNER', fork: false, createdAt: '2026-10-28T15:53:00Z', issues: [] }),
];

test("today's open pull requests give the hand-checked plan, and a preview writes nothing", async () => {
    const f = fakeGitHub({ prs: TODAY });
    const core = await f.run({ live: false });
    assert.equal(f.writes(), 0);
    assert.equal(core.failed, null);
    const p = plans(core);
    const got = Object.fromEntries(Object.entries(p).map(([n, v]) => [n, `${v.would} ${v.notes} ${v.labels}`]));
    assert.deepEqual(got, {
        700: 'create first-pr none',
        731: 'create claim-returner +unclaimed',
        732: 'create claim-returner +unclaimed',
        733: 'create competing +unclaimed,+competing-pr',
        752: 'create competing,first-pr +unclaimed,+competing-pr',
        761: 'none none none',
        780: 'none none none',
        798: 'create first-pr none',
    });
    assert.deepEqual(f.s.commitCalls, [], 'returners are known by association here');
    assert.match(core.summary.text, /LIVE_SINCE is not set, so this run wrote nothing/);
    assert.match(core.summary.text, /Open pull requests read: 9\. From outside: 8\./);
    assert.match(core.summary.text, /Issue 729 has more than one open pull request: this one and pull request 752\./);
    assert.match(core.summary.text, /Issue 729 has more than one open pull request: this one and pull request 733\./);
    assert.ok(core.groups.includes('planned comment for pull request 752'));
    assert.ok(!core.groups.includes('planned comment for pull request 761'));
});

test('while LIVE_SINCE is null, no event writes', async () => {
    for (const event of ['schedule', 'push', 'workflow_dispatch']) {
        const f = fakeGitHub({ prs: TODAY });
        const core = await f.run({ event, live: false });
        assert.equal(f.writes(), 0, event);
        assert.match(core.logs[0], /^mode: preview \(event \w+, LIVE_SINCE not set\)$/);
    }
});

test('once live, a dispatch still only previews, and so does any ref but main', async () => {
    const f = fakeGitHub({ prs: TODAY });
    const core = await f.run({ event: 'workflow_dispatch' });
    assert.equal(f.writes(), 0);
    assert.match(core.summary.text, /A manual run only previews/);
    await f.run({ event: 'push', ref: 'refs/heads/feature' });
    await f.run({ event: 'schedule', ref: 'refs/heads/other' });
    assert.equal(f.writes(), 0);
});

const FREE = (n, o = {}) =>
    pr(n, { association: 'FIRST_TIME_CONTRIBUTOR', issues: [{ number: 500 + n, assignees: [] }], ...o });

test('a live run posts one comment with the marker and the label, and the next run writes nothing', async () => {
    const f = fakeGitHub({ prs: [FREE(10)] });
    const core = await f.run();
    assert.equal(core.failed, null);
    assert.equal(f.s.created.length, 1);
    const body = f.s.created[0].body;
    const text = bodyText(body);
    assert.equal(parseState(body), stateOf(text));
    assert.ok(text.startsWith(texts.intro));
    assert.match(text, /Issue 510 isn't assigned to anyone yet\. Start a new comment on issue 510 with `\/take`/);
    assert.match(text, /Your first pull request here\./);
    assert.deepEqual(f.s.added, [{ number: 10, labels: ['unclaimed'] }]);
    assert.deepEqual(f.s.sleeps, [DEFAULTS.writeGapMs], 'a pause between the two writes');
    assert.deepEqual(f.s.commitCalls, ['user10']);
    assert.equal(plans(core)[10].result, 'done');

    const again = await f.run({ runNumber: 2 });
    assert.equal(f.writes(), 2, 'no write on the second run');
    assert.equal(plans(again)[10].would, 'none');
});

const filler = (n, from = 1) =>
    Array.from({ length: n }, (_, i) => comment(from + i, 'a review note', { __typename: 'User', login: 'reviewer' }, T0 - 2 * DAY + i));

test('past 100 comments the bot comment is found over REST, and only its own counts there too', async () => {
    const f = fakeGitHub({ prs: [FREE(11, { comments: filler(120) })] });
    await f.run();
    assert.equal(f.s.created.length, 1, 'no comment of its own among 120');
    const core = await f.run({ runNumber: 2 });
    assert.deepEqual(f.s.listCommentCalls, [11, 11]);
    assert.equal(f.writes(), 2, 'the comment past the first 100 was found over REST');
    assert.equal(plans(core)[11].would, 'none');

    // A marker in a REST-only comment by a person or by another bot is not the bot's.
    const forged = `${MARKER_PREFIX} v=1 state=000000000000 -->`;
    const g = fakeGitHub({
        prs: [FREE(12, { comments: filler(120) })],
        restOnly: {
            12: [
                { id: 1, created_at: iso(T0 - DAY), body: forged, user: { login: 'someone', id: 5, type: 'User' } },
                { id: 2, created_at: iso(T0 - DAY), body: forged, user: { login: 'vercel[bot]', id: 35613825, type: 'Bot' } },
            ],
        },
    });
    await g.run();
    assert.equal(g.s.created.length, 1);
    assert.equal(g.s.updated.length, 0);

    // Comments that cannot be read leave the pull request alone for the run.
    const h = fakeGitHub({ prs: [FREE(13, { comments: filler(120) })], fail: { listComments: httpError(502) } });
    const unread = await h.run();
    assert.equal(plans(unread)[13].would, 'comments-unread');
    assert.equal(h.writes(), 0);
    assert.equal(unread.failed, null);
});

test('a change of facts edits the one comment and moves the labels, down to all-clear', async () => {
    const f = fakeGitHub({ prs: [pr(12, { issues: [{ number: 512, assignees: [] }] })] });
    await f.run();
    assert.match(bodyText(f.s.created[0].body), /This is a good first issue\./);
    assert.deepEqual(f.s.added, [{ number: 12, labels: ['unclaimed'] }]);

    f.node(12).closingIssuesReferences.nodes[0].assignees = { totalCount: 1, nodes: [{ login: 'user12' }] };
    const core = await f.run({ runNumber: 2 });
    assert.equal(f.s.created.length, 1, 'never a second comment');
    assert.equal(f.s.updated.length, 1);
    assert.equal(bodyText(f.s.updated[0].body), `${texts.intro}\n\n${texts['all-clear']}`);
    assert.deepEqual(f.s.removed, [{ number: 12, name: 'unclaimed' }]);
    assert.equal(plans(core)[12].would, 'edit');

    await f.run({ runNumber: 3 });
    assert.equal(f.writes(), 4, 'all-clear stays put');
});

test('an owner edit that keeps the marker is left alone, and a damaged marker is repaired in place', async () => {
    const f = fakeGitHub({ prs: [FREE(13)] });
    await f.run();
    const c = f.node(13).comments.nodes.at(-1);
    const markerLine = c.body.slice(c.body.lastIndexOf(MARKER_PREFIX));
    c.body = `Edited by the maintainer.\n\n${markerLine}`;
    await f.run({ runNumber: 2 });
    assert.equal(f.s.updated.length, 0);

    c.body = c.body.replace('v=1', 'v=2');
    await f.run({ runNumber: 3 });
    assert.equal(f.s.updated.length, 0, 'a later marker version is the same comment');

    c.body = `Edited.\n\n${MARKER_PREFIX} v=1 state=garbled -->`;
    await f.run({ runNumber: 4 });
    assert.equal(f.s.updated.length, 1, 'rewritten in place');
    assert.equal(f.s.created.length, 1);

    // With no marker left the comment is the owner's, and the bot posts its
    // own (CLAUDE.md: keep the last line to keep an edit; no-intake to stop).
    c.body = 'Taken over by the maintainer.';
    await f.run({ runNumber: 5 });
    assert.equal(f.s.created.length, 2);
});

test('the labels are the bot\'s: one removed by hand comes back, a 404 on removal passes, other labels stay', async () => {
    const f = fakeGitHub({ prs: [FREE(14)] });
    await f.run();
    f.node(14).labels = { totalCount: 0, nodes: [] };
    await f.run({ runNumber: 2 });
    assert.deepEqual(f.s.added.at(-1), { number: 14, labels: ['unclaimed'] });
    assert.equal(f.s.updated.length, 0, 'the comment did not change');

    const g = fakeGitHub({
        prs: [pr(15, { labels: ['bug', 'good first issue', 'documentation', 'unclaimed', 'claim-conflict'] })],
        fail: { removeLabel: (n, name) => (name === 'claim-conflict' ? httpError(404) : null) },
    });
    const core = await g.run();
    assert.equal(core.failed, null);
    assert.deepEqual(g.s.removed, [{ number: 15, name: 'unclaimed' }]);
    assert.deepEqual(g.node(15).labels.nodes.map((l) => l.name), ['bug', 'good first issue', 'documentation', 'claim-conflict']);
    assert.equal(plans(core)[15].result, 'done', 'the 404 was taken as done');
    assert.deepEqual(
        g.s.removeAttempts.filter((r) => r.number === 15).map((r) => r.name),
        ['unclaimed', 'claim-conflict'],
        'the removal that got the 404 was attempted'
    );

    const h = fakeGitHub({ prs: [pr(16, { labels: ['claim-conflict', 'competing-pr', 'help wanted'] })] });
    await h.run();
    assert.deepEqual(h.s.removed, [
        { number: 16, name: 'claim-conflict' },
        { number: 16, name: 'competing-pr' },
    ]);

    const k = fakeGitHub({ prs: [pr(17, { labels: ['competing-pr'] })], fail: { removeLabel: httpError(500) } });
    const bad = await k.run();
    assert.equal(bad.failed, '1 pull request(s) had a write that failed');
    assert.equal(plans(bad)[17].result, 'failed-500');
});

test('the no-intake label turns the sweep off for that pull request', async () => {
    const f = fakeGitHub({ prs: [FREE(16, { labels: ['no-intake', 'unclaimed'] })] });
    const core = await f.run();
    assert.equal(f.writes(), 0);
    assert.equal(plans(core)[16].would, 'opted-out');
});

test('with two bot comments the oldest is written, nothing is posted, and it is reported', async () => {
    const stale = `old\n\n${MARKER_PREFIX} v=1 state=000000000000 -->`;
    const f = fakeGitHub({
        prs: [FREE(17, { comments: [comment(6, stale, { ...BOT_GRAPHQL }, T0 - HOUR), comment(5, stale, { ...BOT_GRAPHQL }, T0 - 2 * HOUR)] })],
    });
    const core = await f.run();
    assert.equal(f.s.created.length, 0);
    assert.deepEqual(f.s.updated.map((u) => u.id), [5]);
    assert.match(core.warnings.join('\n'), /pull request 17: 1 extra intake comment/);
});

test('markers by anyone but the bot are ignored, wherever they are', async () => {
    const forged = `${MARKER_PREFIX} v=1 state=000000000000 -->`;
    const f = fakeGitHub({
        prs: [
            FREE(18, {
                body: `Closes #1 not user-visible ${forged}`,
                comments: [
                    comment(1, forged, { __typename: 'User', login: 'someone' }),
                    comment(2, forged, { ...VERCEL_GRAPHQL }),
                    comment(3, forged, { __typename: 'User', login: 'github-actions' }),
                ],
            }),
        ],
    });
    await f.run();
    assert.equal(f.s.created.length, 1);
    assert.equal(f.s.updated.length, 0);
});

test('pull requests on one unassigned issue all get the competing note, owner, bot and ghost ones counted', async () => {
    const issues = [{ number: 50, assignees: [] }];
    const f = fakeGitHub({
        prs: [
            pr(900, { association: 'FIRST_TIME_CONTRIBUTOR', issues }),
            pr(901, { author: 'jannskiee', association: 'OWNER', issues }),
            pr(902, { author: 'dependabot', type: 'Bot', issues }),
            pr(903, { author: null, issues }),
            pr(904, { issues, draft: true }),
        ],
    });
    const core = await f.run();
    const p = plans(core);
    assert.deepEqual(Object.keys(p), ['900', '904']);
    assert.equal(p[900].notes, 'competing,first-pr');
    assert.equal(p[904].notes, 'competing');
    const text900 = bodyText(f.s.created.find((c) => c.number === 900).body);
    assert.match(text900, /this one and pull requests 901, 902, 903 and 904\./);
    assert.deepEqual(f.s.added.find((a) => a.number === 900).labels, ['unclaimed', 'competing-pr']);
    assert.deepEqual(f.s.commitCalls, [], 'no /take advice while another pull request targets the issue');
});

test('an issue assigned to someone else, the owner included, gets the conflict note; its holder gets none', async () => {
    const f = fakeGitHub({
        prs: [
            pr(910, { issues: [{ number: 60, assignees: ['jannskiee'] }] }),
            pr(911, { issues: [{ number: 61, assignees: ['user911'] }] }),
            pr(912, { issues: [{ number: 61, assignees: ['user911'] }] }),
        ],
    });
    const core = await f.run();
    const p = plans(core);
    assert.equal(p[910].notes, 'claim-other');
    assert.equal(p[910].labels, '+claim-conflict');
    assert.equal(p[911].notes, 'none');
    assert.equal(p[912].notes, 'claim-other');
    assert.match(bodyText(f.s.created.find((c) => c.number === 912).body), /Issue 61 is assigned to someone else/);
});

test('a closed linked issue gets no claim note, and a link only into another repository is no link', async () => {
    const f = fakeGitHub({
        prs: [
            pr(920, { issues: [{ number: 70, state: 'CLOSED', assignees: [] }] }),
            pr(921, { issues: [{ number: 71, repo: 'someone/else', assignees: [] }] }),
            pr(922, { issues: [] }),
            pr(923, { issues: [{ number: 72, assignees: [] }, { number: 73, state: 'CLOSED', assignees: [] }] }),
            pr(924, { association: 'FIRST_TIME_CONTRIBUTOR', issues: [{ number: 74, state: 'CLOSED', assignees: [] }] }),
            pr(925, { issues: [{ number: 75, repo: 'someone/else', state: 'CLOSED', assignees: [] }] }),
        ],
    });
    const p = plans(await f.run());
    // Nothing of the bot's is on these yet, so there is nothing to keep: the
    // closed issue is left out and the rest is planned.
    assert.equal(p[920].would, 'none');
    assert.equal(p[921].notes, 'no-issue');
    assert.equal(p[922].notes, 'no-issue');
    assert.equal(p[923].notes, 'claim-returner', 'the open issue it also links');
    assert.equal(p[924].notes, 'first-pr', 'a first-timer still gets the CI note');
    assert.equal(p[925].notes, 'no-issue', 'a closed issue in another repository is no link either');
    assert.deepEqual(f.s.created.map((c) => c.number).sort(), [921, 922, 923, 924, 925]);

    // Only a closed issue in this repository keeps a pull request's comment as it is.
    const stale = `old\n\n${MARKER_PREFIX} v=1 state=000000000000 -->`;
    const g = fakeGitHub({
        prs: [pr(926, { issues: [{ number: 76, repo: 'someone/else', state: 'CLOSED', assignees: [] }], comments: [comment(5, stale, { ...BOT_GRAPHQL })] })],
    });
    const q = plans(await g.run());
    assert.equal(q[926].would, 'edit');
    assert.equal(q[926].notes, 'no-issue');
});

test('when the issue closes, the pull request keeps its notes and labels for the owner to close it by', async () => {
    // The competing pair: 752 is merged, which closes issue 729.
    const issues = [{ number: 729, assignees: [] }];
    const f = fakeGitHub({ prs: [pr(733, { issues }), pr(752, { association: 'FIRST_TIME_CONTRIBUTOR', issues })] });
    await f.run();
    const before = { created: f.s.created.length, labels: f.node(733).labels.nodes.map((l) => l.name) };
    assert.deepEqual(before.labels, ['unclaimed', 'competing-pr']);
    f.s.prs = f.s.prs.filter((p) => p.number !== 752);
    f.node(733).closingIssuesReferences.nodes[0].state = 'CLOSED';
    const core = await f.run({ runNumber: 2 });
    assert.equal(plans(core)[733].would, 'issue-closed');
    assert.equal(f.s.updated.length, 0, 'not rewritten to all clear');
    assert.equal(f.s.removed.length, 0, 'its labels stay');

    // The holder's pull request is merged: the other one keeps its conflict note.
    const held = [{ number: 61, assignees: ['user911'] }];
    const g = fakeGitHub({ prs: [pr(911, { issues: held }), pr(912, { issues: held })] });
    await g.run();
    assert.deepEqual(g.node(912).labels.nodes.map((l) => l.name), ['claim-conflict']);
    g.s.prs = g.s.prs.filter((p) => p.number !== 911);
    g.node(912).closingIssuesReferences.nodes[0].state = 'CLOSED';
    await g.run({ runNumber: 2 });
    assert.equal(g.s.updated.length + g.s.removed.length, 0);

    // The bot's labels alone (its comment deleted by hand) are kept the same way.
    const h = fakeGitHub({ prs: [pr(913, { labels: ['competing-pr', 'unclaimed'], issues: [{ number: 62, state: 'CLOSED', assignees: [] }] })] });
    const core2 = await h.run();
    assert.equal(plans(core2)[913].would, 'issue-closed');
    assert.equal(h.writes(), 0);
});

test('when a competing pull request closes and the issue stays open, the notes and labels move on', async () => {
    const issues = [{ number: 729, assignees: [] }];
    const f = fakeGitHub({ prs: [pr(752, { association: 'FIRST_TIME_CONTRIBUTOR', issues }), pr(760, { issues })] });
    await f.run();
    assert.deepEqual(f.node(752).labels.nodes.map((l) => l.name), ['unclaimed', 'competing-pr']);
    f.s.prs = f.s.prs.filter((p) => p.number !== 760);
    const core = await f.run({ runNumber: 2 });
    assert.equal(plans(core)[752].notes, 'claim-take,first-pr');
    assert.match(bodyText(f.s.updated.at(-1).body), /Start a new comment on issue 729 with `\/take`/);
    assert.deepEqual(f.s.removed, [{ number: 752, name: 'competing-pr' }]);
    assert.deepEqual(f.node(752).labels.nodes.map((l) => l.name), ['unclaimed']);
});

test('the claim note follows the claim bot: /take only for a newcomer on a free good first issue', async () => {
    const f = fakeGitHub({
        prs: [
            pr(930, { association: 'CONTRIBUTOR', issues: [{ number: 80, assignees: [] }] }),
            pr(931, { association: 'NONE', issues: [{ number: 81, assignees: [] }] }),
            pr(932, { author: 'fresh', association: 'NONE', issues: [{ number: 82, assignees: [] }] }),
            pr(933, { author: 'fresh', association: 'NONE', issues: [{ number: 83, assignees: [] }] }),
            pr(934, { association: 'FIRST_TIME_CONTRIBUTOR', issues: [{ number: 84, labels: ['help wanted'], assignees: [] }] }),
        ],
        commitsBy: ['user931'],
    });
    const p = plans(await f.run());
    assert.equal(p[930].notes, 'claim-returner', 'a returner by association');
    assert.equal(p[931].notes, 'claim-returner', 'a returner by commit history, though NONE');
    assert.equal(p[932].notes, 'claim-take');
    assert.equal(p[933].notes, 'claim-take');
    assert.equal(p[934].notes, 'claim-ask,first-pr', 'help wanted is assigned by hand');
    assert.deepEqual(f.s.commitCalls, ['user931', 'fresh'], 'asked once per login, never for a returner by association');
    const returner = bodyText(f.s.created.find((c) => c.number === 930).body);
    assert.ok(returner.includes(`[help wanted](${HELP_URL})`), 'the same help wanted search the claim bot links');

    // An unread history is not guessed: the pull request waits for a run that reads it.
    const g = fakeGitHub({ prs: [pr(935, { association: 'NONE', issues: [{ number: 85, assignees: [] }] })], fail: { listCommits: httpError(502) } });
    const core = await g.run();
    assert.equal(plans(core)[935].would, 'commits-unread');
    assert.equal(g.writes(), 0);
    assert.equal(core.failed, null);
    assert.match(core.warnings.join('\n'), /pull request 935: its author's commit history could not be read \(502\)/);
});

// What /take would answer, from what the sweep knows. It cannot see the two
// rules that need more reads (released by the maintainer, holds another good
// first issue), so those are false here; the /take note says the bot may
// still refuse.
test('the claim note says what the claim bot itself would answer', async () => {
    const cases = [];
    for (const gfi of [true, false])
        for (const association of ['FIRST_TIME_CONTRIBUTOR', 'NONE', 'CONTRIBUTOR'])
            for (const commits of [false, true])
                for (const sibling of [false, true]) cases.push({ gfi, association, commits, sibling });
    for (const c of cases) {
        const issue = { number: 1, open: true, title: 't', repo: 'jannskiee/floe', labels: c.gfi ? ['good first issue'] : ['help wanted'], assignees: [], complete: true };
        const pull = { number: 10, author: { type: 'User', login: 'someone' }, association: c.association, isDraft: true, issues: [issue] };
        const plan = await planFor(pull, {
            siblings: new Map([[1, c.sibling ? [10, 11] : [10]]]),
            repoName: 'jannskiee/floe',
            cfg: DEFAULTS,
            isReturner: async (p) => ['CONTRIBUTOR', 'COLLABORATOR', 'MEMBER'].includes(p.association) || c.commits,
        });
        const verdict = await decideTake({
            isAssignee: false,
            hasAssignee: false,
            isGoodFirstIssue: c.gfi,
            isHelpWanted: !c.gfi,
            returnerByAssociation: ['CONTRIBUTOR', 'COLLABORATOR', 'MEMBER'].includes(c.association),
            hasCommits: async () => c.commits,
            releasedByMaintainer: async () => false,
            otherOpenPullRequest: async () => c.sibling,
            holdsAnotherGoodFirstIssue: async () => false,
        });
        const expected = {
            assign: 'claim-take',
            returner: 'claim-returner',
            'has-pr': 'competing',
            'not-claimable-help': 'claim-ask',
            'not-claimable': 'claim-ask',
        }[verdict];
        // With another pull request on the issue the note is about that, and
        // /take is never offered: the claim bot would not assign either (it
        // answers has-pr, or an earlier refusal).
        const got = plan.sections.map((s) => s.id).join(',');
        if (c.sibling) {
            assert.equal(got, 'competing', JSON.stringify(c));
            assert.notEqual(verdict, 'assign', JSON.stringify(c));
        } else {
            assert.equal(got, expected, `${JSON.stringify(c)} -> ${verdict}`);
        }
    }
});

test('a draft gets only the notes that keep two people off the same work', async () => {
    const f = fakeGitHub({
        prs: [FREE(940, { draft: true, title: 'WIP', body: 'Closes #1', files: ['client/lib/x.ts'] })],
    });
    assert.equal(plans(await f.run())[940].notes, 'claim-take');
});

test('the first-pull-request note is for a first-timer\'s fork only', async () => {
    const quiet = (n, association, fork = true) => pr(n, { association, fork });
    const f = fakeGitHub({
        prs: [
            quiet(950, 'FIRST_TIME_CONTRIBUTOR'),
            quiet(951, 'FIRST_TIMER'),
            quiet(952, 'CONTRIBUTOR'),
            quiet(953, 'NONE'),
            quiet(954, 'FIRST_TIME_CONTRIBUTOR', false),
        ],
    });
    const p = plans(await f.run());
    assert.deepEqual(
        [950, 951, 952, 953, 954].map((n) => p[n].notes),
        ['first-pr', 'first-pr', 'none', 'none', 'none']
    );
});

test('a title out of style, or the issue\'s own title, gets the title note; the changelog note follows its rule', async () => {
    const f = fakeGitHub({
        prs: [
            pr(960, { title: 'Fixed the bug' }),
            pr(961, { title: 'fix(desktop): keep focus', issues: [{ number: 90, title: 'fix(desktop): keep focus', assignees: ['user961'] }] }),
            pr(962, { body: 'Closes #1' }),
            pr(963, { body: 'Closes #1 <!-- not user-visible -->' }),
            pr(964, { body: 'Closes #1', filesTotal: 150 }),
        ],
    });
    const p = plans(await f.run());
    assert.equal(p[960].notes, 'title');
    assert.equal(p[961].notes, 'title');
    assert.equal(p[962].notes, 'changelog');
    assert.equal(p[963].notes, 'changelog');
    assert.equal(p[964].notes, 'none', 'over 100 files: the list is not complete');
});

test('pull requests opened before LIVE_SINCE, or under 10 minutes ago, are left alone', async () => {
    const f = fakeGitHub({
        prs: [
            FREE(970, { createdAt: iso(LAUNCH - 1) }),
            FREE(971, { createdAt: iso(LAUNCH) }),
            FREE(972, { createdAt: iso(T0 - 5 * MIN) }),
            FREE(973, { createdAt: iso(T0 - 11 * MIN) }),
        ],
    });
    const p = plans(await f.run());
    assert.equal(p[970].would, 'before-launch');
    assert.equal(p[971].would, 'create');
    assert.equal(p[972].would, 'too-new');
    assert.equal(p[973].would, 'create');
    assert.deepEqual(f.s.created.map((c) => c.number).sort(), [971, 973]);
});

test('the write budget never leaves a pull request half-written, and the start rotates', async () => {
    const prs = Array.from({ length: 12 }, (_, i) => FREE(1000 + i));
    const f = fakeGitHub({ prs });
    const core = await f.run({ runNumber: 3 });
    assert.deepEqual(f.s.created.map((c) => c.number), [1003, 1004, 1005, 1006, 1007]);
    assert.deepEqual(f.s.added.map((a) => a.number), [1003, 1004, 1005, 1006, 1007]);
    assert.equal(f.s.sleeps.length, 9);
    assert.ok(f.s.sleeps.every((ms) => ms === DEFAULTS.writeGapMs));
    const p = plans(core);
    assert.equal(p[1008].result, 'deferred');
    assert.equal(p[1002].result, 'deferred');

    await f.run({ runNumber: 4 });
    assert.equal(new Set(f.s.created.map((c) => c.number)).size, 10, 'the next run takes the rest');
});

test('the write budget is never overspent, and a pull request that does not fit is not touched', async () => {
    // Writes each: 4 (post, +unclaimed, two stale labels), 2, 3, 2, 4. With
    // 10 a run and no rotation: 4 + 2 + 3 = 9, and neither of the rest fits.
    const prs = [
        FREE(1050, { labels: ['claim-conflict', 'competing-pr'] }),
        FREE(1051),
        FREE(1052, { labels: ['claim-conflict'] }),
        FREE(1053),
        FREE(1054, { labels: ['claim-conflict', 'competing-pr'] }),
    ];
    const f = fakeGitHub({ prs });
    const core = await f.run({ runNumber: 0 });
    assert.ok(f.writes() <= DEFAULTS.maxWrites, `${f.writes()} writes`);
    assert.equal(f.writes(), 9);
    for (const n of [1050, 1051, 1052]) {
        assert.equal(plans(core)[n].result, 'done', String(n));
        assert.deepEqual(f.node(n).labels.nodes.map((l) => l.name), ['unclaimed'], `${n} has every label change`);
        assert.equal(f.s.created.filter((c) => c.number === n).length, 1);
    }
    for (const n of [1053, 1054]) {
        assert.equal(plans(core)[n].result, 'deferred', String(n));
        assert.equal(f.s.created.filter((c) => c.number === n).length, 0, `${n} has no comment`);
        assert.ok(!f.s.added.some((a) => a.number === n) && !f.s.removed.some((r) => r.number === n), `${n} has no label change`);
    }
    // The live summary is the owner's record of what a run wrote.
    const summary = core.summary.text;
    assert.match(summary, /^## PR intake: live run$/m);
    assert.match(summary, /^This run wrote to GitHub what the table says\.$/m);
    assert.match(summary, /^\| Pull request \| A live run would \| Notes \| Labels \| Result \|$/m);
    assert.match(summary, /^\| --- \| --- \| --- \| --- \| --- \|$/m);
    assert.match(summary, /^\| 1050 \| post the comment \| claim-take, first-pr \| \+unclaimed, -claim-conflict, -competing-pr \| done \|$/m);
    assert.match(summary, /^\| 1054 \| post the comment \| .* \| deferred \|$/m);
});

test('a LIVE_SINCE that is not a number of milliseconds stops the run before it reads anything', async () => {
    for (const liveSince of ['2026-11-05T00:00:00Z', NaN, Infinity, new Date(LAUNCH)]) {
        const f = fakeGitHub({ prs: [FREE(1060, { createdAt: iso(LAUNCH - DAY) })] });
        const core = await f.run({ config: { liveSince } });
        assert.match(core.failed ?? '', /^LIVE_SINCE must be null or a time in milliseconds/, String(liveSince));
        assert.equal(f.s.graphqlCalls, 0);
        assert.equal(f.writes(), 0);
    }
});

test('the intro and the all-clear note go through render, so a placeholder there cannot reach a comment', () => {
    assert.equal(commentText([{ id: 'title' }], texts).split('\n\n')[0], texts.intro);
    assert.throws(() => commentText([{ id: 'title' }], { ...texts, intro: 'Hi {{issue}}' }), /\{\{issue\}\}/);
    assert.throws(() => allClearText({ ...texts, 'all-clear': '- **All set.** {{others}}' }), /\{\{others\}\}/);
});

test('a failed write fails the run at the end, after the others, and says only its status', async () => {
    const f = fakeGitHub({ prs: [FREE(1100), FREE(1101), FREE(1102)], fail: { createComment: (n) => (n === 1101 ? httpError(500) : null) } });
    const core = await f.run();
    assert.deepEqual(f.s.created.map((c) => c.number).sort(), [1100, 1102]);
    assert.equal(core.failed, '1 pull request(s) had a write that failed');
    assert.equal(plans(core)[1101].result, 'failed-500');
    assert.ok(!JSON.stringify(core).includes('SENTINEL-ERROR-TEXT'));
});

test('a read that fails twice writes nothing and fails the run; one retry is enough', async () => {
    const f = fakeGitHub({ prs: [FREE(1200)], fail: { graphql: httpError(502) } });
    const core = await f.run();
    assert.equal(f.writes(), 0);
    assert.equal(core.failed, 'could not read the open pull requests (502); nothing was written');
    assert.equal(f.s.graphqlCalls, 2);
    assert.deepEqual(f.s.sleeps, [DEFAULTS.retryDelayMs]);

    const g = fakeGitHub({ prs: [FREE(1201)], fail: { graphql: (n) => (n === 1 ? httpError(502) : null) } });
    const ok = await g.run();
    assert.equal(ok.failed, null);
    assert.equal(g.s.created.length, 1);

    // A refusal (a rate limit included) waits for the next scheduled run.
    const h = fakeGitHub({ prs: [FREE(1202)], fail: { graphql: httpError(403) } });
    const refused = await h.run();
    assert.equal(h.s.graphqlCalls, 1);
    assert.equal(refused.failed, 'could not read the open pull requests (403); nothing was written');
});

test('a partial GraphQL answer skips only the pull requests it names', async () => {
    const at = (i) => ({ path: ['repository', 'pullRequests', 'nodes', i, 'closingIssuesReferences', 'nodes', 0] });
    const f = fakeGitHub({ prs: [FREE(1300), FREE(1301)], partial: [at(1)] });
    const core = await f.run();
    assert.equal(plans(core)[1301].would, 'incomplete');
    assert.deepEqual(f.s.created.map((c) => c.number), [1300]);

    // Any other GraphQL error answer is retried once, then fails closed.
    const g = fakeGitHub({ prs: [FREE(1302)], partial: [{ path: ['repository', 'pullRequests', 'nodes', 0, 'author'] }] });
    const bad = await g.run();
    assert.match(bad.failed, /^could not read the open pull requests \(GraphqlResponseError\)/);
    assert.equal(g.s.graphqlCalls, 2);
    assert.equal(g.writes(), 0);
});

test('a GraphQL rate limit, or an error with no status, is not retried', async () => {
    const limited = Object.assign(new Error('rate limited'), { name: 'GraphqlResponseError', data: null, errors: [{ type: 'RATE_LIMITED' }] });
    const f = fakeGitHub({ prs: [FREE(1303)], fail: { graphql: limited } });
    const core = await f.run();
    assert.equal(f.s.graphqlCalls, 1);
    assert.equal(core.failed, 'could not read the open pull requests (GraphqlResponseError); nothing was written');

    const g = fakeGitHub({ prs: [FREE(1304)], fail: { graphql: new TypeError('a bug') } });
    await g.run();
    assert.equal(g.s.graphqlCalls, 1);
    assert.equal(g.writes(), 0);
});

test('every page is read, and a list longer than the page limit fails closed', async () => {
    const prs = Array.from({ length: 120 }, (_, i) => pr(2000 + i));
    const f = fakeGitHub({ prs });
    const core = await f.run();
    assert.equal(f.s.graphqlCalls, 3);
    assert.match(core.summary.text, /Open pull requests read: 120\./);

    const g = fakeGitHub({ prs });
    const short = await g.run({ config: { maxPages: 2 } });
    assert.equal(short.failed, 'could not read the open pull requests (RangeError); nothing was written');
});

test('labels, closing references or assignees past the page make the pull request wait', async () => {
    const f = fakeGitHub({
        prs: [
            FREE(1400, { labelsTotal: 25 }),
            FREE(1401, { issuesTotal: 11 }),
            pr(1402, { issues: [{ number: 95, assignees: [], assigneesTotal: 11 }] }),
        ],
    });
    const p = plans(await f.run());
    assert.deepEqual([p[1400].would, p[1401].would, p[1402].would], ['incomplete', 'incomplete', 'incomplete']);
    assert.equal(f.writes(), 0);
});

test('a pull request into another branch is not read as one from outside', async () => {
    const f = fakeGitHub({ prs: [FREE(1500, { base: 'release' })] });
    const core = await f.run();
    assert.deepEqual(plans(core), {});
});

test('the plan does not depend on the order things come back in', async () => {
    const make = (order) =>
        [
            pr(1600, { association: 'FIRST_TIME_CONTRIBUTOR', labels: ['bug', 'docs'], issues: [{ number: 98, assignees: [] }, { number: 97, assignees: [] }] }),
            pr(1601, { issues: [{ number: 98, assignees: [] }] }),
            pr(1602, { issues: [{ number: 97, assignees: [] }] }),
        ].map((p) => (order ? { ...p, labels: { ...p.labels, nodes: [...p.labels.nodes].reverse() }, closingIssuesReferences: { ...p.closingIssuesReferences, nodes: [...p.closingIssuesReferences.nodes].reverse() } } : p));
    const a = plans(await fakeGitHub({ prs: make(false) }).run({ live: false }));
    const b = plans(await fakeGitHub({ prs: make(true).reverse() }).run({ live: false }));
    assert.deepEqual(a, b);
});

test("nothing a pull request's author wrote reaches a comment, the summary or the log", async () => {
    const bad = [
        '::error::SENTINEL',
        '@jannskiee',
        '#1 ',
        'https://github.com/jannskiee/floe/issues/1',
        `${MARKER_PREFIX} v=1 state=ffffffffffff -->`,
        '<script>',
        'SENTINEL',
    ];
    const evil = bad.join(' ');
    const evilPrs = [
        pr(1700, {
            author: 'SENTINEL-login',
            association: 'FIRST_TIME_CONTRIBUTOR',
            title: evil,
            body: evil,
            labels: ['::error::SENTINEL-label'],
            files: [`client/${evil}.ts`],
            issues: [{ number: 99, title: evil, labels: ['good first issue', evil], assignees: [] }],
            comments: [comment(1, evil, { __typename: 'User', login: 'SENTINEL-user' })],
        }),
        pr(1701, { author: 'SENTINEL-login2', issues: [{ number: 99, title: evil, assignees: [] }] }),
    ];
    const f = fakeGitHub({ prs: evilPrs });
    const live = await f.run();
    const preview = await fakeGitHub({ prs: evilPrs }).run({ live: false });
    assert.ok(preview.groups.length === 2 && preview.summary.text.includes('<details>'), 'the preview printed both plans');
    const out = [
        ...f.s.created.map((c) => c.body),
        ...f.s.updated.map((c) => c.body),
        ...[live, preview].flatMap((c) => [c.summary.text, ...c.logs, ...c.warnings, ...c.groups, c.failed ?? '']),
    ].join('\n');
    for (const s of ['SENTINEL', '::error', '@jannskiee', '#1 ', 'issues/1', 'ffffffffffff', '<script>']) {
        assert.ok(!out.includes(s), s);
    }
    for (const c of [live, preview]) for (const line of c.logs) assert.ok(!line.startsWith('::'), line);
    assert.equal(f.s.created.length, 2);
});

test('a summary that cannot be written is a warning, not a failure', async () => {
    const f = fakeGitHub({ prs: [FREE(1800)], summaryError: httpError(500) });
    const core = await f.run();
    assert.equal(core.failed, null);
    assert.match(core.warnings.join('\n'), /the job summary was not written \(500\)/);
});

test('every code a row can carry has words in the summary', () => {
    const codes = ['create', 'edit', 'labels', 'none', 'opted-out', 'incomplete', 'issue-closed', 'comments-unread', 'commits-unread', 'before-launch', 'too-new'];
    for (const code of codes) assert.ok(WOULD[code], code);
    assert.deepEqual(Object.keys(WOULD).sort(), [...codes].sort());
});

test('the fake builds pull requests in the shape the query returned, and the query asks for every field', () => {
    const shape = (v) => {
        if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
        if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])]));
        return typeof v;
    };
    const built = pr(700, {
        association: 'FIRST_TIME_CONTRIBUTOR',
        labels: ['bug'],
        issues: [{ number: 699, assignees: ['someone'] }],
        comments: [comment(1, 'BODY', { ...VERCEL_GRAPHQL })],
    });
    assert.deepEqual(shape(built), shape(RECORDED_NODE));
    const keys = new Set();
    const walk = (v) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) keys.add(k), walk(x);
    };
    walk(RECORDED_NODE);
    for (const k of keys) assert.match(QUERY, new RegExp(`\\b${k}\\b`), k);
});

// ---------------------------------------------------------------- the texts

test('every text has one file, and every file is a text', () => {
    assert.deepEqual(Object.keys(texts).sort(), [...TEXTS].sort());
    assert.deepEqual(
        readdirSync(new URL('.github/intake/', ROOT)).sort(),
        TEXTS.map((t) => `${t}.md`).sort()
    );
    assert.deepEqual(SECTIONS, TEXTS.slice(1, -1));
});

// British spellings that have come up in this repository's copy.
const BRITISH = /\b(?:labell|cancell|colour|behaviour|favour|honour|organis|recognis|centre|catalogue|analys|travell|modell|signall|licence)\w*/i;

test('the texts keep the house rules', () => {
    for (const [name, text] of Object.entries(texts)) {
        const outsideCode = text.replace(/`[^`]*`/g, '');
        assert.doesNotMatch(text, DASHES, `${name}: no em or en dash`);
        assert.doesNotMatch(text, /#\d/, `${name}: no #123, which would put an entry on that thread`);
        assert.doesNotMatch(text, /\/(?:issues|pull)\/\d/, `${name}: no link to an issue or a pull request`);
        assert.doesNotMatch(outsideCode, /@[A-Za-z0-9]/, `${name}: no mention, which would ping someone`);
        assert.doesNotMatch(text, BRITISH, `${name}: American English`);
        assert.doesNotMatch(text, /floe-pr-intake/, `${name}: the marker is added by code`);
        assert.doesNotMatch(text, /[^\x20-\x7e\n]/, `${name}: plain ASCII`);
        for (const [, key] of text.matchAll(/\{\{([^}]*)\}\}/g)) assert.ok(PLACEHOLDERS.includes(key), `${name}: {{${key}}}`);
        if (SECTIONS.includes(name) || name === 'all-clear') assert.match(text, /^- \*\*[^*]+\*\* /, `${name}: one bullet`);
        assert.equal(text.split('\n').length, 1, `${name}: one line`);
    }
    assert.doesNotMatch(texts.intro, /^- /);
});

test('every text renders with the values a run supplies, into the shape of the rendered output', () => {
    for (const name of TEXTS) {
        const out = render(texts[name], { issue: '729', others: othersText([733, 752]), help_url: HELP_URL });
        assert.doesNotMatch(out, /\{\{|#\d|\/(?:issues|pull)\/\d/, name);
    }
    assert.ok(commentText([{ id: 'claim-returner', issue: 729 }], texts).includes(`[help wanted](${HELP_URL})`));
});

// GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens.
function anchorsOf(markdown) {
    const anchors = new Set();
    let fenced = false;
    for (const line of markdown.split('\n')) {
        if (/^\s*```/.test(line)) fenced = !fenced;
        if (fenced) continue;
        const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
        if (h) {
            anchors.add(
                h[1]
                    .toLowerCase()
                    .replace(/`/g, '')
                    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
                    .replace(/\s/g, '-')
            );
        }
        for (const [, id] of line.matchAll(/<a id="([^"]+)"><\/a>/g)) anchors.add(id);
    }
    return anchors;
}

test('every link in the texts points at a real CONTRIBUTING.md heading', () => {
    const anchors = anchorsOf(read('CONTRIBUTING.md'));
    let links = 0;
    for (const [name, text] of Object.entries(texts)) {
        for (const [, url] of text.matchAll(/\]\((https?:[^)]+)\)/g)) {
            if (url === 'https://github.com/your-handle') continue;
            links += 1;
            const m = /^https:\/\/github\.com\/jannskiee\/floe\/blob\/main\/CONTRIBUTING\.md#([\w-]+)$/.exec(url);
            assert.ok(m, `${name}: ${url} is a CONTRIBUTING.md anchor`);
            assert.ok(anchors.has(m[1]), `${name}: #${m[1]}`);
        }
    }
    assert.ok(links >= 6);
});

test('the texts and the code agree with the claim bot and the repository', () => {
    const contributing = read('CONTRIBUTING.md');
    assert.match(contributing, /the first one that matches the issue is merged, and the other is closed with thanks/);
    assert.match(contributing, /A pull request for an issue that is assigned to someone else is closed\./);
    assert.match(texts['first-pr'], /Authorization required to deploy\./);
    // Mintlify's fork check appears only on a change to docs/ (read on 22 fork
    // pull requests, 2026-10-29), so the note says when.
    assert.match(texts['first-pr'], /a change to `docs\/` adds a Mintlify Preview \(fork\) check/);
    assert.match(contributing, /Start one if the newest entry already carries a release tag\./);
    // The steps the texts cite by number, and the title example they quote.
    assert.match(contributing, /^1\. If your change is for an open issue, claim it first/m);
    assert.match(contributing, /^6\. Open the pull request .*`Closes #N`/m);
    assert.match(contributing, /^9\. Write commit messages .*`fix\(client\): keep the progress bar visible while verifying`/m);
    assert.match(texts['claim-take'], /step 1\)/);
    assert.match(texts['no-issue'], /step 6\)/);
    assert.match(texts.title, /step 9\)/);
    assert.match(read('.github/claim/returner.md'), /Good first issues are kept for a first pull request here, and you already have a commit in Floe\./);
    assert.deepEqual(BOT_LABELS, ['unclaimed', 'claim-conflict', 'competing-pr']);
});

// ---------------------------------------------------------------- pr-intake.yml

const workflow = read('.github/workflows/pr-intake.yml');

test('pr-intake.yml runs on a schedule, on pushes to main and by hand, with no inputs', () => {
    const on = /^on:\n((?:(?: {2}.*)?\n)+?)(?=^\S)/m.exec(workflow);
    assert.ok(on, 'an on: block');
    const lines = on[1]
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('#'))
        .map((l) => l.trimEnd());
    assert.deepEqual(lines, ['  schedule:', "    - cron: '7,37 * * * *'", '  push:', '    branches: [main]', '  workflow_dispatch:']);
    for (const banned of ['pull_request', 'issue_comment', 'workflow_run', 'inputs:']) assert.ok(!workflow.includes(banned), banned);
});

test('pr-intake.yml asks for exactly its three job permissions, none at the top, and can write only once live', () => {
    assert.match(workflow, /^permissions: \{\}$/m);
    const perms = /^ {4}permissions:\n((?: {6}.*\n)+)/m.exec(workflow);
    assert.ok(perms, 'job-level permissions');
    const grants = [...perms[1].matchAll(/^ {6}([a-z-]+): (\w+)/gm)].map((m) => `${m[1]}: ${m[2]}`).sort();
    // The go-live pull request sets LIVE_SINCE and raises the token together.
    const prAccess = LIVE_SINCE === null ? 'read' : 'write';
    assert.deepEqual(grants, ['contents: read', 'issues: read', `pull-requests: ${prAccess}`]);
});

test('pr-intake.yml serializes sweeps at job level, guards the repository, and pins every action', () => {
    assert.doesNotMatch(workflow, /^concurrency:/m);
    assert.match(
        workflow,
        /^ {4}concurrency:\n {6}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name == 'workflow_dispatch' && 'preview' \|\| 'sweep' \}\}\n {6}cancel-in-progress: false$/m
    );
    assert.match(workflow, /^ {4}if: github\.repository == 'jannskiee\/floe'$/m);
    const uses = [...workflow.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((m) => m[1]);
    assert.equal(uses.length, 2);
    for (const ref of uses) assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, ref);
    const claim = read('.github/workflows/claim.yml');
    for (const ref of uses) assert.ok(claim.includes(ref), `${ref} is the pin claim.yml uses`);
});

test('pr-intake.yml checks out its own folder only and passes no expression or secret to the script', () => {
    const checkout = /- name: Check out[^\n]*\n((?: {8}.*\n)+)/.exec(workflow);
    assert.ok(checkout, 'the checkout step');
    assert.doesNotMatch(checkout[1], /^\s+(?:ref|repository):/m);
    assert.match(checkout[1], /^ {10}persist-credentials: false$/m);
    assert.match(checkout[1], /^ {10}sparse-checkout: \.github$/m);
    const script = /script: \|\n((?: {12}.*\n?)+)/.exec(workflow);
    assert.ok(script, 'a script: | block');
    assert.doesNotMatch(script[1], /\$\{\{/);
    assert.equal(
        script[1].trim(),
        'const { main } = await import(`${process.env.GITHUB_WORKSPACE}/.github/scripts/pr-intake.mjs`);\n            await main({ github, context, core });'
    );
    assert.doesNotMatch(workflow, /\bsecrets\./);
    assert.doesNotMatch(workflow, /^\s*(?:github-token|retries):/m);
});
