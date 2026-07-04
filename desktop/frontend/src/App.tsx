import {useEffect, useRef, useState} from 'react';
import type {MutableRefObject, ReactNode} from 'react';
import {ReceiveByCode, SelectFiles, SelectFolder, OpenFolder, StartSend} from "../wailsjs/go/main/App";
import {EventsOn, EventsOff, OnFileDrop, OnFileDropOff, BrowserOpenURL} from "../wailsjs/runtime/runtime";
import {
    AlertCircle,
    Check,
    Copy,
    Download,
    Files,
    FileText,
    Folder,
    FolderOpen,
    Loader2,
    Send,
    Server,
    ShieldCheck,
    UploadCloud,
    Zap,
} from 'lucide-react';
import {BoltMark, Button, Card, Input, cn} from './components/ui';

type Mode = 'send' | 'receive';

interface Prog {
    fileName: string;
    fileIndex: number;
    fileCount: number;
    fileBytes: number;
    fileSize: number;
    totalBytes: number;
    grandTotal: number;
}

type Marker = {t: number; bytes: number} | null;

function fmtBytes(n: number): string {
    if (!n || n < 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

function fmtSpeed(bps: number): string {
    if (!isFinite(bps) || bps <= 0) return '';
    return bps >= 1024 * 1024 ? (bps / 1048576).toFixed(1) + ' MB/s' : (bps / 1024).toFixed(0) + ' KB/s';
}

function fmtEta(sec: number): string {
    if (!isFinite(sec) || sec < 0) return '';
    if (sec < 60) return `${Math.ceil(sec)}s`;
    return `${Math.floor(sec / 60)}m ${Math.ceil(sec % 60)}s`;
}

// track computes percent, speed, and ETA for a progress event. It uses an
// average-since-start speed (stable) keyed off a per-transfer marker ref.
function track(ref: MutableRefObject<Marker>, p: Prog): {pct: number; label: string} {
    const denom = p.grandTotal > 0 ? p.grandTotal : p.fileSize;
    const num = p.grandTotal > 0 ? p.totalBytes : p.fileBytes;
    const pct = denom > 0 ? Math.min(100, Math.round((num / denom) * 100)) : 0;

    const now = Date.now();
    if (!ref.current) ref.current = {t: now, bytes: num};
    const dt = (now - ref.current.t) / 1000;
    const speed = dt > 0.2 ? (num - ref.current.bytes) / dt : 0;
    const eta = speed > 0 ? (denom - num) / speed : Infinity;

    const tag = p.fileCount > 1 ? `[${p.fileIndex}/${p.fileCount}] ` : '';
    let label = `${tag}${p.fileName} - ${pct}%  (${fmtBytes(num)} / ${fmtBytes(denom)})`;
    const s = fmtSpeed(speed);
    const e = fmtEta(eta);
    if (s) label += `  ·  ${s}`;
    if (e && pct < 100) label += `  ·  ETA ${e}`;
    return {pct, label};
}

function ProgressRow({prog}: {prog: {pct: number; label: string}}) {
    return (
        <div className="animate-floe-in space-y-1.5">
            <div className="truncate font-mono text-xs text-zinc-400">{prog.label}</div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                    className="h-full rounded-full bg-zinc-200 transition-[width] duration-150"
                    style={{width: `${prog.pct}%`}}
                />
            </div>
        </div>
    );
}

function VerifyRow({code, peer}: {code: string; peer: 'sender' | 'receiver'}) {
    return (
        <div className="animate-floe-in flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-400">
            <ShieldCheck className="size-3.5 text-zinc-500"/>
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Verify</span>
            <span className="font-mono text-sm font-semibold tracking-wider text-zinc-200">{code}</span>
            <span className="text-zinc-500">confirm it matches the {peer}</span>
        </div>
    );
}

function StatusLine({text, busy}: {text: string; busy: boolean}) {
    const isError = text.startsWith('Error');
    return (
        <p className={cn('flex min-h-5 items-center justify-center gap-2 text-center text-sm', isError ? 'text-red-400' : 'text-zinc-400')}>
            {busy && <Loader2 className="size-3.5 shrink-0 animate-spin"/>}
            {isError && <AlertCircle className="size-3.5 shrink-0"/>}
            <span>{text}</span>
        </p>
    );
}

function App() {
    const [mode, setMode] = useState<Mode>('send');
    const [hideIP, setHideIP] = useState(false);

    // Send state
    const [files, setFiles] = useState<string[]>([]);
    const [sendCode, setSendCode] = useState('');
    const [sendLink, setSendLink] = useState('');
    const [sendStatus, setSendStatus] = useState('Select or drag files, then click Send.');
    const [sending, setSending] = useState(false);
    const [sendProg, setSendProg] = useState<{pct: number; label: string} | null>(null);
    const [sendVerify, setSendVerify] = useState('');
    const [copied, setCopied] = useState(false);
    const sendStart = useRef<Marker>(null);

    // Receive state
    const [code, setCode] = useState('');
    const [output, setOutput] = useState('');
    const [recvStatus, setRecvStatus] = useState('Enter a code or link, then click Receive.');
    const [receiving, setReceiving] = useState(false);
    const [recvProg, setRecvProg] = useState<{pct: number; label: string} | null>(null);
    const [recvDir, setRecvDir] = useState('');
    const [recvVerify, setRecvVerify] = useState('');
    const recvStart = useRef<Marker>(null);

    useEffect(() => {
        EventsOn('send:code', (data: {code: string; link: string}) => {
            setSendCode(data.code);
            setSendLink(data.link);
            setSendStatus('Share this code or link, then wait for the receiver to connect...');
        });
        EventsOn('send:status', (msg: string) => setSendStatus(msg));
        EventsOn('send:progress', (p: Prog) => setSendProg(track(sendStart, p)));
        EventsOn('send:verify', (c: string) => setSendVerify(c));
        EventsOn('send:done', (msg: string) => {
            setSendStatus(msg);
            setSendProg({pct: 100, label: 'Complete.'});
            setSending(false);
        });
        EventsOn('send:error', (msg: string) => {
            setSendStatus('Error: ' + msg);
            setSending(false);
        });
        EventsOn('recv:progress', (p: Prog) => setRecvProg(track(recvStart, p)));
        EventsOn('recv:verify', (c: string) => setRecvVerify(c));
        // Native file drop on the whole window (useDropTarget=false). Paths arrive
        // already resolved to absolute paths from the Go side.
        OnFileDrop((_x, _y, paths) => {
            if (paths && paths.length) {
                setMode('send');
                setFiles(paths);
                setSendStatus(`${paths.length} file(s) ready. Click Send.`);
            }
        }, false);
        return () => {
            EventsOff('send:code');
            EventsOff('send:status');
            EventsOff('send:progress');
            EventsOff('send:verify');
            EventsOff('send:done');
            EventsOff('send:error');
            EventsOff('recv:progress');
            EventsOff('recv:verify');
            OnFileDropOff();
        };
    }, []);

    async function pickFiles() {
        try {
            const picked = await SelectFiles();
            if (picked && picked.length) {
                setFiles(picked);
                setSendStatus(`${picked.length} file(s) ready. Click Send.`);
            }
        } catch {
            // dialog cancelled
        }
    }

    async function pickSendFolder() {
        try {
            const dir = await SelectFolder();
            if (dir) {
                setFiles([dir]);
                setSendStatus('1 folder ready. Click Send.');
            }
        } catch {
            // dialog cancelled
        }
    }

    async function pickSaveFolder() {
        try {
            const dir = await SelectFolder();
            if (dir) setOutput(dir);
        } catch {
            // dialog cancelled
        }
    }

    async function copyLink() {
        try {
            await navigator.clipboard.writeText(sendLink);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // clipboard unavailable
        }
    }

    async function send() {
        if (!files.length) {
            setSendStatus('Select at least one file first.');
            return;
        }
        setSending(true);
        setSendCode('');
        setSendLink('');
        setSendProg(null);
        setSendVerify('');
        sendStart.current = null;
        setSendStatus('Setting up...');
        try {
            await StartSend(files, hideIP);
        } catch (e: any) {
            setSendStatus('Error: ' + e);
            setSending(false);
        }
    }

    async function receive() {
        if (!code.trim()) {
            setRecvStatus('Please enter a code or link.');
            return;
        }
        setReceiving(true);
        setRecvProg(null);
        setRecvDir('');
        setRecvVerify('');
        recvStart.current = null;
        setRecvStatus('Connecting... keep this window open.');
        try {
            const dir = await ReceiveByCode(code.trim(), output.trim(), hideIP);
            setRecvDir(dir);
            setRecvStatus('Done. Files saved to: ' + dir);
        } catch (e: any) {
            setRecvStatus('Error: ' + e);
        } finally {
            setReceiving(false);
        }
    }

    const tab = (m: Mode, label: string, icon: ReactNode) => (
        <button
            onClick={() => setMode(m)}
            className={cn(
                'flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                mode === m ? 'bg-white text-black' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200',
            )}
        >
            {icon} {label}
        </button>
    );

    return (
        <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-100 selection:bg-white/20">

            {/* ── LEFT RAIL: brand + hero ─────────────────────────────────────── */}
            <aside className="relative flex w-[42%] max-w-[440px] shrink-0 flex-col overflow-hidden border-r border-white/5 bg-zinc-950">
                {/* ambient glow */}
                <div
                    aria-hidden
                    className="pointer-events-none absolute left-1/4 top-1/3 h-[360px] w-[360px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/[0.04] blur-3xl"
                />
                {/* giant watermark bolt */}
                <BoltMark
                    aria-hidden
                    className="pointer-events-none absolute -bottom-8 -right-8 size-64 rotate-12 text-white/[0.025]"
                />

                {/* top: brand lockup */}
                <div className="relative flex items-center gap-2.5 p-8 pb-0">
                    <BoltMark className="size-5 text-white"/>
                    <span className="text-lg font-bold tracking-tight text-white">Floe</span>
                    <span className="rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-widest text-zinc-500">
                        Desktop
                    </span>
                </div>

                {/* middle: hero content — vertically centered in remaining space */}
                <div className="relative flex flex-1 flex-col justify-center px-8 py-6">
                    <h1 className="text-3xl font-extrabold tracking-tighter text-white">
                        Send anything,<br/>peer to peer.
                    </h1>
                    <p className="mt-3 text-sm leading-relaxed text-zinc-400">
                        End-to-end encrypted. No accounts,<br/>no storage, no middleman.
                    </p>

                    <div className="mt-8 space-y-4">
                        {[
                            {icon: <ShieldCheck className="size-4 text-white"/>, label: 'End-to-end encrypted', note: 'DTLS + SRTP, same as video calls'},
                            {icon: <Zap className="size-4 text-white"/>, label: 'Direct, unlimited transfers', note: 'P2P — files never touch a server'},
                            {icon: <Server className="size-4 text-white"/>, label: 'Nothing stored on a server', note: 'The relay only brokers the handshake'},
                        ].map(({icon, label, note}) => (
                            <div key={label} className="flex items-start gap-3">
                                <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900">
                                    {icon}
                                </span>
                                <div>
                                    <p className="text-sm font-medium text-zinc-200">{label}</p>
                                    <p className="text-xs text-zinc-500">{note}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* bottom: footer links */}
                <div className="relative flex items-center gap-4 p-8 pt-0">
                    <button
                        onClick={() => BrowserOpenURL('https://github.com/jannskiee/floe')}
                        className="text-xs text-zinc-500 transition-colors hover:text-zinc-300"
                    >
                        Open source
                    </button>
                    <span className="text-zinc-800">·</span>
                    <button
                        onClick={() => BrowserOpenURL('https://docs.floe.one')}
                        className="text-xs text-zinc-500 transition-colors hover:text-zinc-300"
                    >
                        Docs
                    </button>
                </div>
            </aside>

            {/* ── RIGHT CONSOLE: the working UI ───────────────────────────────── */}
            <main className="custom-scrollbar flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-md space-y-5 px-8 py-10">

                    {/* Send / Receive tabs */}
                    <div className="grid grid-cols-2 gap-1 rounded-lg border border-zinc-800 bg-zinc-900/80 p-1">
                        {tab('send', 'Send', <Send className="size-4"/>)}
                        {tab('receive', 'Receive', <Download className="size-4"/>)}
                    </div>

                    {/* Hide my IP */}
                    <label className="group/hideip flex cursor-pointer select-none items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                        <input
                            type="checkbox"
                            checked={hideIP}
                            onChange={(e) => setHideIP(e.target.checked)}
                            className="sr-only"
                        />
                        <span
                            className={cn(
                                'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition-all',
                                hideIP ? 'border-white bg-white' : 'border-zinc-600 bg-transparent group-hover/hideip:border-zinc-400',
                            )}
                        >
                            {hideIP && (
                                <svg viewBox="0 0 10 8" fill="none" className="h-2.5 w-2.5">
                                    <path d="M1 4l2.5 2.5L9 1" stroke="#09090b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                            )}
                        </span>
                        <span className="space-y-0.5">
                            <span className="block text-sm font-medium leading-none text-zinc-200">Hide my IP</span>
                            <span className="block text-xs text-zinc-500">Route through the relay so the peer never sees your IP.</span>
                        </span>
                    </label>

                    {/* ── SEND VIEW ─────────────────────────────────────────────── */}
                    {mode === 'send' ? (
                        <div className="space-y-4">
                            {/* drop zone */}
                            <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-zinc-700 bg-zinc-900/40 p-6 text-center transition-colors hover:border-white/30 hover:bg-zinc-900/60">
                                <span className="rounded-full bg-zinc-800 p-3">
                                    <UploadCloud className="size-6 text-zinc-400"/>
                                </span>
                                <div className="flex w-full gap-2">
                                    <Button variant="outline" className="flex-1" onClick={pickFiles} disabled={sending}>
                                        <Files/> Select files
                                    </Button>
                                    <Button variant="outline" className="flex-1" onClick={pickSendFolder} disabled={sending}>
                                        <Folder/> Select folder
                                    </Button>
                                </div>
                                <p className="text-xs text-zinc-500">or drag files onto the window</p>
                            </div>

                            {/* file list */}
                            {files.length > 0 && (
                                <ul className="animate-floe-in custom-scrollbar max-h-40 divide-y divide-zinc-800 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900/40">
                                    {files.map((f) => (
                                        <li key={f} className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-300">
                                            <FileText className="size-4 shrink-0 text-zinc-500"/>
                                            <span className="truncate">{f.split(/[\\/]/).pop()}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}

                            {/* send button */}
                            <Button className="w-full" onClick={send} disabled={sending || !files.length}>
                                {sending
                                    ? <><Loader2 className="animate-spin"/> Sending...</>
                                    : <><Send/> Send{files.length ? ` (${files.length})` : ''}</>
                                }
                            </Button>

                            {/* room code */}
                            {sendCode && (
                                <div className="animate-floe-in space-y-1 rounded-lg border border-zinc-800 bg-black/40 p-4 text-center">
                                    <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Room code</p>
                                    <div className="font-mono text-2xl font-bold tracking-[0.2em] text-white">{sendCode}</div>
                                </div>
                            )}

                            {/* share link */}
                            {sendLink && (
                                <div className="animate-floe-in space-y-2 rounded-lg border border-zinc-800 bg-black/40 p-3">
                                    <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Share link</p>
                                    <code className="block break-all rounded border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-xs text-zinc-300">
                                        {sendLink}
                                    </code>
                                    <Button
                                        variant="secondary"
                                        className="w-full"
                                        onClick={copyLink}
                                    >
                                        {copied
                                            ? <><Check className="size-3.5 text-green-500"/> <span className="text-green-500">Copied</span></>
                                            : <><Copy className="size-3.5"/> Copy link</>
                                        }
                                    </Button>
                                </div>
                            )}

                            {sendProg && <ProgressRow prog={sendProg}/>}
                            {sendVerify && <VerifyRow code={sendVerify} peer="receiver"/>}
                            <StatusLine text={sendStatus} busy={sending}/>
                        </div>

                    ) : (
                    /* ── RECEIVE VIEW ─────────────────────────────────────────── */
                        <div className="space-y-4">
                            <Input
                                placeholder="code or link (e.g. olive-tiger-castle)"
                                value={code}
                                onChange={(e) => setCode(e.target.value)}
                                disabled={receiving}
                                autoComplete="off"
                            />
                            <div className="flex gap-2">
                                <Input
                                    className="flex-1"
                                    placeholder="save to folder (blank = Downloads)"
                                    value={output}
                                    onChange={(e) => setOutput(e.target.value)}
                                    disabled={receiving}
                                    autoComplete="off"
                                />
                                <Button variant="outline" onClick={pickSaveFolder} disabled={receiving}>
                                    <Folder/> Browse
                                </Button>
                            </div>

                            <Button className="w-full" onClick={receive} disabled={receiving}>
                                {receiving
                                    ? <><Loader2 className="animate-spin"/> Receiving...</>
                                    : <><Download/> Receive</>
                                }
                            </Button>

                            {recvProg && <ProgressRow prog={recvProg}/>}
                            {recvVerify && <VerifyRow code={recvVerify} peer="sender"/>}
                            {recvDir && !receiving && (
                                <Button variant="outline" className="animate-floe-in w-full" onClick={() => { OpenFolder(recvDir).catch(() => {}); }}>
                                    <FolderOpen/> Show in folder
                                </Button>
                            )}
                            <StatusLine text={recvStatus} busy={receiving}/>
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
}

export default App;
