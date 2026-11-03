// Tests for claim.mjs, the /take bot, and for the files it reads: the replies
// in .github/claim/, CONTRIBUTING.md's headings and .github/workflows/claim.yml.
// Run from the repository root (Repo guardrails does, on every pull request):
//   node --test ".github/scripts/*.test.mjs"
// A quoted glob: Node 22 refuses a directory argument.
//
// The scenario tests run main() against an in-memory stand-in for the GitHub
// API, so every rule is exercised the way a real run would reach it.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    BOT_LOGIN,
    DEFAULT_SETUP,
    FREE_URL,
    HELP_URL,
    KINDS,
    LAUNCH_AT,
    MAX_HELD,
    PLACEHOLDERS,
    SETUP,
    decideTake,
    loadReplies,
    looksLikeClaim,
    main,
    marker,
    parseCommand,
    parseMarker,
    render,
    setupFor,
    varsFor,
} from './claim.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8').replace(/\r\n?/g, '\n');
const HOUR = 60 * 60 * 1000;
// Built from code points so this file holds no dash of its own (docs-check
// reads .github scripts too).
const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
const T0 = LAUNCH_AT + 24 * HOUR;
const iso = (t) => new Date(t).toISOString();
const ISSUE = 7;

// ---------------------------------------------------------------- the fake API

function fakeGitHub(setup = {}) {
    const s = {
        issue: {
            number: ISSUE,
            state: 'open',
            title: 'Browser: a small fix',
            labels: [{ name: 'good first issue' }],
            assignees: [],
            ...setup.issue,
        },
        comments: [],
        events: setup.events ?? [],
        commitsBy: new Set(setup.commitsBy ?? []),
        held: setup.held ?? {},
        pullRequests: setup.pullRequests ?? [],
        refuse: setup.refuse ?? false,
        refuseRemove: setup.refuseRemove ?? false,
        calls: [],
        alsoAssigned: setup.alsoAssigned ?? null,
        hideFromList: new Set(),
        fail: setup.fail ?? {},
        created: [],
        updated: [],
        reactions: [],
        nextId: 9000,
        now: T0,
    };
    const check = (name) => {
        if (s.fail[name]) throw s.fail[name];
    };
    const issueCopy = () => structuredClone(s.issue);
    const github = {
        paginate: async (fn, params) => (await fn(params)).data,
        graphql: async () => {
            check('graphql');
            return { repository: { issue: { closedByPullRequestsReferences: { nodes: s.pullRequests } } } };
        },
        rest: {
            issues: {
                get: async () => {
                    check('get');
                    return { data: issueCopy() };
                },
                listComments: async () => {
                    check('listComments');
                    return { data: s.comments.filter((c) => !s.hideFromList.has(c.id)).map((c) => structuredClone(c)) };
                },
                getComment: async ({ comment_id }) => {
                    const c = s.comments.find((x) => x.id === comment_id);
                    if (!c) throw Object.assign(new Error('Not Found'), { status: 404 });
                    return { data: structuredClone(c) };
                },
                addAssignees: async ({ assignees }) => {
                    check('addAssignees');
                    s.calls.push(['add', ...assignees]);
                    if (!s.refuse) {
                        for (const login of assignees) {
                            if (!s.issue.assignees.some((a) => a.login.toLowerCase() === login.toLowerCase())) s.issue.assignees.push({ login });
                        }
                        if (s.alsoAssigned) s.issue.assignees.push({ login: s.alsoAssigned });
                    }
                    return { data: issueCopy() };
                },
                removeAssignees: async ({ assignees }) => {
                    check('removeAssignees');
                    s.calls.push(['remove', ...assignees]);
                    if (!s.refuseRemove) {
                        s.issue.assignees = s.issue.assignees.filter((a) => !assignees.some((x) => x.toLowerCase() === a.login.toLowerCase()));
                    }
                    return { data: issueCopy() };
                },
                createComment: async ({ body }) => {
                    check('createComment');
                    const c = {
                        id: s.nextId++,
                        user: { login: BOT_LOGIN, type: 'Bot' },
                        author_association: 'NONE',
                        body,
                        created_at: iso(s.now),
                    };
                    s.comments.push(c);
                    s.created.push(c);
                    return { data: c };
                },
                updateComment: async ({ comment_id, body }) => {
                    check('updateComment');
                    const c = s.comments.find((x) => x.id === comment_id);
                    c.body = body;
                    s.updated.push({ id: comment_id, body });
                    return { data: c };
                },
                // A bare number is a good first issue. GitHub's labels filter
                // means every label at once, so a comma list of the two labels
                // finds nothing here, as it does there (measured 2026-11-03).
                listForRepo: async ({ assignee, labels, state }) => {
                    const wanted = labels ? labels.split(',').map((l) => l.trim().toLowerCase()) : [];
                    const entries = (s.held[assignee.toLowerCase()] ?? []).map((n) =>
                        typeof n === 'number' ? { number: n, labels: [{ name: 'good first issue' }] } : n
                    );
                    const has = (i, l) => (i.labels ?? []).some((x) => (typeof x === 'string' ? x : x.name).toLowerCase() === l);
                    const inState = (i) => state === 'all' || (i.state ?? 'open') === (state ?? 'open');
                    return { data: entries.filter((i) => inState(i) && wanted.every((l) => has(i, l))) };
                },
                listEvents: async () => ({ data: s.events }),
            },
            repos: {
                listCommits: async ({ author }) => ({
                    data: s.commitsBy.has(author.toLowerCase()) ? [{ sha: 'abc' }] : [],
                }),
            },
            reactions: {
                createForIssueComment: async ({ comment_id, content }) => {
                    check('reaction');
                    s.reactions.push({ id: comment_id, content });
                    return { data: {} };
                },
            },
        },
    };
    let commentId = 100;
    const say = (login, body, { association = 'NONE', at = s.now, type = 'User' } = {}) => {
        const c = { id: commentId++, user: { login, type }, author_association: association, body, created_at: iso(at) };
        s.comments.push(c);
        return c;
    };
    const core = {
        logs: [],
        failed: null,
        info(m) {
            this.logs.push(m);
        },
        warning(m) {
            this.logs.push(`warning: ${m}`);
        },
        setFailed(m) {
            this.failed = m;
        },
    };
    const run = async (trigger, { now = s.now + 5000 } = {}) => {
        const context = {
            repo: { owner: 'jannskiee', repo: 'floe' },
            payload: { issue: { number: ISSUE }, comment: trigger },
            serverUrl: 'https://github.com',
            runId: 42,
        };
        await main({ github, context, core, now });
    };
    return { s, github, say, run, core };
}

const kinds = (s) => s.created.map((c) => parseMarker(c.body).kind);
const assigned = (s) => s.issue.assignees.map((a) => a.login);

// ---------------------------------------------------------------- parsing

test('parseCommand reads the first real line, any letter case, text after allowed', () => {
    assert.equal(parseCommand('/take'), 'take');
    assert.equal(parseCommand('/TAKE'), 'take');
    assert.equal(parseCommand('  /take  I would like to work on this'), 'take');
    assert.equal(parseCommand('/take.'), 'take');
    assert.equal(parseCommand('\n\n/untake\n'), 'untake');
    assert.equal(parseCommand('> quoted text\n>\n/take'), 'take');
    assert.equal(parseCommand('/take\r\nthanks'), 'take');
    assert.equal(parseCommand('/takeover'), null);
    assert.equal(parseCommand('/take-it'), null);
    assert.equal(parseCommand('please /take'), null);
    assert.equal(parseCommand('Hi!\n/take'), null);
    assert.equal(parseCommand('`/take`'), null);
    assert.equal(parseCommand(''), null);
    assert.equal(parseCommand(undefined), null);
});

// The opening words of every claim comment on Floe from 2026-10-19 to
// 2026-10-25, none of which used a command.
const REAL_CLAIMS = [
    "Hi, I'd like to work on this issue. I'll add regression tests for special file e",
    'Hi @jannskiee,  I would like to contribute to this project. Could you please assign this to me?',
    "Hi! I'd like to work on this issue as my next contribution. I understand the goa",
    'hii @jannskiee  i would like to contribute to this project. Could you assign this issue for me?',
    "Hi! I'd like to work on this issue. I'm looking forward to learning the Go codeb",
    "Hi @jannskiee, I'd like to work on this issue! Could you please assign it to me?",
    "I'd like to take this one. I'll follow the History row's pattern: `type=\"button\"",
    "Hi! I'd like to work on this issue. I'll follow the suggested approach and add t",
    "Hi! I'd like to take on this issue. I'll first review the existing crash guard t",
    "Hi! I'd like to work on this. I'll remove the mismatched aria-label so the butto",
    "Hi! I'd like to work on this issue. I plan to add the alert role and an accessib",
    "Hi @jannskiee, thanks for suggesting this one after #711. I'd like to work on #7",
    "I'd like to work on this issue.",
    "Hi @jannskiee, I'd like to take this one. Plan: add `withPageScheme` in `client/",
    'I would like to work on this. I will register the flag and argument completions',
    "I'd like to work on this. Assigning myself if possible, or please assign it to m",
    "I'd like to work on this issue",
    "Hi @jannskiee, thanks for merging #753. I'd like to take this one. It's the same",
    "Hi, I'd like to work on this issue",
    `I${String.fromCharCode(0x2019)}d like to take this one.`, // a curly apostrophe
    "Hi @jannskiee, I'd like to take this one. Plan: give `nearestDir` the early `ret",
];

test('looksLikeClaim matches every real Floe claim', () => {
    for (const text of REAL_CLAIMS) assert.ok(looksLikeClaim(text), text);
});

test('looksLikeClaim leaves ordinary comments alone', () => {
    for (const text of [
        "I'll take a look at the logs tonight.",
        'Can I ask how you reproduced this?',
        'Thanks, this works on my machine now.',
        'The fix should take care of the CLI too.',
        'This is a duplicate of the other issue.',
        'Would a test in receiver.go be enough here?',
        '',
    ]) {
        assert.equal(looksLikeClaim(text), false, text);
    }
});

test('setupFor picks the CONTRIBUTING section from the title prefix', () => {
    assert.match(setupFor('Desktop: the button').url, /#desktop-app-only/);
    assert.match(setupFor('CLI: a flag').url, /#cli-only-needed/);
    assert.match(setupFor('Self-hosting: compose').url, /#full-stack-with-docker/);
    assert.match(setupFor('Docs: a page').url, /#documentation-only/);
    assert.match(setupFor('Server: a log line').url, /#client--server/);
    assert.equal(setupFor('Browser: a label').name, DEFAULT_SETUP[0]);
    assert.equal(setupFor('Engine: a guard').name, DEFAULT_SETUP[0]);
    assert.equal(setupFor(undefined).name, DEFAULT_SETUP[0]);
    assert.equal(setupFor('Constructor: a flag').name, DEFAULT_SETUP[0]);
    assert.equal(setupFor('__proto__: a flag').name, DEFAULT_SETUP[0]);
});

test('render fills known placeholders and refuses any other', () => {
    assert.equal(render('@{{login}} hi', { login: 'ann' }), '@ann hi');
    assert.throws(() => render('{{title}}', { title: 'x' }), /placeholder/);
    assert.throws(() => render('{{login}}', {}), /placeholder/);
});

test('the marker round-trips', () => {
    const m = { kind: 'taken', login: 'Ann-1', replyTo: [101, 205] };
    assert.deepEqual(parseMarker(`text\n\n${marker(m)}`), m);
    assert.equal(parseMarker('<!-- floe-claim kind=taken login=a reply-to=x -->'), null);
});

test('decideTake applies the rules in order', async () => {
    const yes = async () => true;
    const no = async () => false;
    const q = {
        isAssignee: false,
        hasAssignee: false,
        isGoodFirstIssue: true,
        isHelpWanted: false,
        returnerByAssociation: false,
        hasCommits: no,
        releasedByMaintainer: no,
        holdsAnotherGoodFirstIssue: no,
        holdsTheLimit: no,
        otherOpenPullRequest: no,
    };
    assert.equal(await decideTake(q), 'assign');
    assert.equal(await decideTake({ ...q, isAssignee: true, isGoodFirstIssue: false }), 'already-yours');
    assert.equal(await decideTake({ ...q, isGoodFirstIssue: false }), 'not-claimable');
    assert.equal(await decideTake({ ...q, returnerByAssociation: true, hasAssignee: true }), 'returner');
    assert.equal(await decideTake({ ...q, hasCommits: yes }), 'returner');
    assert.equal(await decideTake({ ...q, releasedByMaintainer: yes, hasAssignee: true }), 'released');
    assert.equal(await decideTake({ ...q, hasAssignee: true, otherOpenPullRequest: yes }), 'taken');
    assert.equal(await decideTake({ ...q, otherOpenPullRequest: yes }), 'has-pr');
    // The hold rules come last, so their advice (give one back, then /take
    // this one) only reaches someone this issue would otherwise go to.
    assert.equal(await decideTake({ ...q, holdsAnotherGoodFirstIssue: yes }), 'holds-one');
    assert.equal(await decideTake({ ...q, holdsAnotherGoodFirstIssue: yes, hasAssignee: true }), 'taken');
    assert.equal(await decideTake({ ...q, holdsAnotherGoodFirstIssue: yes, otherOpenPullRequest: yes }), 'has-pr');
    assert.equal(await decideTake({ ...q, holdsTheLimit: yes }), 'holds-two');
    assert.equal(await decideTake({ ...q, holdsAnotherGoodFirstIssue: yes, holdsTheLimit: yes }), 'holds-one');
});

test('decideTake on help wanted: open to everyone, with the same refusals and the limit of two', async () => {
    const yes = async () => true;
    const no = async () => false;
    const unasked = async () => assert.fail('help wanted never asks this');
    const q = {
        isAssignee: false,
        hasAssignee: false,
        isGoodFirstIssue: false,
        isHelpWanted: true,
        returnerByAssociation: false,
        hasCommits: unasked,
        releasedByMaintainer: no,
        holdsAnotherGoodFirstIssue: unasked,
        holdsTheLimit: no,
        otherOpenPullRequest: no,
    };
    assert.equal(await decideTake(q), 'assign');
    assert.equal(await decideTake({ ...q, returnerByAssociation: true }), 'assign', 'returners are who it is for');
    assert.equal(await decideTake({ ...q, isAssignee: true }), 'already-yours');
    assert.equal(await decideTake({ ...q, releasedByMaintainer: yes, hasAssignee: true }), 'released');
    assert.equal(await decideTake({ ...q, hasAssignee: true, otherOpenPullRequest: yes }), 'taken');
    assert.equal(await decideTake({ ...q, otherOpenPullRequest: yes }), 'has-pr');
    assert.equal(await decideTake({ ...q, holdsTheLimit: yes }), 'holds-two');
    assert.equal(await decideTake({ ...q, holdsTheLimit: yes, hasAssignee: true }), 'taken');
    assert.equal(await decideTake({ ...q, holdsTheLimit: yes, otherOpenPullRequest: yes }), 'has-pr');
    // Both labels: the good first issue rules, so a returner is still sent on.
    assert.equal(await decideTake({ ...q, isGoodFirstIssue: true, returnerByAssociation: true }), 'returner');
});

// ---------------------------------------------------------------- /take

test('a free good first issue is assigned, with +1 and the go-ahead', async () => {
    const { s, say, run } = fakeGitHub({ issue: { title: 'Desktop: a label' } });
    const c = say('ann', '/take');
    await run(c);
    assert.deepEqual(assigned(s), ['ann']);
    assert.deepEqual(kinds(s), ['assigned']);
    assert.deepEqual(s.reactions, [{ id: c.id, content: '+1' }]);
    const body = s.created[0].body;
    assert.match(body, /^@ann you're assigned/);
    assert.match(body, /\[Desktop app\]\(https:\/\/github\.com\/jannskiee\/floe\/blob\/main\/CONTRIBUTING\.md#desktop-app-only/);
    assert.deepEqual(parseMarker(body), { kind: 'assigned', login: 'ann', replyTo: [c.id] });
});

test('an assigned issue is taken, and the holder is not mentioned', async () => {
    const { s, say, run } = fakeGitHub({ issue: { assignees: [{ login: 'bob' }] } });
    await run(say('ann', '/take'));
    assert.deepEqual(assigned(s), ['bob']);
    assert.deepEqual(kinds(s), ['taken']);
    assert.doesNotMatch(s.created[0].body, /bob/);
    assert.ok(s.created[0].body.includes(FREE_URL));
});

test("another person's open pull request blocks the claim", async () => {
    const { s, say, run, core } = fakeGitHub({
        pullRequests: [{ number: 12, state: 'OPEN', author: { login: 'bob' } }],
    });
    await run(say('ann', '/take'));
    assert.deepEqual(kinds(s), ['has-pr']);
    assert.deepEqual(assigned(s), []);
    assert.ok(core.logs.some((l) => l.includes('12:OPEN:bob')));
});

test('a merged pull request, or the claimant\'s own open one, does not block', async () => {
    const { s, say, run } = fakeGitHub({
        pullRequests: [
            { number: 11, state: 'MERGED', author: { login: 'bob' } },
            { number: 12, state: 'OPEN', author: { login: 'Ann' } },
        ],
    });
    await run(say('ann', '/take'));
    assert.deepEqual(kinds(s), ['assigned']);
});

test('a pull request by a deleted account counts as someone else\'s', async () => {
    const { s, say, run } = fakeGitHub({ pullRequests: [{ number: 12, state: 'OPEN', author: null }] });
    await run(say('ann', '/take'));
    assert.deepEqual(kinds(s), ['has-pr']);
});

test('someone who already holds a good first issue cannot take a second', async () => {
    const { s, say, run } = fakeGitHub({ held: { ann: [3, ISSUE] } });
    await run(say('ann', '/take'));
    assert.deepEqual(kinds(s), ['holds-one']);
    assert.match(s.created[0].body, /assignee%3Aann/);
    assert.deepEqual(assigned(s), []);
});

test('only this issue among their assignments is not "another"', async () => {
    const { s, say, run } = fakeGitHub({ held: { ann: [ISSUE] } });
    await run(say('ann', '/take'));
    assert.deepEqual(kinds(s), ['assigned']);
});

for (const association of ['CONTRIBUTOR', 'COLLABORATOR', 'MEMBER']) {
    test(`a ${association} is sent to help wanted (good first issues are for a first PR)`, async () => {
        const { s, say, run } = fakeGitHub();
        await run(say('ann', '/take', { association }));
        assert.deepEqual(kinds(s), ['returner']);
        assert.deepEqual(assigned(s), []);
    });
}

test('a returner whose comments read NONE is caught by the commit history', async () => {
    const { s, say, run } = fakeGitHub({ commitsBy: ['ann'] });
    await run(say('Ann', '/take'));
    assert.deepEqual(kinds(s), ['returner']);
});

// The issue events API names the person unassigned in both actor and
// assignee; whoever made the change is assigner (measured on #692).
test('someone the maintainer unassigned cannot /take the issue back', async () => {
    const { s, say, run } = fakeGitHub({
        events: [{ event: 'unassigned', actor: { login: 'ann' }, assignee: { login: 'ann' }, assigner: { login: 'jannskiee' } }],
    });
    await run(say('ann', '/take'));
    assert.deepEqual(kinds(s), ['released']);
});

test('their own /untake or the bot giving way does not count as a release', async () => {
    const { s, say, run } = fakeGitHub({
        events: [
            { event: 'assigned', actor: { login: 'ann' }, assignee: { login: 'ann' }, assigner: { login: 'jannskiee' } },
            { event: 'unassigned', actor: { login: 'ann' }, assignee: { login: 'ann' }, assigner: { login: 'Ann' } },
            { event: 'unassigned', actor: { login: 'ann' }, assignee: { login: 'ann' }, assigner: { login: BOT_LOGIN } },
            { event: 'unassigned', actor: { login: 'bob' }, assignee: { login: 'bob' }, assigner: { login: 'jannskiee' } },
            { event: 'unassigned', actor: { login: 'ann' }, assignee: { login: 'ann' } },
        ],
    });
    await run(say('ann', '/take'));
    assert.deepEqual(kinds(s), ['assigned']);
});

test('an issue with neither label is not claimable', async () => {
    const { s, say, run } = fakeGitHub({ issue: { labels: [{ name: 'bug' }] } });
    await run(say('ann', '/take'));
    assert.deepEqual(kinds(s), ['not-claimable']);
    assert.deepEqual(assigned(s), []);
});

// ---------------------------------------------------------------- help wanted

const HELP = { labels: [{ name: 'bug' }, { name: 'help wanted' }] };
const held = (number, ...labels) => ({ number, labels: labels.map((name) => ({ name })) });

for (const [who, association, commitsBy] of [
    ['a newcomer', 'NONE', []],
    ['a returner by association', 'CONTRIBUTOR', []],
    ['a returner by commit history', 'NONE', ['ann']],
]) {
    test(`${who} can /take a free help wanted issue`, async () => {
        const { s, say, run } = fakeGitHub({ issue: { ...HELP, title: 'Desktop: a label' }, commitsBy });
        const c = say('ann', '/take', { association });
        await run(c);
        assert.deepEqual(assigned(s), ['ann']);
        assert.deepEqual(kinds(s), ['assigned']);
        assert.deepEqual(s.reactions, [{ id: c.id, content: '+1' }]);
        assert.match(s.created[0].body, /^@ann you're assigned, so go ahead as the issue describes\./);
        assert.match(s.created[0].body, /#desktop-app-only/);
    });
}

test('an issue with both labels follows the good first issue rules', async () => {
    const labels = [{ name: 'good first issue' }, { name: 'help wanted' }];
    const returner = fakeGitHub({ issue: { labels } });
    await returner.run(returner.say('ann', '/take', { association: 'CONTRIBUTOR' }));
    assert.deepEqual(kinds(returner.s), ['returner']);
    const newcomer = fakeGitHub({ issue: { labels, assignees: [{ login: 'bob' }] } });
    await newcomer.run(newcomer.say('ann', '/take'));
    assert.ok(newcomer.s.created[0].body.includes(FREE_URL), 'and the good first issue list');
});

test('a refusal on help wanted links the free help wanted issues, not the good first ones', async () => {
    const cases = [
        ['taken', { issue: { ...HELP, assignees: [{ login: 'bob' }] } }],
        ['has-pr', { issue: HELP, pullRequests: [{ number: 12, state: 'OPEN', author: { login: 'bob' } }] }],
    ];
    for (const [kind, setup] of cases) {
        const { s, say, run } = fakeGitHub(setup);
        await run(say('ann', '/take', { association: 'CONTRIBUTOR' }));
        assert.deepEqual(kinds(s), [kind]);
        assert.deepEqual(assigned(s).filter((a) => a === 'ann'), []);
        assert.ok(s.created[0].body.includes(`[help wanted issues nobody holds yet](${HELP_URL})`), kind);
        assert.ok(!s.created[0].body.includes(FREE_URL), kind);
    }
    const good = fakeGitHub({ issue: { assignees: [{ login: 'bob' }] } });
    await good.run(good.say('ann', '/take'));
    assert.ok(good.s.created[0].body.includes(`[good first issues nobody holds yet](${FREE_URL})`));
});

// Each row is one state, so the two claim orders of the same pair of issues
// are both here: what someone already holds, then the label of the one they
// ask for. Nothing depends on which they took first.
const GFI_ISSUE = { labels: [{ name: 'good first issue' }] };
for (const [name, issue, list, expected] of [
    ['one help wanted, asking for help wanted', HELP, [held(3, 'help wanted')], 'assigned'],
    ['two help wanted, asking for help wanted', HELP, [held(3, 'help wanted'), held(4, 'help wanted')], 'holds-two'],
    ['one of each, asking for help wanted', HELP, [held(3, 'good first issue'), held(4, 'help wanted')], 'holds-two'],
    ['a good first issue, asking for help wanted', HELP, [held(3, 'good first issue')], 'assigned'],
    ['help wanted, asking for a good first issue', GFI_ISSUE, [held(3, 'help wanted')], 'assigned'],
    ['two help wanted, asking for a good first issue', GFI_ISSUE, [held(3, 'help wanted'), held(4, 'help wanted')], 'holds-two'],
    ['a good first issue, asking for a second', GFI_ISSUE, [held(3, 'good first issue')], 'holds-one'],
    ['one of each, asking for a good first issue', GFI_ISSUE, [held(3, 'good first issue'), held(4, 'help wanted')], 'holds-one'],
    ['an unlabeled issue does not count', HELP, [held(3, 'bug'), held(4, 'help wanted')], 'assigned'],
    ['a pull request does not count', HELP, [{ ...held(3, 'help wanted'), pull_request: {} }, held(4, 'help wanted')], 'assigned'],
    ['this issue does not count', HELP, [held(ISSUE, 'help wanted'), held(4, 'help wanted')], 'assigned'],
    ['a closed issue does not count', HELP, [{ ...held(3, 'help wanted'), state: 'closed' }, { ...held(4, 'help wanted'), state: 'closed' }], 'assigned'],
    ['label names in any letter case', HELP, [held(3, 'Help Wanted'), held(4, 'GOOD FIRST ISSUE')], 'holds-two'],
    ['labels the API gives as strings', HELP, [{ number: 3, labels: ['help wanted'] }, { number: 4, labels: ['good first issue'] }], 'holds-two'],
]) {
    test(`holding: ${name}`, async () => {
        const { s, say, run } = fakeGitHub({ issue, held: { ann: list } });
        await run(say('ann', '/take'));
        assert.deepEqual(kinds(s), [expected]);
        assert.deepEqual(assigned(s), expected === 'assigned' ? ['ann'] : []);
    });
}

test('the hold replies link what the person holds', async () => {
    const two = fakeGitHub({ issue: HELP, held: { ann: [held(3, 'help wanted'), held(4, 'help wanted')] } });
    await two.run(two.say('ann', '/take'));
    assert.match(
        two.s.created[0].body,
        /\[two issues\]\(https:\/\/github\.com\/jannskiee\/floe\/issues\?q=[^)]*label%3A%22good%20first%20issue%22%2C%22help%20wanted%22%20assignee%3Aann\)/
    );
    const one = fakeGitHub({ held: { ann: [3] } });
    await one.run(one.say('ann', '/take'));
    assert.match(one.s.created[0].body, /\[a good first issue\]\([^)]*label%3A%22good%20first%20issue%22%20assignee%3Aann\)/);
    assert.ok(one.s.created[0].body.includes(`[help wanted](${HELP_URL})`));
});

test('the limit answers each person in a run from their own issues', async () => {
    const { s, say, run } = fakeGitHub({ issue: HELP, held: { ann: [held(3, 'help wanted'), held(4, 'help wanted')], bob: [] } });
    say('ann', '/take', { at: T0 });
    await run(say('bob', '/take', { at: T0 + 1000 }));
    assert.deepEqual(kinds(s), ['holds-two', 'assigned']);
    assert.deepEqual(assigned(s), ['bob']);
});

test('a plain claim at a limit gets the limit, not the how-to-claim hint', async () => {
    const two = fakeGitHub({ issue: HELP, held: { ann: [held(3, 'help wanted'), held(4, 'help wanted')] } });
    await two.run(two.say('ann', "I'd like to work on this issue."));
    assert.deepEqual(kinds(two.s), ['holds-two']);
    assert.deepEqual(assigned(two.s), []);
    const one = fakeGitHub({ held: { ann: [3] } });
    await one.run(one.say('ann', "I'd like to work on this issue."));
    assert.deepEqual(kinds(one.s), ['holds-one']);
    assert.deepEqual(assigned(one.s), []);
});

test('the limit is the number the replies and the contributing guide state', () => {
    assert.equal(MAX_HELD, 2);
    assert.match(loadReplies()['holds-two'], /\[two issues\]/);
    assert.match(read('CONTRIBUTING.md'), /You can hold two issues from these two labels at a time, only one of them a good first issue\./);
    assert.match(read('AGENTS.md'), /can hold two such issues at a time, only one of them a good first issue\./);
});

test('an old not-claimable-help reply still marks its comment answered', async () => {
    const { s, say, run } = fakeGitHub({ issue: HELP });
    const old = say('ann', '/take', { at: T0 });
    say(BOT_LOGIN, marker({ kind: 'not-claimable-help', login: 'ann', replyTo: [old.id] }), { at: T0 + 1000, type: 'Bot' });
    await run(say('carl', 'Thanks for filing this.', { at: T0 + 2000 }));
    assert.deepEqual(s.created, []);
    assert.deepEqual(assigned(s), []);
    const again = say('ann', '/take', { at: T0 + 3000 });
    await run(again);
    assert.deepEqual(kinds(s), ['assigned']);
    assert.deepEqual(parseMarker(s.created[0].body).replyTo, [again.id]);
});

test('a /take from the holder is already theirs', async () => {
    const { s, say, run } = fakeGitHub({ issue: { assignees: [{ login: 'Ann' }] } });
    await run(say('ann', '/TAKE'));
    assert.deepEqual(kinds(s), ['already-yours']);
});

test('an assignment GitHub drops is reported to the maintainer, not claimed', async () => {
    const { s, say, run } = fakeGitHub({ refuse: true });
    await run(say('ann', '/take'));
    assert.deepEqual(kinds(s), ['refused']);
    assert.match(s.created[0].body, /@jannskiee/);
    assert.deepEqual(s.reactions, []);
});

test('a hand assignment in the same moment wins, and the claim gives way', async () => {
    const { s, say, run } = fakeGitHub({ alsoAssigned: 'bob' });
    await run(say('ann', '/take'));
    assert.deepEqual(assigned(s), ['bob']);
    assert.deepEqual(kinds(s), ['taken']);
});

// ---------------------------------------------------------------- /untake

test('/untake releases the holder', async () => {
    const { s, say, run } = fakeGitHub({ issue: { assignees: [{ login: 'ann' }] } });
    const c = say('Ann', '/untake');
    await run(c);
    assert.deepEqual(assigned(s), []);
    assert.deepEqual(kinds(s), ['untaken']);
    assert.deepEqual(s.reactions, [{ id: c.id, content: '+1' }]);
});

test('/untake from someone who holds nothing changes nothing', async () => {
    const { s, say, run } = fakeGitHub({ issue: { assignees: [{ login: 'bob' }] } });
    await run(say('ann', '/untake'));
    assert.deepEqual(assigned(s), ['bob']);
    assert.deepEqual(kinds(s), ['not-assigned']);
});

test('/untake works on an issue of any label', async () => {
    const { s, say, run } = fakeGitHub({ issue: { labels: [], assignees: [{ login: 'ann' }] } });
    await run(say('ann', '/untake'));
    assert.deepEqual(kinds(s), ['untaken']);
});

// ---------------------------------------------------------------- reconcile

test('two pending claims: the earliest wins, the second is told it is taken', async () => {
    const { s, say, run } = fakeGitHub();
    say('ann', '/take', { at: T0 });
    const second = say('bob', '/take', { at: T0 + 1000 });
    await run(second);
    assert.deepEqual(assigned(s), ['ann']);
    assert.deepEqual(kinds(s), ['assigned', 'taken']);
    assert.deepEqual(s.calls, [['add', 'ann']], 'the second claimant is never assigned, not even for a moment');
    assert.equal(parseMarker(s.created[1].body).login, 'bob');
});

test('a command a dropped run never answered is answered by the next run, once', async () => {
    const { s, say, run } = fakeGitHub();
    const dropped = say('ann', '/take', { at: T0 });
    const later = say('carl', 'Thanks for filing this.', { at: T0 + 60000 });
    await run(later);
    assert.deepEqual(kinds(s), ['assigned']);
    assert.deepEqual(parseMarker(s.created[0].body).replyTo, [dropped.id]);
    await run(say('dee', 'Nice.', { at: T0 + 120000 }));
    assert.equal(s.created.length, 1);
});

test('replaying the same event changes nothing', async () => {
    const { s, say, run } = fakeGitHub();
    const c = say('ann', '/take');
    await run(c);
    await run(c);
    assert.deepEqual(kinds(s), ['assigned']);
    assert.deepEqual(assigned(s), ['ann']);
});

test('a deleted triggering comment is not acted on', async () => {
    const { s, run } = fakeGitHub();
    const ghost = { id: 555, user: { login: 'ann', type: 'User' }, author_association: 'NONE', body: '/take', created_at: iso(T0) };
    await run(ghost);
    assert.deepEqual(kinds(s), []);
    assert.deepEqual(assigned(s), []);
});

test('a triggering comment the list has not caught up with is read on its own', async () => {
    const { s, say, run } = fakeGitHub();
    const c = say('ann', '/take');
    s.hideFromList.add(c.id);
    await run(c);
    assert.deepEqual(kinds(s), ['assigned']);
});

test('a marker in a person\'s comment is ignored', async () => {
    const { s, say, run } = fakeGitHub();
    const claim = say('ann', '/take', { at: T0 });
    say('mallory', `ok\n\n${marker({ kind: 'taken', login: 'ann', replyTo: [claim.id] })}`, { at: T0 + 1000 });
    await run(claim);
    assert.deepEqual(assigned(s), ['ann']);
    assert.deepEqual(kinds(s), ['assigned']);
});

test('a repeated refusal edits the earlier reply and reacts instead of posting', async () => {
    const { s, say, run } = fakeGitHub({ issue: { assignees: [{ login: 'bob' }] } });
    const first = say('ann', '/take', { at: T0 });
    await run(first);
    const again = say('ann', '/take please', { at: T0 + 60000 });
    await run(again, { now: T0 + 65000 });
    assert.deepEqual(kinds(s), ['taken']);
    assert.equal(s.updated.length, 1);
    assert.deepEqual(parseMarker(s.updated[0].body).replyTo, [first.id, again.id]);
    assert.deepEqual(s.reactions, [{ id: again.id, content: 'eyes' }]);
    await run(say('carl', 'hm', { at: T0 + 70000 }), { now: T0 + 75000 });
    assert.equal(s.updated.length, 1);
});

test('a failure posts the error reply once, names the owner, and the batch goes on', async () => {
    const boom = Object.assign(new Error('boom'), { status: 502 });
    const { s, say, run, core } = fakeGitHub({ fail: { addAssignees: boom } });
    const a = say('ann', '/take', { at: T0 });
    const b = say('bob', '/untake', { at: T0 + 1000 });
    await run(b);
    assert.deepEqual(kinds(s), ['error', 'not-assigned']);
    assert.match(s.created[0].body, /@jannskiee/);
    assert.match(s.created[0].body, /actions\/runs\/42/);
    assert.equal(parseMarker(s.created[0].body).replyTo[0], a.id);
    assert.equal(core.failed, null);
    // A second failure for the same person edits that reply: one owner mention.
    const c = say('ann', '/take', { at: T0 + 2000 });
    await run(c);
    assert.equal(s.created.filter((x) => parseMarker(x.body).kind === 'error').length, 1);
    assert.equal(s.updated.length, 1);
});

test('the run fails only when a command gets no reply at all', async () => {
    const boom = Object.assign(new Error('boom'), { status: 502 });
    const { say, run, core } = fakeGitHub({ fail: { addAssignees: boom, createComment: boom } });
    await run(say('ann', '/take'));
    assert.match(core.failed, /got no reply/);
});

test('when the issue cannot be read, a command still gets the error reply', async () => {
    const boom = Object.assign(new Error('boom'), { status: 500 });
    const { s, say, run, core } = fakeGitHub({ fail: { listComments: boom } });
    const c = say('ann', '/take');
    await run(c);
    assert.deepEqual(kinds(s), ['error']);
    assert.equal(core.failed, null);
    const quiet = fakeGitHub({ fail: { listComments: boom } });
    await quiet.run(quiet.say('ann', 'Nice work.'));
    assert.deepEqual(kinds(quiet.s), []);
    // Here issue itself is undefined, so the reply's values must not need it.
    const noIssue = fakeGitHub({ fail: { get: boom } });
    await noIssue.run(noIssue.say('ann', '/take'));
    assert.deepEqual(kinds(noIssue.s), ['error']);
    assert.equal(noIssue.core.failed, null);
});

test('a failed reaction does not turn a good claim into an error', async () => {
    const { s, say, run } = fakeGitHub({ fail: { reaction: new Error('gone') } });
    await run(say('ann', '/take'));
    assert.deepEqual(kinds(s), ['assigned']);
});

test('a command from before the launch is left alone, even inside the week', async () => {
    const { s, say, run } = fakeGitHub();
    say('ann', '/take', { at: LAUNCH_AT - HOUR });
    await run(say('carl', 'hello', { at: LAUNCH_AT + HOUR }), { now: LAUNCH_AT + 2 * HOUR });
    assert.deepEqual(kinds(s), []);
    assert.deepEqual(assigned(s), []);
});

test('a command older than a week is left alone', async () => {
    const { s, say, run } = fakeGitHub();
    say('bob', '/take', { at: T0 });
    const later = T0 + 8 * 24 * HOUR;
    await run(say('carl', 'hello', { at: later }), { now: later + 5000 });
    assert.deepEqual(kinds(s), []);
    assert.deepEqual(assigned(s), []);
});

test('a command the owner answered by hand is not answered again', async () => {
    const { s, say, run } = fakeGitHub();
    say('ann', '/take', { at: T0 });
    say('jannskiee', 'Assigned you by hand.', { at: T0 + HOUR, association: 'OWNER' });
    await run(say('carl', 'hello', { at: T0 + 2 * HOUR }), { now: T0 + 2 * HOUR + 5000 });
    assert.deepEqual(kinds(s), []);
});

test("an owner comment does not swallow a recent claim whose run was replaced", async () => {
    // ann's run was pending, the owner commented, and dee's comment replaced
    // ann's pending run: dee's run must still answer ann.
    const { s, say, run } = fakeGitHub();
    say('ann', '/take', { at: T0 });
    say('jannskiee', 'Welcome!', { at: T0 + 5000, association: 'OWNER' });
    await run(say('dee', 'Nice issue.', { at: T0 + 10000 }), { now: T0 + 15000 });
    assert.deepEqual(kinds(s), ['assigned']);
    assert.deepEqual(assigned(s), ['ann']);
});

test("the owner's own /take is never processed", async () => {
    const { s, say, run } = fakeGitHub();
    say('jannskiee', '/take', { at: T0, association: 'OWNER' });
    await run(say('carl', 'hello', { at: T0 + 1000 }));
    assert.deepEqual(kinds(s), []);
    assert.deepEqual(assigned(s), []);
});

test('bots and closed issues are left alone', async () => {
    const bot = fakeGitHub();
    await bot.run(bot.say('helper[bot]', '/take', { type: 'Bot' }));
    assert.deepEqual(kinds(bot.s), []);
    const closed = fakeGitHub({ issue: { state: 'closed' } });
    await closed.run(closed.say('ann', '/take'));
    assert.deepEqual(kinds(closed.s), []);
});

// ---------------------------------------------------------------- plain-language claims

test('a plain claim on a free issue gets the /take hint, once, and is not assigned', async () => {
    const { s, say, run } = fakeGitHub();
    await run(say('ann', "Hi! I'd like to work on this issue.", { at: T0 }));
    assert.deepEqual(kinds(s), ['hint']);
    assert.deepEqual(assigned(s), []);
    await run(say('ann', 'Could you assign it to me?', { at: T0 + 60000 }), { now: T0 + 65000 });
    assert.deepEqual(kinds(s), ['hint']);
    assert.equal(s.updated.length, 0);
});

test('a plain claim on a taken issue gets the taken reply', async () => {
    const { s, say, run } = fakeGitHub({ issue: { assignees: [{ login: 'bob' }] } });
    await run(say('ann', "I'd like to take this one."));
    assert.deepEqual(kinds(s), ['taken']);
});

test('the holder and the author of an open pull request get no hint', async () => {
    const held = fakeGitHub({ issue: { assignees: [{ login: 'ann' }] } });
    await held.run(held.say('ann', "I'll work on it this weekend."));
    assert.deepEqual(kinds(held.s), []);
    const pr = fakeGitHub({ pullRequests: [{ number: 12, state: 'OPEN', author: { login: 'ann' } }] });
    await pr.run(pr.say('ann', "I'd like to work on this, my PR is up.", { association: 'CONTRIBUTOR' }));
    assert.deepEqual(kinds(pr.s), []);
});

test('plain claims get no hint on an issue with neither label', async () => {
    const { s, say, run } = fakeGitHub({ issue: { labels: [{ name: 'bug' }] } });
    await run(say('ann', "I'd like to work on this issue."));
    assert.deepEqual(kinds(s), []);
});

test('a plain claim on help wanted is answered as on a good first issue', async () => {
    const free = fakeGitHub({ issue: { labels: [{ name: 'help wanted' }] } });
    await free.run(free.say('ann', "Hi! I'd like to work on this issue.", { association: 'CONTRIBUTOR' }));
    assert.deepEqual(kinds(free.s), ['hint']);
    assert.deepEqual(assigned(free.s), []);
    const greeting = fakeGitHub({ issue: { labels: [{ name: 'help wanted' }] } });
    await greeting.run(greeting.say('ann', 'Hi! /take'));
    assert.deepEqual(kinds(greeting.s), ['hint']);
    const taken = fakeGitHub({ issue: { labels: [{ name: 'help wanted' }], assignees: [{ login: 'bob' }] } });
    await taken.run(taken.say('ann', "I'd like to take this one."));
    assert.deepEqual(kinds(taken.s), ['taken']);
    assert.ok(taken.s.created[0].body.includes(HELP_URL));
    const holder = fakeGitHub({ issue: { labels: [{ name: 'help wanted' }], assignees: [{ login: 'ann' }] } });
    await holder.run(holder.say('ann', "I'll work on it this weekend."));
    assert.deepEqual(kinds(holder.s), []);
});

test('a plain claim a dropped run missed is answered by the next run', async () => {
    const { s, say, run } = fakeGitHub();
    say('ann', "I'd like to work on this issue.", { at: T0 });
    await run(say('bob', 'Good find.', { at: T0 + 1000 }));
    assert.deepEqual(kinds(s), ['hint']);
    assert.equal(parseMarker(s.created[0].body).login, 'ann');
});

// ---------------------------------------------------------------- edges found in review

test('an unassignment GitHub drops is reported, not announced', async () => {
    const { s, say, run } = fakeGitHub({ issue: { assignees: [{ login: 'ann' }] }, refuseRemove: true });
    await run(say('ann', '/untake'));
    assert.deepEqual(kinds(s), ['refused']);
    assert.deepEqual(assigned(s), ['ann']);
    assert.deepEqual(s.reactions, []);
});

test('when giving way to a hand assignment fails too, the reply says refused', async () => {
    const { s, say, run } = fakeGitHub({ alsoAssigned: 'bob', refuseRemove: true });
    await run(say('ann', '/take'));
    assert.deepEqual(kinds(s), ['refused']);
});

test('acting replies are always posted, never folded into an earlier one', async () => {
    const { s, say, run } = fakeGitHub({ issue: { assignees: [{ login: 'ann' }] } });
    await run(say('ann', '/untake', { at: T0 }));
    s.issue.assignees.push({ login: 'ann' });
    await run(say('ann', '/untake', { at: T0 + 60000 }), { now: T0 + 65000 });
    assert.deepEqual(kinds(s), ['untaken', 'untaken']);
    assert.equal(s.updated.length, 0);
});

test('a failure while answering a plain claim posts nothing and does not fail the run', async () => {
    const boom = Object.assign(new Error('boom'), { status: 502 });
    const { s, say, run, core } = fakeGitHub({ fail: { graphql: boom } });
    await run(say('ann', "I'd like to work on this issue."));
    assert.deepEqual(kinds(s), []);
    assert.equal(core.failed, null);
});

test("a marker from another bot account is ignored like a person's", async () => {
    const { s, say, run } = fakeGitHub();
    const claim = say('ann', '/take', { at: T0 });
    say('dependabot[bot]', marker({ kind: 'taken', login: 'ann', replyTo: [claim.id] }), { at: T0 + 1000, type: 'Bot' });
    await run(claim);
    assert.deepEqual(kinds(s), ['assigned']);
});

test('a pull request among their assignments does not count as a held issue', async () => {
    const { s, say, run } = fakeGitHub({ held: { ann: [{ number: 3, pull_request: {}, labels: [{ name: 'good first issue' }] }] } });
    await run(say('ann', '/take'));
    assert.deepEqual(kinds(s), ['assigned']);
});

test('a deleted account (ghost) is never answered or assigned', async () => {
    const { s, say, run } = fakeGitHub({ refuse: true });
    await run(say('ghost', '/take'));
    assert.deepEqual(s.created, []);
    assert.deepEqual(s.calls, []);
});

test('an owner comment posted while the run waited does not swallow its claim', async () => {
    const { s, say, run } = fakeGitHub();
    const claim = say('ann', '/take', { at: T0 });
    say('jannskiee', 'Welcome!', { at: T0 + 5000, association: 'OWNER' });
    await run(claim, { now: T0 + 10000 });
    assert.deepEqual(kinds(s), ['assigned']);
});

test('a /take after a greeting is not lost: it gets the hint', async () => {
    for (const body of ['Hi @jannskiee,\n/take', 'Hi! /take', 'Hey there\n\n/take please']) {
        const { s, say, run } = fakeGitHub();
        await run(say('ann', body));
        assert.deepEqual(kinds(s), ['hint'], body);
        assert.deepEqual(assigned(s), [], body);
    }
    const quoted = fakeGitHub();
    await quoted.run(quoted.say('ann', '> start a comment with /take\n\nthanks for the tip'));
    assert.deepEqual(kinds(quoted.s), []);
    const toOwner = fakeGitHub();
    await toOwner.run(toOwner.say('ann', '@jannskiee hi! /take'));
    assert.deepEqual(kinds(toOwner.s), ['hint']);
});

test('advice to someone else about /take is not a claim', async () => {
    const { s, say, run } = fakeGitHub();
    await run(say('helper', '@newbie you can claim it: just comment /take here', { association: 'CONTRIBUTOR' }));
    assert.deepEqual(kinds(s), []);
    const email = fakeGitHub();
    await email.run(email.say('ann', 'Hi! /take (mail me at ann@example.com)'));
    assert.deepEqual(kinds(email.s), ['hint']);
});

test('a holder who writes /untake after other words is told how to give it back', async () => {
    const { s, say, run } = fakeGitHub({ issue: { assignees: [{ login: 'ann' }] } });
    await run(say('ann', "Sorry, I can't finish this. /untake"));
    assert.deepEqual(kinds(s), ['untake-hint']);
    assert.deepEqual(assigned(s), ['ann']);
    const other = fakeGitHub({ issue: { assignees: [{ login: 'bob' }] } });
    await other.run(other.say('ann', 'Maybe bob should /untake?'));
    assert.deepEqual(kinds(other.s), []);
});

test('a holder of another good first issue is told so only when this one is free', async () => {
    const free = fakeGitHub({ held: { ann: [3] } });
    await free.run(free.say('ann', '/take'));
    assert.deepEqual(kinds(free.s), ['holds-one']);
    const taken = fakeGitHub({ held: { ann: [3] }, issue: { assignees: [{ login: 'bob' }] } });
    await taken.run(taken.say('ann', '/take'));
    assert.deepEqual(kinds(taken.s), ['taken']);
});

// ---------------------------------------------------------------- the replies

const replies = loadReplies();

test('every reply kind has exactly one file, and every file is a kind', () => {
    assert.deepEqual(Object.keys(replies).sort(), [...KINDS].sort());
    assert.deepEqual(
        readdirSync(new URL('.github/claim/', ROOT)).sort(),
        KINDS.map((k) => `${k}.md`).sort()
    );
});

test('the replies use only known placeholders, address the commenter, and keep the house style', () => {
    for (const [kind, text] of Object.entries(replies)) {
        for (const [, key] of text.matchAll(/\{\{([^}]*)\}\}/g)) assert.ok(PLACEHOLDERS.includes(key), `${kind}: {{${key}}}`);
        assert.ok(text.startsWith('@{{login}} '), `${kind} starts with the commenter`);
        assert.doesNotMatch(text, DASHES, `${kind}: no em or en dash`);
        // A #123 or an issue URL would put a "mentioned this" entry on that thread.
        assert.doesNotMatch(text, /#\d|\/(?:issues|pull)\/\d/, `${kind}: no issue references`);
        assert.doesNotMatch(text, /floe-claim/, `${kind}: the marker is added by code`);
        const mentions = text.includes('@jannskiee');
        assert.equal(mentions, kind === 'refused' || kind === 'error', `${kind}: owner mention`);
    }
});

test('every reply renders with the values main() supplies', () => {
    const issues = [
        { title: 'Desktop: a label', labels: [{ name: 'good first issue' }] },
        { title: 'Desktop: a label', labels: [{ name: 'help wanted' }] },
        { title: 'Desktop: a label', labels: ['help wanted', 'good first issue'] },
        { title: 'Desktop: a label', labels: [] },
        { title: 'Desktop: a label' },
        undefined,
    ];
    for (const issue of issues) {
        const vars = varsFor('ann', issue, 'https://example.test/run');
        assert.deepEqual(Object.keys(vars).sort(), [...PLACEHOLDERS].sort(), 'varsFor supplies exactly the placeholders');
        for (const [kind, text] of Object.entries(replies)) assert.doesNotThrow(() => render(text, vars), kind);
    }
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

test('the docs link the same two free-issue searches the replies do', () => {
    for (const file of ['README.md', 'CONTRIBUTING.md', '.github/ISSUE_TEMPLATE/config.yml']) {
        assert.ok(read(file).includes(FREE_URL), file);
        assert.ok(read(file).includes(HELP_URL), file);
    }
    // has-pr refuses an issue a pull request targets, so neither list offers one.
    for (const url of [FREE_URL, HELP_URL]) assert.match(url, /no%3Aassignee%20-linked%3Apr$/);
});

test('every setup link points at a real CONTRIBUTING.md heading', () => {
    const anchors = anchorsOf(read('CONTRIBUTING.md'));
    assert.ok(anchors.has('getting-started'), 'the issue bodies link #getting-started');
    for (const [, anchor] of [...Object.values(SETUP), DEFAULT_SETUP]) assert.ok(anchors.has(anchor), anchor);
});

// ---------------------------------------------------------------- claim.yml

const workflow = read('.github/workflows/claim.yml');

test('claim.yml passes no expression into the script and pins every action', () => {
    const script = /script: \|\n((?: {12}.*\n?)+)/.exec(workflow);
    assert.ok(script, 'a script: | block');
    assert.doesNotMatch(script[1], /\$\{\{/);
    assert.match(script[1], /import\(`\$\{process\.env\.GITHUB_WORKSPACE\}\/\.github\/scripts\/claim\.mjs`\)/);
    const uses = [...workflow.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((m) => m[1]);
    assert.ok(uses.length >= 2);
    for (const ref of uses) assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, ref);
    assert.match(workflow, /persist-credentials: false/);
});

test('claim.yml asks for exactly the three job permissions, and none at the top', () => {
    assert.match(workflow, /^permissions: \{\}$/m);
    const perms = /^ {4}permissions:\n((?: {6}.*\n)+)/m.exec(workflow);
    assert.ok(perms, 'job-level permissions');
    const grants = [...perms[1].matchAll(/^ {6}([a-z-]+): (\w+)/gm)].map((m) => `${m[1]}: ${m[2]}`).sort();
    assert.deepEqual(grants, ['contents: read', 'issues: write', 'pull-requests: read']);
});

test('claim.yml serializes per issue at job level and guards the trigger', () => {
    assert.doesNotMatch(workflow, /^concurrency:/m, 'never at workflow level: a skipped run would join the group');
    assert.match(
        workflow,
        /^ {4}concurrency:\n {6}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.issue\.number \}\}\n {6}cancel-in-progress: false$/m
    );
    assert.doesNotMatch(workflow, /^\s+queue:/m, 'actionlint 1.7.12 rejects the key');
    assert.match(workflow, /^ {4}if: >-$/m, 'a folded expression, never a | block');
    assert.match(workflow, /github\.repository == 'jannskiee\/floe'/);
    assert.match(workflow, /github\.event\.comment\.author_association != 'OWNER'/);
    assert.match(workflow, /!github\.event\.issue\.pull_request/);
    assert.match(workflow, /github\.event\.comment\.user\.type == 'User'/);
    assert.match(workflow, /^ {4}types: \[created\]$/m);
});

test('claim.yml has one trigger and checks out main only', () => {
    const on = /^on:\n((?:(?: {2}.*)?\n)+?)(?=^\S)/m.exec(workflow);
    assert.equal(on?.[1].trim(), 'issue_comment:\n    types: [created]');
    const checkout = /- name: Check out[^\n]*\n((?: {8}.*\n)+)/.exec(workflow);
    assert.ok(checkout, 'the checkout step');
    assert.doesNotMatch(checkout[1], /^\s+(?:ref|repository):/m);
    assert.match(checkout[1], /^ {10}sparse-checkout: \.github$/m);
});

test('claim.yml references no secret and runs github-script on the job token', () => {
    assert.doesNotMatch(workflow, /\bsecrets\./);
    assert.doesNotMatch(workflow, /^\s*github-token:/m);
});

test("claim.yml's if: is exactly the guard the bot relies on", () => {
    const m = /^ {4}if: >-\n((?: {6}.*\n)+)/m.exec(workflow);
    assert.ok(m, 'a folded if:');
    assert.equal(
        m[1].replace(/\s+/g, ' ').trim(),
        "github.repository == 'jannskiee/floe' && !github.event.issue.pull_request && github.event.issue.state == 'open' && github.event.comment.user.type == 'User' && github.event.comment.author_association != 'OWNER' && (contains(github.event.issue.labels.*.name, 'good first issue') || contains(github.event.issue.labels.*.name, 'help wanted') || contains(github.event.comment.body, '/take') || contains(github.event.comment.body, '/untake'))"
    );
});
