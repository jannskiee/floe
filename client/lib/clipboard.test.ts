import { describe, it, expect, afterEach, vi } from 'vitest';
import { copyText } from './clipboard';

/**
 * There is no DOM here: client/vitest.config.ts runs environment 'node' and no
 * jsdom is installed. So these fakes prove the branch selection and the
 * no-node-left-behind invariant, and they cannot prove that execCommand puts
 * anything on a real clipboard. The PR body says the same thing rather than
 * implying coverage this does not have.
 */

/**
 * A document stand-in that records what is attached to document.body and
 * tracks focus the way a browser does on this path: select() moves focus into
 * the textarea, and removing the focused textarea drops focus to the body.
 */
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
    const focus = { active: body as unknown };
    vi.stubGlobal('document', {
        createElement() {
            opts.onCreate?.();
            const node = {
                value: '',
                style: {} as Record<string, string>,
                parent: null as unknown,
                select() {
                    focus.active = node;
                },
                remove() {
                    const i = attached.indexOf(node);
                    if (i !== -1) attached.splice(i, 1);
                    if (focus.active === node) focus.active = body;
                },
            };
            return node;
        },
        body,
        get activeElement() {
            return focus.active;
        },
        execCommand: opts.exec ?? (() => true),
    });
    return { attached, focus, body };
}

/** A button that takes focus when asked, and counts how often it was asked. */
function control(focus: { active: unknown }) {
    const button: { calls: number; focus: () => void } = {
        calls: 0,
        focus() {
            button.calls += 1;
            focus.active = button;
        },
    };
    return button;
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
        const { attached } = stubDom({ exec: () => true });
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
            const { attached } = stubDom(opts);
            await copyText('x');
            expect(attached).toEqual([]);
        });
    }
});

describe('copyText gives focus back to the button that held it', () => {
    // A keyboard user presses Copy; the textarea fallback used to leave focus
    // on the page body, so the next Tab started from the top of the page.
    function pressedControl(opts: Parameters<typeof stubDom>[0] = {}) {
        const dom = stubDom(opts);
        const button = control(dom.focus);
        dom.focus.active = button;
        return { button, dom };
    }

    const outcomes: Array<[string, Parameters<typeof stubDom>[0], boolean]> = [
        ['execCommand returns true', { exec: () => true }, true],
        ['execCommand returns false', { exec: () => false }, false],
        [
            'execCommand throws',
            {
                exec: () => {
                    throw new Error('SecurityError');
                },
            },
            false,
        ],
    ];

    for (const [name, opts, result] of outcomes) {
        it(`when ${name}`, async () => {
            vi.stubGlobal('navigator', {});
            const { button, dom } = pressedControl(opts);
            expect(await copyText('x')).toBe(result);
            expect(dom.focus.active).toBe(button);
        });
    }

    it('when writeText rejects and the fallback runs', async () => {
        vi.stubGlobal('navigator', {
            clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
        });
        const { button, dom } = pressedControl({ exec: () => true });
        expect(await copyText('x')).toBe(true);
        expect(dom.focus.active).toBe(button);
    });

    it('the textarea holds focus and the text while the copy runs', async () => {
        vi.stubGlobal('navigator', {});
        let during: { active: unknown; value: unknown } | null = null;
        const { button, dom } = pressedControl({
            exec: () => {
                const active = document.activeElement as { value?: string } | null;
                during = { active, value: active?.value };
                return true;
            },
        });
        expect(await copyText('the link')).toBe(true);
        expect(during).not.toBeNull();
        expect(during!.active).not.toBe(button);
        expect(during!.value).toBe('the link');
        expect(dom.focus.active).toBe(button);
    });

    it('moves no focus when the clipboard API copies', async () => {
        vi.stubGlobal('navigator', {
            clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
        });
        const { button } = pressedControl();
        expect(await copyText('x')).toBe(true);
        expect(button.calls).toBe(0);
    });

    it('moves no focus when only the page held it', async () => {
        vi.stubGlobal('navigator', {});
        const dom = stubDom({ exec: () => true });
        expect(await copyText('x')).toBe(true);
        expect(dom.focus.active).toBe(dom.body);
    });

    it('resolves with the copy result when focus() throws', async () => {
        vi.stubGlobal('navigator', {});
        const { button } = pressedControl({ exec: () => true });
        button.focus = () => {
            throw new Error('focus blew up');
        };
        await expect(copyText('x')).resolves.toBe(true);
    });

    it('resolves when the focus holder has no focus method', async () => {
        vi.stubGlobal('navigator', {});
        const dom = stubDom({ exec: () => true });
        dom.focus.active = {};
        await expect(copyText('x')).resolves.toBe(true);
    });
});
