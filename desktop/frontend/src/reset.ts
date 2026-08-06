// Pure helper for the Start over confirmation. It lives outside App.tsx for the
// same reason settings.ts does: so it can be tested without a DOM or the Wails
// runtime bindings, which do not exist outside the WebView.

/**
 * resetWarning returns the sentence the Start over dialog should show, or ''
 * when the reset is not worth interrupting. Callers read '' as "just do it".
 *
 * Two states earn a prompt, and only two.
 *
 * Bytes in flight, because the reset cancels a live transfer. That is the
 * original reason the dialog exists.
 *
 * An unsent text note while idle, because doReset calls setSendText('') and a
 * typed note is written to no file and no storage key. It exists in that one
 * state field and nowhere else, so clearing it is the only thing Start over
 * does that the user cannot simply redo. Staged files are deliberately NOT in
 * this list: doReset clears those too, but the paths are still on disk and
 * re-picking them is tedious rather than destructive.
 *
 * Two gates keep the prompt off paths where it would be noise:
 *
 * busy, because a send that is connecting or waiting for a peer still holds its
 * text and file list, and a dialog in front of the escape hatch that exists FOR
 * stuck states would defeat it.
 *
 * justSent, because send:done clears neither the text nor the files. Without
 * this gate, the single most common gesture in the app, clicking the lockup to
 * tidy up after a transfer completes, would throw a modal every time.
 */
export function resetWarning(s: {
    transferring: boolean;
    busy: boolean;
    justSent: boolean;
    text: string;
}): string {
    if (s.transferring) return 'A transfer is in progress. Starting over will cancel it.';
    if (s.busy || s.justSent) return '';
    if (s.text.trim() === '') return '';
    return 'The text you typed has not been sent yet. Starting over will clear it.';
}
