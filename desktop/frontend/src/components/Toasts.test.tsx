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
import {render, screen, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe, expect, it, vi} from 'vitest';
import {NoticeStack, RequestNotice, UNDO_ANCHOR_ID, UndoToast, UpdateNotice} from './Toasts';

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

/**
 * The notice stack (spec 06 5.4): a pending request and an available update
 * can stand at the same time, and neither may cover the other.
 */
describe('the notice stack', () => {
    it('request notice and update notice are both reachable in one stack', async () => {
        const onReview = vi.fn();
        const onDismiss = vi.fn();
        const {container} = render(
            <NoticeStack>
                <RequestNotice onReview={onReview}/>
                <UpdateNotice version="desktop-v0.3.0" onDismiss={onDismiss}/>
            </NoticeStack>
        );
        // One fixed stack, and the notices inside it are in its flow rather
        // than each pinned to the same corner on top of the other.
        const stack = container.firstElementChild as HTMLElement;
        expect(stack.className).toContain('fixed');
        expect(stack.className).toContain('flex-col');
        const request = screen.getByRole('group', {name: 'Someone wants to send you files.'});
        const update = screen.getByRole('group', {name: 'Update available'});
        expect(request.parentElement).toBe(stack);
        expect(update.parentElement).toBe(stack);
        expect(request.className).not.toContain('fixed');
        expect(update.className).not.toContain('fixed');
        expect(request.compareDocumentPosition(update) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        await userEvent.click(within(request).getByRole('button', {name: 'Review'}));
        expect(onReview).toHaveBeenCalledTimes(1);
        await userEvent.click(within(update).getByRole('button', {name: 'Dismiss update notice'}));
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('renders nothing when no notice stands', () => {
        const {container} = render(<NoticeStack>{false}{null}</NoticeStack>);
        expect(container.innerHTML).toBe('');
    });

    it('the request notice is a constant: no label, count, size or name', () => {
        render(<RequestNotice onReview={() => {}}/>);
        const group = screen.getByRole('group');
        expect(group.textContent).toBe('Someone wants to send you files.Review');
    });
});
