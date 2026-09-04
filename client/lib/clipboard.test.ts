import { describe, it, expect, afterEach, vi } from 'vitest';
import { copyText } from './clipboard';

/**
 * There is no DOM here: client/vitest.config.ts runs environment 'node' and no
 * jsdom is installed. So these fakes prove the branch selection and the
 * no-node-left-behind invariant, and they cannot prove that execCommand puts
 * anything on a real clipboard. The PR body says the same thing rather than
 * implying coverage this does not have.
 */

/** A document.body stand-in that records what is attached to it. */
function stubDom(opts: {
    exec?: () => boolean;
    onAppend?: () => void;
    onCreate?: () => void;
}) {
    const attached: unknown[] = [];
    const body = {
        appendChild(node: { parent: unknown }) {
            opts.onAppend?.();
            node.parent = body;
            attached.push(node);
        },
    };
    vi.stubGlobal('document', {
        createElement() {
            opts.onCreate?.();
            const node = {
                value: '',
                style: {} as Record<string, string>,
                parent: null as unknown,
                select() {},
                remove() {
                    const i = attached.indexOf(node);
                    if (i !== -1) attached.splice(i, 1);
                },
            };
            return node;
        },
        body,
        execCommand: opts.exec ?? (() => true),
    });
    return attached;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('copyText, async clipboard path', () => {
    it('returns true and writes the exact string', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        expect(await copyText('hello')).toBe(true);
        expect(writeText).toHaveBeenCalledWith('hello');
    });

    it('falls back when writeText rejects', async () => {
        vi.stubGlobal('navigator', {
            clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
        });
        const attached = stubDom({ exec: () => true });
        expect(await copyText('x')).toBe(true);
        expect(attached).toEqual([]);
    });

    it('falls back when the page has no clipboard API at all', async () => {
        // The insecure-context case, and the one InstallTabs hit with no
        // fallback of its own.
        vi.stubGlobal('navigator', {});
        stubDom({ exec: () => true });
        expect(await copyText('x')).toBe(true);
    });
});

describe('copyText, fallback honesty', () => {
    it('returns false when execCommand returns false', async () => {
        // The bug all three sites shared: the return value was discarded and
        // every one of them reported success anyway.
        vi.stubGlobal('navigator', {});
        stubDom({ exec: () => false });
        expect(await copyText('x')).toBe(false);
    });

    it('returns false when execCommand throws', async () => {
        vi.stubGlobal('navigator', {});
        stubDom({
            exec: () => {
                throw new Error('SecurityError');
            },
        });
        expect(await copyText('x')).toBe(false);
    });

    it('returns false when there is no document (server render)', async () => {
        vi.stubGlobal('navigator', {});
        vi.stubGlobal('document', undefined);
        expect(await copyText('x')).toBe(false);
    });

    it('never rejects, whatever fails', async () => {
        vi.stubGlobal('navigator', {
            clipboard: {
                get writeText(): never {
                    throw new Error('blocked getter');
                },
            },
        });
        stubDom({
            onCreate: () => {
                throw new Error('createElement blew up');
            },
        });
        await expect(copyText('x')).resolves.toBe(false);
    });
});

describe('copyText leaves no node behind', () => {
    // rmSync-style invariant: whatever happens, document.body holds exactly
    // what it held on entry. Both implementations this replaces removed the
    // textarea on the success line only, so both leaked on a throw.
    const paths: Array<[string, Parameters<typeof stubDom>[0]]> = [
        ['execCommand true', { exec: () => true }],
        ['execCommand false', { exec: () => false }],
        [
            'execCommand throws',
            {
                exec: () => {
                    throw new Error('boom');
                },
            },
        ],
        [
            'appendChild throws',
            {
                onAppend: () => {
                    throw new Error('detached body');
                },
            },
        ],
    ];

    for (const [name, opts] of paths) {
        it(name, async () => {
            vi.stubGlobal('navigator', {});
            const attached = stubDom(opts);
            await copyText('x');
            expect(attached).toEqual([]);
        });
    }
});
