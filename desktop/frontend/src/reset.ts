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
 * original reason the dialog exists. "In flight" means a progress object that
 * has not been cleared, so every path that ends a transfer (done, cancel,
 * error) has to null its progress or this branch keeps firing for a transfer
 * that died minutes ago, and outranks the note warning while it does.
 *
 * A note in the box that has not gone out, because doReset calls setSendText('')
 * and a typed note is written to no file and no storage key. It exists in that
 * one state field and nowhere else, so clearing it is the only thing Start over
 * does that the user cannot simply redo. Staged files are deliberately NOT in
 * this list: doReset clears those too, but the paths are still on disk and
 * re-picking them is tedious rather than destructive.
 *
 * sentText is what the last completed send actually put on the wire, and
 * comparing the box against it is what makes that judgement exact. This used to
 * be a justSent boolean, which asked "did a send finish?" rather than "is this
 * the note that went?". Those are different questions, and the gap between them
 * was two states where the box held something nobody had sent and Start over
 * destroyed it in silence: a note typed after a completed send (the textarea
 * stays mounted and editable once send:done lands), and a note typed and then
 * abandoned in favour of sending files, which is not even on screen at the
 * time. Compared trimmed, so a trailing newline on the note you just sent is
 * not a new note.
 *
 * Only a completed send may write sentText, which is what separates "delivered"
 * from "attempted": a send that fails or is cancelled leaves the note unsent,
 * and it still earns its prompt.
 *
 * busy is the one gate that keeps the prompt off a path where it would be
 * noise, because a send that is connecting or waiting for a peer still holds
 * its text and file list, and a dialog in front of the escape hatch that exists
 * FOR stuck states would defeat it.
 *
 * Two omissions that are decisions rather than oversights, written down so
 * nobody has to guess.
 *
 * The room code typed on the Receive tab is not an input here. doReset clears
 * it, but unlike a note it is a reference to something that still exists
 * elsewhere: the sender's screen, the message it arrived in, usually the
 * clipboard. That puts it with staged files rather than with the note.
 *
 * There is no receive-side twin of sentText. A finished receive says nothing
 * about a note staged on the Send tab, so gating on one would suppress a
 * warning that is simply true.
 */
export function resetWarning(s: {
    transferring: boolean;
    busy: boolean;
    text: string;
    sentText: string;
}): string {
    if (s.transferring) return 'A transfer is in progress. Starting over will cancel it.';
    if (s.busy) return '';
    const t = s.text.trim();
    // Trimmed on both sides, like the emptiness test it shares a line with: a
    // note that differs from the one that went out by trailing whitespace is
    // not lost work.
    if (t === '' || t === s.sentText.trim()) return '';
    return 'The text you typed has not been sent yet. Starting over will clear it.';
}
