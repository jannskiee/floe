// The receiver-facing half of a send: the code, the link and the QR.

import {useState} from 'react';
import {Check, Copy, QrCode, Share2} from 'lucide-react';
import QRCode from 'react-qr-code';
import {Eyebrow, cn} from './ui';
import {Tooltip} from './Tooltip';

/** SharePanel is the single share surface, mirroring the browser's ShareLinkPanel:
 *  code hero + a [Copy link] [Show QR] [Share] action row. Shown only while
 *  waiting for the receiver: rooms are one-to-one, so the code is consumed
 *  (dead to anyone else) the moment the receiver joins. Callers gate on the
 *  link because code registration can fail while the link is always valid; the
 *  code hero simply drops out when the code is empty. */
export default function SharePanel({code, link}: {code: string; link: string}) {
    const [copied, setCopied] = useState<'code' | 'link' | null>(null);
    const [qrOpen, setQrOpen] = useState(false);
    async function copy(kind: 'code' | 'link', text: string) {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(kind);
            setTimeout(() => setCopied(null), 1500);
        } catch {
            // clipboard unavailable
        }
    }
    // Mirrors the browser's share handler: user-cancel is not an error; anything
    // else falls back to copying the link.
    async function share() {
        try {
            await navigator.share({url: link});
        } catch (err) {
            if ((err as Error).name !== 'AbortError') copy('link', link);
        }
    }
    // Small centered action buttons mirroring the browser ShareLinkPanel's row;
    // raw buttons because their py-1.5/text-xs sizing conflicts with Button's.
    const actionBtn =
        'inline-flex items-center justify-center gap-1.5 rounded-md border py-1.5 text-xs font-medium transition-all focus-visible:outline-2 focus-visible:outline-ice';
    const actionIdle = 'border-white/10 bg-white/[0.04] text-zinc-400 hover:bg-white/10 hover:text-zinc-100';
    return (
        <div className="animate-floe-in space-y-3 rounded-xl border border-white/[0.08] bg-black/40 p-4">
            {code && (
                <div>
                    <Eyebrow className="mb-2">Room code</Eyebrow>
                    <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-zinc-950 py-2 pl-3 pr-1.5 transition hover:border-white/20">
                        <span className="min-w-0 flex-1 break-all font-mono text-base font-semibold tracking-[0.2em] text-white">{code}</span>
                        <Tooltip label="Copy code" align="end" className="shrink-0">
                            <button
                                onClick={() => copy('code', code)}
                                aria-label="Copy code"
                                className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
                            >
                                {copied === 'code' ? <Check className="size-3.5 text-green-500"/> : <Copy className="size-3.5"/>}
                            </button>
                        </Tooltip>
                    </div>
                </div>
            )}
            <div>
                <Eyebrow className="mb-2">Share link</Eyebrow>
                <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-zinc-950 py-2 pl-3 pr-1.5 transition hover:border-white/20">
                    <code className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed text-zinc-300">{link}</code>
                    <Tooltip label="Copy link" align="end" className="shrink-0">
                        <button
                            onClick={() => copy('link', link)}
                            aria-label="Copy link"
                            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
                        >
                            {copied === 'link' ? <Check className="size-3.5 text-green-500"/> : <Copy className="size-3.5"/>}
                        </button>
                    </Tooltip>
                </div>
            </div>
            <div className="flex items-center justify-center gap-2 pt-0.5">
                <button
                    onClick={() => setQrOpen((o) => !o)}
                    aria-pressed={qrOpen}
                    aria-label="Toggle QR code"
                    className={cn(actionBtn, 'w-24', qrOpen ? 'border-white/20 bg-white/10 text-zinc-100' : actionIdle)}
                >
                    <QrCode className="h-3.5 w-3.5"/>
                    {qrOpen ? 'Hide QR' : 'Show QR'}
                </button>
                {/* Web Share needs webview support: WebView2 (Windows) does not expose
                    it today, so this renders only where the API exists — the same
                    feature gate as the browser app. */}
                {typeof navigator.share === 'function' && (
                    <button onClick={share} aria-label="Share link" className={cn(actionBtn, 'w-20', actionIdle)}>
                        <Share2 className="h-3.5 w-3.5"/>
                        Share
                    </button>
                )}
            </div>
            {qrOpen && (
                <div className="animate-floe-in flex flex-col items-center gap-2 pt-1">
                    <div className="rounded-2xl bg-white p-3 shadow-lg ring-1 ring-white/10">
                        <QRCode value={link} size={128} style={{height: 128, width: 128}} fgColor="#09090b" bgColor="#ffffff" level="M"/>
                    </div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">Scan to receive files</p>
                </div>
            )}
        </div>
    );
}
