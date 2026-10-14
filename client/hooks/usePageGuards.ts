import { useEffect } from 'react';
import { fullLoadTarget } from '@/lib/pageGuards';

/**
 * The browser's own "Leave site?" prompt, held while `active`. Browsers show
 * their own generic wording, and only once the person has used the page; a
 * promise that the tab survives is not what this is (E-50).
 *
 * Shared by the request link visitor (useVisitorGuards) and the main page.
 */
export function useLeavePrompt(active: boolean) {
    useEffect(() => {
        if (!active) return;
        const hold = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            // Chrome and Edge still need returnValue set to show the prompt.
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', hold);
        return () => window.removeEventListener('beforeunload', hold);
    }, [active]);
}

/**
 * While `active`, an in-app link loads its page in full, so it goes through
 * the leave prompt above. next/link navigates inside the page and never
 * unloads it, so beforeunload never ran: the navbar's Download pill and the
 * footer's links unmounted the main page, its transfer and its received files
 * without a question (W2-01). A capture listener on the window runs before
 * React's own on the document, and next/link does nothing with a click whose
 * default is already prevented. Which clicks it takes is fullLoadTarget's
 * decision (lib/pageGuards.ts).
 *
 * The main page only: the request page's footer links are plain anchors for
 * the same reason and more (components/request/RequestShell.tsx).
 */
export function useFullLoadLinks(active: boolean) {
    useEffect(() => {
        if (!active) return;
        const onClick = (e: MouseEvent) => {
            const anchor = e.target instanceof Element ? e.target.closest('a[href]') : null;
            if (!(anchor instanceof HTMLAnchorElement)) return;
            const to = fullLoadTarget(
                {
                    button: e.button,
                    modified: e.metaKey || e.ctrlKey || e.shiftKey || e.altKey,
                    defaultPrevented: e.defaultPrevented,
                    href: anchor.href,
                    target: anchor.target,
                    download: anchor.hasAttribute('download'),
                },
                window.location.href
            );
            if (to === null) return;
            e.preventDefault();
            window.location.assign(to);
        };
        window.addEventListener('click', onClick, true);
        return () => window.removeEventListener('click', onClick, true);
    }, [active]);
}

/**
 * A file let go anywhere but a drop zone. Chrome's default is to open it in
 * this tab, which ends whatever the page was doing without a word. A zone's
 * own handlers run first (React listens on the document, this on the window),
 * so a drop the zone took is already defaultPrevented and passes; anything
 * else carrying files is refused, with the no-drop cursor.
 *
 * Shared by the request link visitor (useRequestFiles) and the main page.
 */
export function useStrayDropGuard() {
    useEffect(() => {
        const refuse = (e: globalThis.DragEvent) => {
            if (e.defaultPrevented || !Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
        };
        window.addEventListener('dragover', refuse);
        window.addEventListener('drop', refuse);
        return () => {
            window.removeEventListener('dragover', refuse);
            window.removeEventListener('drop', refuse);
        };
    }, []);
}
