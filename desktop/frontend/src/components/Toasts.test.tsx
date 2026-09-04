// @vitest-environment jsdom
/**
 * The undo bar is focused from App.clearStaged() by getElementById. While both
 * halves lived in App.tsx that was at least visible in one screenful; once the
 * component moved it became a contract across files that tsc could not see.
 *
 * The fix is the exported UNDO_ANCHOR_ID, which makes a rename a compile error
 * rather than a keyboard that silently falls to document.body. What tsc still
 * cannot check is that the id lands on something focusable, so that is what is
 * asserted here. No test rendered UndoToast at all before this one.
 */
import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';
import {UNDO_ANCHOR_ID, UndoToast} from './Toasts';

const noop = () => {};

const mount = (onUndo = noop) =>
    render(
        <UndoToast
            label="Cleared 3 files"
            action="Undo"
            onUndo={onUndo}
            onHold={noop}
            onArm={noop}
        />
    );

describe('the undo bar focus anchor', () => {
    it('puts the anchor id on a focusable control', () => {
        mount();
        const btn = document.getElementById(UNDO_ANCHOR_ID);
        expect(btn).not.toBeNull();
        // A div with the right id would satisfy getElementById and then
        // swallow the focus() call, which is the failure worth catching.
        expect(btn?.tagName).toBe('BUTTON');
        expect(btn).toBe(screen.getByRole('button', {name: 'Undo'}));
        btn?.focus();
        expect(document.activeElement).toBe(btn);
    });

    it('runs onUndo when that control is pressed', async () => {
        const onUndo = vi.fn();
        mount(onUndo);
        await userEvent.click(document.getElementById(UNDO_ANCHOR_ID)!);
        expect(onUndo).toHaveBeenCalledTimes(1);
    });
});
