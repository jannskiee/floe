// One copy path for the three buttons that had three. The point of the module
// is not that copying is hard, it is that FAILING to copy was reported three
// different ways: P2PTransfer let an execCommand throw escape as an unhandled
// rejection and leaked the textarea it had appended, InAppBrowserGuard
// swallowed the same throw and then said "Link copied" anyway, and InstallTabs
// had no fallback at all. A caller cannot render an honest label off a helper
// that does not tell it what happened, so this one returns a boolean and never
// throws.

/**
 * Writes `text` to the system clipboard and reports whether it actually landed
 * there. Never throws and never rejects: every failure is a `false`, so a
 * caller cannot show "Copied" for a copy that did not happen.
 *
 * The caller keeps its own copied flag and its own reset timer. This helper
 * owns no UI state on purpose, because the three call sites label and time
 * their feedback differently and unifying that too would be a redesign.
 */
export async function copyText(text: string): Promise<boolean> {
    // Read the globals inside the body rather than at module scope. A test
    // stubs them after this module is imported, and a module-scope capture
    // would hold the pre-stub value forever.
    //
    // The property reads sit INSIDE the try, not just the call. Optional
    // chaining keeps a missing clipboard API an ordinary branch rather than a
    // caught TypeError, which is what makes the insecure-context case
    // assertable; it does not help when the property itself is a throwing
    // getter, and a helper whose contract is "never throws" has to survive
    // that too.
    try {
        const clip = globalThis.navigator?.clipboard;
        if (clip && typeof clip.writeText === 'function') {
            await clip.writeText(text);
            return true;
        }
    } catch {
        // Denied by permissions policy, or the document was not focused.
        // Both are recoverable by the textarea path below.
    }

    if (typeof document === 'undefined' || !document.body) return false;

    // select() moves focus into the textarea, and removing a focused node
    // drops focus to the page body, so a keyboard user who pressed Copy lost
    // their place whether or not the copy worked. Note who held focus now and
    // hand it back once the textarea is gone. Only this path does it: the
    // clipboard API above never moves focus.
    const previous = activeElementOf(document);

    let textarea: HTMLTextAreaElement | null = null;
    try {
        textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        // The return value is the whole reason this module exists. Both copies
        // this replaces discarded it and then reported success regardless.
        return document.execCommand('copy') === true;
    } catch {
        return false;
    } finally {
        // remove(), not document.body.removeChild(). removeChild throws
        // NotFoundError when appendChild is the call that threw, which would
        // turn a failed copy into a second exception; remove() on a node with
        // no parent is a specified no-op. In a finally so that no path, including
        // a throw from createElement, select or execCommand, can leave the
        // node attached. Both replaced copies removed it on the happy line
        // only, which is exactly why both leaked.
        textarea?.remove();
        // After the remove, never before execCommand: the copy reads the
        // textarea's selection, so it has to hold focus while the copy runs.
        // Synchronous, so focus is back by the time the promise resolves.
        restoreFocus(previous);
    }
}

/** document.activeElement, or null when reading it throws. */
function activeElementOf(doc: Document): Element | null {
    try {
        return doc.activeElement ?? null;
    } catch {
        return null;
    }
}

/**
 * Gives focus back to `previous` if the fallback took it away. Does nothing
 * when nothing but the page held focus, when focus is already there, or when
 * `previous` cannot take focus. A duck-typed check, not `instanceof
 * HTMLElement`, because the unit tests run in Node, which has no such global.
 * Swallows any throw: a failed restore must not turn a copy into a rejection.
 */
function restoreFocus(previous: Element | null): void {
    try {
        if (!previous || previous === document.body) return;
        if (activeElementOf(document) === previous) return;
        const target = previous as Partial<HTMLElement>;
        if (typeof target.focus !== 'function') return;
        // preventScroll: the control was in view when it was pressed, and
        // the page should not jump to bring it back into view.
        target.focus({ preventScroll: true });
    } catch {
        // Focus is a courtesy here; the copy's result stands either way.
    }
}
