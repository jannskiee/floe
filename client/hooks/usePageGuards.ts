import { useEffect } from 'react';
import { fullLoadTarget, samePageTop } from '@/lib/pageGuards';
import { reloadGate } from '@/lib/reloadGate';

/**
 * The browser's own "Leave site?" prompt, held while `active`. Browsers show
 * their own generic wording, and only once the person has used the page; a
 * promise that the tab survives is not what this is (E-50).
 *
 * For the same span the page's own reloads never end the transfer unasked
 * (lib/reloadGate.ts): the stale-bundle recovery is skipped, and the main
 * page's reload for a new room link waits unless the browser can ask, since
 * a tab nobody has clicked gets no prompt at all.
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
        const release = reloadGate.hold();
        return () => {
            window.removeEventListener('beforeunload', hold);
            release();
        };
    }, [active]);
}

/**
 * Every in-app link loads its page in full, so it goes through the leave
 * prompt above whenever the prompt is held. next/link navigates inside the
 * page and never unloads it, so beforeunload never ran: the navbar's Download
 * pill and the footer's links unmounted the main page, its transfer and its
 * received files without a question (W2-01). It is on even while nothing is
 * held, so no soft history entry ever follows the main page, and Forward after
 * a soft hop back cannot leave it that way either (opensMainPage). A link to
 * the page itself keeps the page and goes to the top, as next/link did
 * (samePageTop), instead of reloading away files not yet sent. A capture
 * listener on the window runs before React's own on the document, and
 * next/link does nothing with a click whose default is already prevented.
 * Which clicks it takes is fullLoadTarget's and samePageTop's decision
 * (lib/pageGuards.ts).
 *
 * This listener alone left a gap, so it is not what keeps the main page a
 * document of its own. P2PTransfer adds it, and InAppBrowserGuard mounts
 * P2PTransfer one effect after hydration, so for a moment the page's
 * next/links were live and soft. Measured under next dev with the rest of
 * main-page-guards.spec.ts running beside it, an instrumented copy of its
 * Forward cell failed 11 of 20 times, and each of the 11 (none of the 9 that
 * passed) clicked the footer's How It Works after hydration and before
 * P2PTransfer had mounted: the click was a soft hop, Back and Forward stayed
 * in one document, and beforeunload never ran. Adding the listener at
 * hydration would only narrow the gap, as effects run after the commit that
 * makes next/link live. So nothing the main page renders is a next/link
 * (pageGuards.test.ts walks its imports): a plain anchor loads in full before,
 * during and after hydration. This stays as the net for a soft link that gets
 * past that test, and for samePageTop.
 *
 * The main page only: the request page's footer links are plain anchors for
 * the same reason and more (components/request/RequestShell.tsx).
 */
export function useFullLoadLinks() {
    useEffect(() => {
        const onClick = (e: MouseEvent) => {
            const anchor = e.target instanceof Element ? e.target.closest('a[href]') : null;
            if (!(anchor instanceof HTMLAnchorElement)) return;
            const click = {
                button: e.button,
                modified: e.metaKey || e.ctrlKey || e.shiftKey || e.altKey,
                defaultPrevented: e.defaultPrevented,
                href: anchor.href,
                target: anchor.target,
                download: anchor.hasAttribute('download'),
            };
            if (samePageTop(click, window.location.href)) {
                e.preventDefault();
                window.scrollTo({ top: 0 });
                return;
            }
            const to = fullLoadTarget(click, window.location.href);
            if (to === null) return;
            e.preventDefault();
            window.location.assign(to);
        };
        window.addEventListener('click', onClick, true);
        return () => window.removeEventListener('click', onClick, true);
    }, []);
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
