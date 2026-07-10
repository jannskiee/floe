import { QRCodeSVG } from 'qrcode.react';
import { Check, CheckCircle2, Copy, Loader2, QrCode, Share2 } from 'lucide-react';

interface ShareLinkPanelProps {
    generatedLink: string;
    copied: boolean;
    onCopy: () => void;
    onShare: () => void;
    showQr: boolean;
    onToggleQr: () => void;
    status: string;
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
}: ShareLinkPanelProps) {
    const isComplete = status === 'All Files Sent!' || status.includes('Transfer complete');

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
                            className="w-20 inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-white/[0.04] hover:bg-white/10 border border-white/10 text-zinc-400 hover:text-zinc-100 text-xs font-medium transition-all focus-visible:outline-2 focus-visible:outline-ice"
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
                            onClick={onToggleQr}
                            className={`w-24 inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md border text-xs font-medium transition-all focus-visible:outline-2 focus-visible:outline-ice ${showQr
                                    ? 'bg-white/10 border-white/20 text-zinc-100'
                                    : 'bg-white/[0.04] hover:bg-white/10 border-white/10 text-zinc-400 hover:text-zinc-100'
                                }`}
                            aria-label="Toggle QR code"
                        >
                            <QrCode className="h-3.5 w-3.5" />
                            {showQr ? 'Hide QR' : 'Show QR'}
                        </button>
                        {typeof navigator !== 'undefined' && !!navigator.share && (
                            <button
                                onClick={onShare}
                                className="w-20 inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-white/[0.04] hover:bg-white/10 border border-white/10 text-zinc-400 hover:text-zinc-100 text-xs font-medium transition-all focus-visible:outline-2 focus-visible:outline-ice"
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
                <div className="mt-3 flex flex-col items-center gap-2 animate-in fade-in slide-in-from-top-2 duration-200">
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
                {isComplete ? (
                    <CheckCircle2 className="h-3 w-3 shrink-0 text-green-400" />
                ) : (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-zinc-500" />
                )}
                <span
                    className={`truncate max-w-[200px] sm:max-w-[280px] ${isComplete ? 'text-green-400 font-medium' : 'text-zinc-500'}`}
                >
                    {status}
                </span>
            </div>
        </div>
    );
}
