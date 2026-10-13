// What Sentry is sent for a throw inside the receiver.
//
// A throw there is a bug of this code's own (receiveFailure.ts sorts the other
// kinds out first), and the page used to hand Sentry the thrown value as it
// was. The frames being handled when it threw are the other device's, though,
// and an engine is free to quote a value in the message of the error it
// throws: V8 quotes its input in a JSON.parse failure and in a BigInt one. No
// throw in the receiver is known to carry a peer's bytes that way. Nothing
// here depends on that staying true for every engine and every version: the
// message never leaves.
//
// What does leave is what finds the bug and is this code's own: the class of
// the error and the positions in its stack. Pure and SDK-free, so vitest can
// cover it.

/** The message of every report. Sentry groups by stack, so one sentence for
 *  all of them costs nothing. */
export const INTERNAL_REPORT_MESSAGE = 'The receiver failed while it was handling a frame';

// A class name as an engine or the DOM writes one: TypeError, RangeError,
// QuotaExceededError. Anything else is reported as a plain Error.
const CLASS_NAME = /^[A-Z][A-Za-z]{2,39}$/;

/**
 * An Error with fixed words for a message, the thrown error's class name when
 * it reads as one, and its stack frames when they can be told apart from its
 * message.
 *
 * V8 writes "Name: message" on top of `stack` and the frames under it, so the
 * frames are whatever follows that exact header. Firefox and Safari write
 * frames only. A stack that does not start with the header and still holds
 * the message somewhere is not one this function can cut safely, and it is
 * left out rather than guessed at.
 *
 * It never throws: it runs inside the page's handler for a failure, where a
 * second throw would cost the person their message.
 */
export function reportableCause(err: unknown): Error {
    let name = 'Error';
    let frames = '';
    try {
        if (err instanceof Error) {
            const rawName: unknown = err.name;
            const message: unknown = err.message;
            const stack: unknown = err.stack;
            if (typeof rawName === 'string' && CLASS_NAME.test(rawName)) name = rawName;
            if (typeof stack === 'string' && typeof rawName === 'string' && typeof message === 'string') {
                const header = message === '' ? rawName : `${rawName}: ${message}`;
                if (stack.startsWith(`${header}\n`)) frames = stack.slice(header.length + 1);
                else if (message === '' || !stack.includes(message)) frames = stack === header ? '' : stack;
            }
        }
    } catch {
        // A getter that throws, or a proxy: the report goes without frames.
        frames = '';
    }
    const report = new Error(INTERNAL_REPORT_MESSAGE);
    report.name = name;
    report.stack = frames ? `${name}: ${INTERNAL_REPORT_MESSAGE}\n${frames}` : `${name}: ${INTERNAL_REPORT_MESSAGE}`;
    return report;
}
