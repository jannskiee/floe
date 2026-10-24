import { useId } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Check, CheckCircle2, Copy, Loader2, QrCode, Share2 } from 'lucide-react';
import { shareStatusComplete, shareStatusEnded, verifiedLineShown, type SendEnd } from '@/lib/sendSummary';

interface ShareLinkPanelProps {
    generatedLink: string;
    copied: boolean;
    onCopy: () => void;
    onShare: () => void;
    showQr: boolean;
    onToggleQr: () => void;
    status: string;
    // 'SHA-256 matched' once the receiver reported every file verified, else
    // null. Never a digest value, and never a count (D-101). It picks the
    // check beside the status and is read to screen readers; it is not drawn.
    verifiedLine: string | null;
    // How the send ended, latched by the page (lib/sendSummary.ts). The
    // verified words follow it, because the status sentence is rewritten
    // after a finished send and the words must not go with it.
    sendEnd: SendEnd;
}

/**
 * Sender-side share panel shown once a link exists: the link text, the
 * Copy/QR/Share buttons, the optional QR code, and the live transfer status line.
 * Purely presentational; all state and handlers live in P2PTransfer.
 */
export function ShareLinkPanel({
    generatedLink,
    copied,
    onCopy,
    onShare,
    showQr,
    onToggleQr,
    status,
    verifiedLine,
    sendEnd,
}: ShareLinkPanelProps) {
    const isComplete = shareStatusComplete(status);
    // A status that has ended does not spin: the spinner beside it said the
    // page was still working on something, under a banner saying it was not.
    const hasEnded = shareStatusEnded(status);
    // Gated on the send's own latched end, not on the report alone.
    // onDelivered fires on ANY received frame, and the session's received arm
    // runs whenever one arrives, so a peer that confirms delivery early could
    // otherwise mark a send while the page still says 'Sending: x', and the
    // mark would then sit over a freshly created link until the next peer
    // joined. The peer picks the moment, so the moment is not something to
    // render on. Not gated on the status sentence either: see
    // verifiedLineShown.
    const verified = verifiedLineShown({ verifiedLine, end: sendEnd });
    // The QR button is a disclosure: its words, Show QR or Hide QR, are its
    // name (WCAG 2.5.3, Label in Name), aria-expanded says whether the QR is
    // open, and aria-controls points at this id while the QR block exists.
    const qrId = useId();

    return (
        <div className="rounded-xl bg-black/40 p-4 border border-white/[0.08] mb-4">
            <div className="group">
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500 mb-2">
                    Share link
                </p>
                <div>
                    <code className="block break-all rounded-lg bg-zinc-950 p-3 text-xs text-zinc-300 font-mono border border-white/10 group-hover:border-white/20 transition leading-relaxed">
                        {generatedLink}
                    </code>
                    <div className="flex items-center justify-center gap-2 mt-2.5">
                        <button
                            onClick={onCopy}
                            className="relative before:absolute before:-inset-y-2 before:-inset-x-1 w-20 inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-white/[0.04] hover:bg-white/10 border border-white/10 text-zinc-400 hover:text-zinc-100 text-xs font-medium transition-all focus-visible:outline-2 focus-visible:outline-ice"
                            aria-label="Copy link"
                        >
                            {copied ? (
                                <>
                                    <Check className="h-3.5 w-3.5 text-green-500" />
                                    <span className="text-green-500">Copied</span>
                                </>
                            ) : (
                                <>
                                    <Copy className="h-3.5 w-3.5" />
                                    Copy
                                </>
                            )}
                        </button>
                        <button
                            type="button"
                            onClick={onToggleQr}
                            aria-expanded={showQr}
                            aria-controls={showQr ? qrId : undefined}
                            className={`relative before:absolute before:-inset-y-2 before:-inset-x-1 w-24 inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md border text-xs font-medium transition-all focus-visible:outline-2 focus-visible:outline-ice ${showQr
                                    ? 'bg-white/10 border-white/20 text-zinc-100'
                                    : 'bg-white/[0.04] hover:bg-white/10 border-white/10 text-zinc-400 hover:text-zinc-100'
                                }`}
                        >
                            <QrCode className="h-3.5 w-3.5" />
                            {showQr ? 'Hide QR' : 'Show QR'}
                        </button>
                        {typeof navigator !== 'undefined' && !!navigator.share && (
                            <button
                                onClick={onShare}
                                className="relative before:absolute before:-inset-y-2 before:-inset-x-1 w-20 inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-white/[0.04] hover:bg-white/10 border border-white/10 text-zinc-400 hover:text-zinc-100 text-xs font-medium transition-all focus-visible:outline-2 focus-visible:outline-ice"
                                aria-label="Share link"
                            >
                                <Share2 className="h-3.5 w-3.5" />
                                Share
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {showQr && (
                <div id={qrId} className="mt-3 flex flex-col items-center gap-2 animate-in fade-in slide-in-from-top-2 duration-200">
                    <div className="rounded-2xl bg-white p-4 shadow-lg ring-1 ring-white/10">
                        <QRCodeSVG
                            value={generatedLink}
                            size={156}
                            bgColor="#ffffff"
                            fgColor="#09090b"
                            level="M"
                        />
                    </div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">Scan to receive files</p>
                </div>
            )}

            <div className="mt-3 flex w-full items-center justify-center gap-2 text-xs transition-colors duration-300">
                {/* The desktop's rule (D-161): green only once the receiver
                    reported every file's SHA-256 matched, a gray plain check
                    for a send that finished without that report. A browser
                    sender says "All Files Sent!" when the last byte leaves,
                    and the report lands after it, so a current receiver turns
                    the gray check green a moment later; an older one never
                    does. */}
                {isComplete ? (
                    verified ? (
                        <CheckCircle2 data-mark="verified" className="h-3 w-3 shrink-0 text-green-400" />
                    ) : (
                        <Check data-mark="plain" className="h-3 w-3 shrink-0 text-zinc-500" />
                    )
                ) : hasEnded ? null : (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-zinc-500" />
                )}
                {/* Wraps instead of cutting at 200 px: two of the fixed
                    sentences are wider than that on every phone (measured
                    212 and 241 px in 12 px Geist, 320 to 430 wide). Two lines
                    at most, so a long name in "Sending: <name>" still stops. */}
                <span
                    className={`min-w-0 line-clamp-2 break-words text-balance text-center ${isComplete ? (verified ? 'text-green-400 font-medium' : 'text-zinc-300 font-medium') : 'text-zinc-500'}`}
                >
                    {status}
                </span>
            </div>

            {/* The words the green check stands for, for screen readers only:
                it was a visible line until the check carried it. A sibling of
                the status line, not part of it: the audit anchors on the
                sender's completion status as its own text, and that string
                must stay byte for byte what it is. It stays when a finished
                send's status is rewritten, as the report it reads does; the
                check goes with the status's own mark. */}
            {verified && <p className="sr-only">{verifiedLine}</p>}
        </div>
    );
}
