import {useEffect, useRef, useState} from 'react';
import type {CSSProperties, MutableRefObject} from 'react';
import {
    CancelTransfer,
    ContextMenuEnabled,
    DisableContextMenu,
    EnableContextMenu,
    EngineProtocolVersion,
    GetPendingFiles,
    GetVersion,
    OpenFolder,
    ReceiveByCode,
    SelectFiles,
    SelectFolder,
    StartSend,
    StartSendText,
} from "../wailsjs/go/main/App";
import {EventsOn, EventsOff, OnFileDrop, OnFileDropOff, BrowserOpenURL} from "../wailsjs/runtime/runtime";
import {
    AlertCircle,
    ArrowDownLeft,
    ArrowLeft,
    ArrowUpRight,
    Check,
    ChevronDown,
    Copy,
    Download,
    Files,
    Folder,
    FolderOpen,
    Loader2,
    QrCode,
    Send,
    Share2,
    UploadCloud,
    X,
} from 'lucide-react';
import QRCode from 'react-qr-code';
import {BoltMark, Button, Eyebrow, Input, StatusDot, cn} from './components/ui';
import TitleBar from './components/TitleBar';
import FileIcon from './components/FileIcon';

type Mode = 'send' | 'receive' | 'history';

// One completed transfer, persisted locally in localStorage['floe:history'].
interface HistEntry {
    kind: 'send' | 'recv';
    names: string[];
    count: number;
    dir?: string;
    at: number;
}

const HISTORY_CAP = 50;

function loadHistory(): HistEntry[] {
    // A corrupted store must never break the app; fall back to empty.
    try {
        const raw = JSON.parse(localStorage.getItem('floe:history') || '[]');
        return Array.isArray(raw) ? raw : [];
    } catch {
        return [];
    }
}

// fmtWhen renders a history timestamp as "Today · 19:55", "Yesterday · 09:12",
// or "Jul 19 · 19:55", comparing calendar days (not 24h windows).
function fmtWhen(ts: number): string {
    const d = new Date(ts);
    const now = new Date();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const day =
        d.toDateString() === now.toDateString() ? 'Today' :
        d.toDateString() === yesterday.toDateString() ? 'Yesterday' :
        `${d.toLocaleString('en', {month: 'short'})} ${d.getDate()}`;
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${day} · ${hh}:${mm}`;
}

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
        <div className="animate-floe-in space-y-2">
            <div className="flex items-baseline justify-between gap-3 font-mono text-[11px] text-zinc-400">
                <span className="truncate">{prog.label}</span>
                <span className="shrink-0 text-zinc-500">{prog.pct}%</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
                <div
                    className="h-full rounded-full bg-white transition-[width] duration-150"
                    style={{width: `${prog.pct}%`}}
                />
            </div>
        </div>
    );
}

function StatusLine({text, busy}: {text: string; busy: boolean}) {
    if (!text) return null;
    const isError = text.startsWith('Error');
    return (
        <p className={cn('flex min-h-5 items-center justify-center gap-2 text-center text-xs', isError ? 'text-red-400' : 'text-zinc-500')}>
            {busy && <Loader2 className="size-3.5 shrink-0 animate-spin"/>}
            {isError && <AlertCircle className="size-3.5 shrink-0"/>}
            <span>{text}</span>
        </p>
    );
}

// Windows paths compare case-insensitively; normalize for dedupe and removal but
// keep the original strings for display and for the Go side.
const isWindows = navigator.userAgent.includes('Windows');
const normPath = (p: string) => (isWindows ? p.toLowerCase() : p);
const baseName = (p: string) => p.split(/[\\/]/).pop();

function mergePaths(prev: string[], add: string[]): string[] {
    const seen = new Set(prev.map(normPath));
    const out = [...prev];
    for (const p of add) {
        if (!seen.has(normPath(p))) {
            seen.add(normPath(p));
            out.push(p);
        }
    }
    return out;
}

/** Switch is the settings toggle: a small track/thumb pair driven by an
 *  sr-only checkbox so keyboard and screen-reader behavior come for free. */
function Switch({checked, onChange}: {checked: boolean; onChange: (v: boolean) => void}) {
    return (
        <span className="relative inline-flex shrink-0">
            <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                className="peer sr-only"
            />
            <span
                className={cn(
                    'relative h-5 w-9 rounded-full transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ice/60',
                    checked ? 'bg-white' : 'bg-white/10 ring-1 ring-inset ring-white/15',
                )}
            >
                <span
                    className={cn(
                        'absolute left-0.5 top-0.5 size-4 rounded-full transition-transform',
                        checked ? 'translate-x-4 bg-zinc-950' : 'bg-zinc-400',
                    )}
                />
            </span>
        </span>
    );
}

/** SettingRow is one settings entry: stacked label and description with a
 *  trailing switch, sized so long descriptions wrap instead of truncating. */
function SettingRow({checked, onChange, label, description}: {
    checked: boolean;
    onChange: (v: boolean) => void;
    label: string;
    description: string;
}) {
    return (
        <label className="flex cursor-pointer select-none items-center justify-between gap-4 p-3.5">
            <span className="min-w-0">
                <span className="block text-sm font-medium text-zinc-200">{label}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-zinc-500">{description}</span>
            </span>
            <Switch checked={checked} onChange={onChange}/>
        </label>
    );
}

/** FooterNote is the reassurance/warning line under the card and the settings
 *  screen, styled to match the browser transfer card's footer. */
function FooterNote({busy}: {busy: boolean}) {
    return (
        <p className={cn('text-center text-[10px] uppercase leading-relaxed tracking-wide', busy ? 'text-amber-300/80' : 'text-zinc-500')}>
            {busy ? 'Keep this window open. Closing it cancels the transfer.' : 'End-to-end encrypted. Files are never stored on a server.'}
        </p>
    );
}

// Wails highlights the element carrying this var while an OS drag hovers it.
// Dropping works window-wide regardless (OnFileDrop useDropTarget=false); the
// var only drives the hover highlight.
const dropVar = {['--wails-drop-target' as never]: 'drop'} as CSSProperties;

/** Dropzone is the file selector: a full invitation while the selection is empty,
 *  a slim "Add files" row once files are picked. */
function Dropzone({expanded, onPickFiles, onPickFolder}: {
    expanded: boolean;
    onPickFiles: () => void;
    onPickFolder: () => void;
}) {
    if (!expanded) {
        return (
            <div style={dropVar} className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-white/15 bg-white/[0.02] py-1.5 pl-3 pr-1.5 transition-colors hover:border-ice/40">
                <span className="flex min-w-0 items-baseline gap-2.5">
                    <span className="text-sm font-medium text-zinc-200">Add files</span>
                    <span className="truncate font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-600">or drop anywhere</span>
                </span>
                <span className="flex shrink-0 gap-1">
                    <Button variant="ghost" className="px-2 py-1.5" onClick={onPickFiles} aria-label="Add files">
                        <Files/>
                    </Button>
                    <Button variant="ghost" className="px-2 py-1.5" onClick={onPickFolder} aria-label="Add a folder">
                        <Folder/>
                    </Button>
                </span>
            </div>
        );
    }
    return (
        <div style={dropVar} className="group rounded-xl border border-dashed border-white/15 bg-white/[0.02] p-5 text-center transition-colors hover:border-ice/40 hover:bg-white/[0.03]">
            <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] transition group-hover:border-ice/30">
                <UploadCloud className="h-5 w-5 text-zinc-400 transition group-hover:text-ice"/>
            </span>
            <p className="text-sm font-medium text-zinc-200">Select files to send</p>
            <p className="mt-1 font-mono text-[11px] text-zinc-500">or drag them onto the window</p>
            <div className="mt-3 flex gap-2">
                <Button variant="outline" className="flex-1" onClick={onPickFiles}>
                    <Files/> Files
                </Button>
                <Button variant="outline" className="flex-1" onClick={onPickFolder}>
                    <Folder/> Folder
                </Button>
            </div>
        </div>
    );
}

/** FileList is the editable selection: compact rows with a remove control. */
function FileList({files, onRemove}: {files: string[]; onRemove: (path: string) => void}) {
    return (
        <ul className="custom-scrollbar max-h-40 space-y-1.5 overflow-y-auto">
            {files.map((f) => (
                <li key={f} className="flex items-center gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] py-1.5 pl-2 pr-1">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/[0.04] ring-1 ring-inset ring-white/10">
                        <FileIcon name={f}/>
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-300">{baseName(f)}</span>
                    <button
                        onClick={() => onRemove(f)}
                        aria-label={`Remove ${baseName(f)}`}
                        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-600 transition-colors hover:bg-white/10 hover:text-zinc-200"
                    >
                        <X className="size-3.5"/>
                    </button>
                </li>
            ))}
        </ul>
    );
}

/** FileSummary collapses the selection to one row while a transfer is in flight;
 *  the chevron expands a read-only list. */
function FileSummary({files, open, onToggle}: {files: string[]; open: boolean; onToggle: () => void}) {
    return (
        <div className="space-y-1.5">
            <button
                onClick={onToggle}
                className="flex w-full items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left transition-colors hover:bg-white/[0.04]"
            >
                <span className="flex items-center gap-2.5">
                    <Files className="size-4 text-zinc-400"/>
                    <span className="text-sm text-zinc-300">{files.length} {files.length === 1 ? 'item' : 'items'}</span>
                </span>
                <ChevronDown className={cn('size-4 text-zinc-500 transition-transform', open && 'rotate-180')}/>
            </button>
            {open && (
                <ul className="custom-scrollbar max-h-32 space-y-1.5 overflow-y-auto">
                    {files.map((f) => (
                        <li key={f} className="flex items-center gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
                            <FileIcon name={f}/>
                            <span className="min-w-0 truncate text-sm text-zinc-300">{baseName(f)}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/** SharePanel is the single share surface, mirroring the browser's ShareLinkPanel:
 *  code hero + a [Copy link] [Show QR] [Share] action row while waiting for the
 *  receiver, then a slim code row once the transfer starts (rooms are one-to-one,
 *  so the code is consumed the moment the receiver joins). Callers gate on the
 *  link because code registration can fail while the link is always valid; the
 *  code hero simply drops out when the code is empty. */
function SharePanel({code, link, compact}: {code: string; link: string; compact: boolean}) {
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
    if (compact) {
        return (
            <div className="animate-floe-in flex items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-black/40 py-1.5 pl-3 pr-1">
                <span className="flex min-w-0 items-baseline gap-2.5">
                    <Eyebrow className="shrink-0">Code</Eyebrow>
                    <span className="truncate font-mono text-sm text-zinc-200">{code || link}</span>
                </span>
                <button
                    onClick={() => copy('code', code || link)}
                    aria-label="Copy code"
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
                >
                    {copied ? <Check className="size-3.5 text-green-500"/> : <Copy className="size-3.5"/>}
                </button>
            </div>
        );
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
                        <button
                            onClick={() => copy('code', code)}
                            aria-label="Copy code"
                            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
                        >
                            {copied === 'code' ? <Check className="size-3.5 text-green-500"/> : <Copy className="size-3.5"/>}
                        </button>
                    </div>
                </div>
            )}
            <div>
                <Eyebrow className="mb-2">Share link</Eyebrow>
                <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-zinc-950 py-2 pl-3 pr-1.5 transition hover:border-white/20">
                    <code className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed text-zinc-300">{link}</code>
                    <button
                        onClick={() => copy('link', link)}
                        aria-label="Copy link"
                        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
                    >
                        {copied === 'link' ? <Check className="size-3.5 text-green-500"/> : <Copy className="size-3.5"/>}
                    </button>
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

function App() {
    // Only the transfer tabs are ever persisted; anything else in the store
    // (stale or hand-edited) falls back to Send.
    const [mode, setMode] = useState<Mode>(() => {
        const m = localStorage.getItem('floe:mode');
        return m === 'send' || m === 'receive' ? m : 'send';
    });
    // Whether the full-screen settings view covers the transfer UI.
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [hideIP, setHideIP] = useState(() => localStorage.getItem('floe:hideIP') === '1');

    // Send state
    const [files, setFiles] = useState<string[]>([]);
    // What the send view is staging: a file selection or a typed text note.
    const [sendKind, setSendKind] = useState<'files' | 'text'>('files');
    const [sendText, setSendText] = useState('');
    const [sendCode, setSendCode] = useState('');
    const [sendLink, setSendLink] = useState('');
    const [sendStatus, setSendStatus] = useState('Select or drag files, then click Send.');
    const [sending, setSending] = useState(false);
    const [sendProg, setSendProg] = useState<{pct: number; label: string} | null>(null);
    const [sendDone, setSendDone] = useState(false);
    const [sentCount, setSentCount] = useState(0);
    const [peerConnected, setPeerConnected] = useState(false);
    const [filesOpen, setFilesOpen] = useState(false);
    const sendStart = useRef<Marker>(null);
    const sendCancel = useRef(false);
    // Snapshot of the sent file names, readable from the once-registered
    // send:done closure (which must not touch React state directly).
    const sentNamesRef = useRef<string[]>([]);

    // Receive state
    const [code, setCode] = useState('');
    const [output, setOutput] = useState(() => localStorage.getItem('floe:saveDir') || '');
    // Opt-OUT model like the browser: report unless explicitly disabled.
    const [reportStats, setReportStats] = useState(() => localStorage.getItem('floe:report-stats') !== '0');
    const [recvStatus, setRecvStatus] = useState('Enter a code or link, then click Receive.');
    const [receiving, setReceiving] = useState(false);
    const [recvProg, setRecvProg] = useState<{pct: number; label: string} | null>(null);
    const [recvDir, setRecvDir] = useState('');
    const [recvDone, setRecvDone] = useState(false);
    const recvStart = useRef<Marker>(null);
    const recvCancel = useRef(false);
    // Receive file names harvested from progress events (the Go throttle always
    // emits each file's final update, so every name is captured).
    const recvNamesRef = useRef<string[]>([]);

    // Local transfer history (successful transfers only), newest first.
    const [history, setHistory] = useState<HistEntry[]>(loadHistory);

    // Selected ICE path of the in-flight transfer ('' until known). One transfer
    // at a time (busy-gated), so a single value covers send and receive.
    const [route, setRoute] = useState('');

    // Live busy flag for the OnFileDrop closure, which is registered once with []
    // deps and would otherwise read a stale `busy`.
    const busyRef = useRef(false);

    // Windows Explorer right-click menu registration state.
    const [ctxMenu, setCtxMenu] = useState(false);

    // About row data, fetched once from the Go side.
    const [appVer, setAppVer] = useState('');
    const [proto, setProto] = useState<number | null>(null);

    // addFiles merges incoming paths into the send selection. Shared by OS
    // drops, second-instance launches, and cold-start args; safe to call from
    // once-registered closures (functional updates + stable setters only).
    function addFiles(paths: string[]) {
        if (!paths || !paths.length || busyRef.current) return;
        setSettingsOpen(false);
        setMode('send');
        setSendKind('files');
        setFiles((prev) => mergePaths(prev, paths));
        setSendDone(false);
        setSendStatus('');
    }

    async function toggleCtxMenu(v: boolean) {
        setCtxMenu(v);
        try {
            if (v) await EnableContextMenu();
            else await DisableContextMenu();
        } catch {
            setCtxMenu(!v); // revert on failure
        }
    }

    useEffect(() => {
        EventsOn('send:code', (data: {code: string; link: string}) => {
            if (sendCancel.current) return;
            setSendCode(data.code);
            setSendLink(data.link);
            setSendStatus('Waiting for the receiver...');
        });
        EventsOn('send:status', (msg: string) => {
            if (sendCancel.current) return;
            setSendStatus(msg);
            // The only send:status today is "Peer connected. Sending..." — it marks
            // the moment the room is consumed and the share panel can collapse.
            setPeerConnected(true);
        });
        EventsOn('send:progress', (p: Prog) => {
            if (sendCancel.current) return;
            setSendProg(track(sendStart, p));
            setSendStatus('');
        });
        EventsOn('send:done', () => {
            if (sendCancel.current) return;
            setSendProg(null);
            setSending(false);
            setSendDone(true);
            setSendStatus('');
            const names = sentNamesRef.current;
            setHistory((prev) => [{kind: 'send' as const, names, count: names.length, at: Date.now()}, ...prev].slice(0, HISTORY_CAP));
        });
        EventsOn('send:error', (msg: string) => {
            if (sendCancel.current) return;
            setSendStatus('Error: ' + msg);
            setSending(false);
            // The room is dead after an error; drop the stale code and link.
            setSendCode('');
            setSendLink('');
            setPeerConnected(false);
        });
        EventsOn('recv:progress', (p: Prog) => {
            if (recvCancel.current) return;
            setRecvProg(track(recvStart, p));
            if (p.fileName && !recvNamesRef.current.includes(p.fileName)) recvNamesRef.current.push(p.fileName);
        });
        EventsOn('send:route', (r: string) => {
            if (sendCancel.current) return;
            setRoute(r);
        });
        EventsOn('recv:route', (r: string) => {
            if (recvCancel.current) return;
            setRoute(r);
        });
        // Native file drop on the whole window (useDropTarget=false). Paths arrive
        // already resolved to absolute paths from the Go side.
        OnFileDrop((_x, _y, paths) => addFiles(paths), false);
        // Files forwarded by a second launch (Explorer context menu, drag onto
        // the exe while running).
        EventsOn('files:open', (paths: string[]) => addFiles(paths));
        // Files passed on the command line before the frontend mounted.
        GetPendingFiles().then((paths) => { if (paths && paths.length) addFiles(paths); }).catch(() => {});
        // Whether the Explorer entry is registered (and points at this exe).
        if (isWindows) ContextMenuEnabled().then(setCtxMenu).catch(() => {});
        return () => {
            EventsOff('send:code');
            EventsOff('send:status');
            EventsOff('send:progress');
            EventsOff('send:done');
            EventsOff('send:error');
            EventsOff('recv:progress');
            EventsOff('send:route');
            EventsOff('recv:route');
            EventsOff('files:open');
            OnFileDropOff();
        };
    }, []);

    // About data: fetched once; failures just leave the placeholders.
    useEffect(() => {
        GetVersion().then(setAppVer).catch(() => {});
        EngineProtocolVersion().then(setProto).catch(() => {});
    }, []);

    // Persist lightweight UI preferences so they survive a relaunch.
    useEffect(() => { localStorage.setItem('floe:hideIP', hideIP ? '1' : '0'); }, [hideIP]);
    // Persist only the transfer tabs; relaunching into History would be odd.
    useEffect(() => { if (mode !== 'history') localStorage.setItem('floe:mode', mode); }, [mode]);
    useEffect(() => { localStorage.setItem('floe:history', JSON.stringify(history)); }, [history]);
    useEffect(() => { localStorage.setItem('floe:saveDir', output); }, [output]);
    useEffect(() => { localStorage.setItem('floe:report-stats', reportStats ? '1' : '0'); }, [reportStats]);

    useEffect(() => { busyRef.current = sending || receiving; }, [sending, receiving]);

    // Escape closes the settings screen.
    useEffect(() => {
        if (!settingsOpen) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSettingsOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [settingsOpen]);

    async function pickFiles() {
        try {
            const picked = await SelectFiles();
            if (picked && picked.length) {
                setFiles((prev) => mergePaths(prev, picked));
                setSendDone(false);
                setSendStatus('');
            }
        } catch {
            // dialog cancelled
        }
    }

    // Folders merge like files. Known edge: picking a folder plus a file inside it
    // sends that file twice (the engine walks the folder); path dedupe cannot see it.
    async function pickSendFolder() {
        try {
            const dir = await SelectFolder();
            if (dir) {
                setFiles((prev) => mergePaths(prev, [dir]));
                setSendDone(false);
                setSendStatus('');
            }
        } catch {
            // dialog cancelled
        }
    }

    function removeFile(path: string) {
        setFiles((prev) => prev.filter((f) => normPath(f) !== normPath(path)));
        setSendDone(false);
    }

    async function pickSaveFolder() {
        try {
            const dir = await SelectFolder();
            if (dir) setOutput(dir);
        } catch {
            // dialog cancelled
        }
    }

    async function send() {
        if (sendKind === 'text') {
            if (!sendText.trim()) {
                setSendStatus('Type some text first.');
                return;
            }
        } else if (!files.length) {
            setSendStatus('Select at least one file first.');
            return;
        }
        sendCancel.current = false;
        setSending(true);
        setSendDone(false);
        setRoute('');
        if (sendKind === 'text') {
            setSentCount(1);
            sentNamesRef.current = ['message.txt'];
        } else {
            setSentCount(files.length);
            sentNamesRef.current = files.map((f) => baseName(f) || f);
        }
        setPeerConnected(false);
        setFilesOpen(false);
        setSendCode('');
        setSendLink('');
        setSendProg(null);
        sendStart.current = null;
        setSendStatus('Setting up...');
        try {
            if (sendKind === 'text') await StartSendText(sendText, hideIP);
            else await StartSend(files, hideIP);
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
        setRecvDone(false);
        setRoute('');
        recvCancel.current = false;
        recvStart.current = null;
        recvNamesRef.current = [];
        setRecvStatus('Connecting... keep this window open.');
        try {
            const dir = await ReceiveByCode(code.trim(), output.trim(), hideIP, reportStats);
            setRecvDir(dir);
            setRecvDone(true);
            setRecvProg(null);
            setRecvStatus('');
            const names = recvNamesRef.current;
            setHistory((prev) => [{kind: 'recv' as const, names, count: names.length, dir, at: Date.now()}, ...prev].slice(0, HISTORY_CAP));
        } catch (e: any) {
            setRecvStatus(recvCancel.current ? 'Cancelled.' : 'Error: ' + e);
        } finally {
            setReceiving(false);
        }
    }

    // cancel aborts the in-flight transfer: flag it so late Go events are ignored,
    // reset the UI optimistically, then close the connections on the Go side.
    function cancel() {
        if (sending) {
            sendCancel.current = true;
            setSending(false);
            setSendProg(null);
            setSendDone(false);
            // The room is dead once we cancel; drop the code and link. (A cancel
            // followed by an instant re-Send can still let one late send:code from
            // the dead attempt through — same tiny window as the other guards.)
            setSendCode('');
            setSendLink('');
            setPeerConnected(false);
            setFilesOpen(false);
            setSendStatus('Cancelled.');
        }
        setRoute('');
        if (receiving) {
            recvCancel.current = true;
            setReceiving(false);
            setRecvProg(null);
            setRecvDone(false);
            setRecvStatus('Cancelled.');
        }
        CancelTransfer().catch(() => {});
    }

    const busy = sending || receiving;

    const modeBtn = (m: Mode, label: string) => (
        <button
            onClick={() => setMode(m)}
            className={cn(
                'border-b-2 px-3 pb-1 font-mono text-[11px] uppercase tracking-[0.2em] transition-colors',
                mode === m ? 'border-white text-zinc-100' : 'border-transparent text-zinc-600 hover:text-zinc-400',
            )}
        >
            {label}
        </button>
    );

    return (
        <div className="flex h-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100 selection:bg-ice/20">
            <TitleBar onSettings={() => setSettingsOpen((o) => !o)} settingsActive={settingsOpen}/>

            {settingsOpen ? (
            /* ── SETTINGS SCREEN ─────────────────────────────────────────── */
                <div className="flex flex-1 flex-col overflow-hidden">
                    <div className="custom-scrollbar flex-1 overflow-y-auto">
                        <div className="mx-auto w-full max-w-lg px-8 py-10">
                            <div className="flex items-center gap-3">
                                <button
                                    aria-label="Back"
                                    onClick={() => setSettingsOpen(false)}
                                    className="grid h-7 w-7 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
                                >
                                    <ArrowLeft className="size-4"/>
                                </button>
                                <h2 className="text-base font-semibold tracking-tight text-white">Settings</h2>
                            </div>

                            <div className="mt-6 space-y-6">
                                <section className="space-y-2">
                                    <Eyebrow>Privacy</Eyebrow>
                                    <div className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.06] bg-white/[0.02]">
                                        <SettingRow
                                            checked={hideIP}
                                            onChange={setHideIP}
                                            label="Hide my IP"
                                            description="Route transfers through the relay so peers never see your IP address. Slower; applies to new transfers."
                                        />
                                        <SettingRow
                                            checked={reportStats}
                                            onChange={setReportStats}
                                            label="Contribute to global stats"
                                            description="After a transfer completes, only the total byte count is added to the public counter on floe.one."
                                        />
                                    </div>
                                </section>

                                {isWindows && (
                                    <section className="space-y-2">
                                        <Eyebrow>System</Eyebrow>
                                        <div className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.06] bg-white/[0.02]">
                                            <SettingRow
                                                checked={ctxMenu}
                                                onChange={toggleCtxMenu}
                                                label="Right-click menu"
                                                description="Adds a Send with Floe entry to the Explorer right-click menu for your user account."
                                            />
                                        </div>
                                    </section>
                                )}

                                <section className="space-y-2">
                                    <Eyebrow>About</Eyebrow>
                                    <div className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.06] bg-white/[0.02]">
                                        <div className="flex items-center justify-between p-3.5">
                                            <span className="text-sm font-medium text-zinc-200">Version</span>
                                            <span className="font-mono text-xs text-zinc-500">{appVer || 'dev'}</span>
                                        </div>
                                        <div className="flex items-center justify-between p-3.5">
                                            <span className="text-sm font-medium text-zinc-200">Protocol</span>
                                            <span className="font-mono text-xs text-zinc-500">{proto ?? '…'}</span>
                                        </div>
                                    </div>
                                </section>
                            </div>
                        </div>
                    </div>
                    {busy && (
                        <div className="border-t border-white/[0.06] px-5 py-3">
                            <FooterNote busy/>
                        </div>
                    )}
                </div>

            ) : (
            <div className="flex flex-1 overflow-hidden">

                {/* ── LEFT RAIL: editorial hero ───────────────────────────────── */}
                <aside className="relative flex w-[42%] max-w-[460px] shrink-0 flex-col overflow-hidden border-r border-white/[0.06] bg-zinc-950">
                    {/* ambient ice glow */}
                    <div
                        aria-hidden
                        className="pointer-events-none absolute left-1/4 top-1/3 h-[380px] w-[380px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-ice/[0.05] blur-3xl"
                    />
                    {/* faint watermark bolt */}
                    <BoltMark
                        aria-hidden
                        className="pointer-events-none absolute -bottom-10 -right-10 size-72 rotate-12 text-white/[0.02]"
                    />

                    {/* hero — vertically centered */}
                    <div className="relative flex flex-1 flex-col justify-center px-9 py-8">
                        <Eyebrow tone="ice">Peer to peer</Eyebrow>
                        <h1 className="mt-4 text-[28px] font-semibold leading-[1.1] tracking-tight text-white">
                            Send anything,<br/>peer to peer.
                        </h1>
                        <p className="mt-3.5 text-sm leading-relaxed text-zinc-400">
                            End-to-end encrypted. No accounts,<br/>no storage, no middleman.
                        </p>

                        <div className="mt-10 space-y-6">
                            {[
                                {n: '01', title: 'Direct & unlimited', note: 'Files stream device to device with no size cap.'},
                                {n: '02', title: 'End-to-end encrypted', note: 'DTLS and SRTP, the same as a video call.'},
                                {n: '03', title: 'Nothing is stored', note: 'The server only brokers the handshake.'},
                            ].map(({n, title, note}) => (
                                <div key={n} className="border-l border-white/10 pl-5">
                                    <span className="font-mono text-xs text-zinc-600">{n}</span>
                                    <p className="mt-1.5 text-sm font-medium text-zinc-100">{title}</p>
                                    <p className="mt-1 text-sm leading-relaxed text-zinc-400">{note}</p>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* footer links */}
                    <div className="relative flex items-center gap-4 px-9 pb-8">
                        <button
                            onClick={() => BrowserOpenURL('https://github.com/jannskiee/floe')}
                            className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500 transition-colors hover:text-zinc-300"
                        >
                            GitHub
                        </button>
                        <span className="text-zinc-800">·</span>
                        <button
                            onClick={() => BrowserOpenURL('https://docs.floe.one')}
                            className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500 transition-colors hover:text-zinc-300"
                        >
                            Docs
                        </button>
                    </div>
                </aside>

                {/* ── RIGHT CONSOLE: the "instrument" card ────────────────────── */}
                <main className="custom-scrollbar flex-1 overflow-y-auto">
                    <div className="mx-auto flex min-h-full w-full max-w-lg px-8 py-8">
                        <div className="m-auto w-full rounded-xl border border-white/10 bg-zinc-900/60 shadow-2xl ring-1 ring-white/5 backdrop-blur-xl">

                            {/* header: mode toggle + status badge */}
                            <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3.5">
                                <div className="flex items-center gap-5">
                                    {modeBtn('send', 'Send')}
                                    {modeBtn('receive', 'Receive')}
                                    {modeBtn('history', 'History')}
                                </div>
                                <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                                    <StatusDot className="bg-green-500" pulse={busy}/>
                                    {busy ? (route ? `Active · ${route === 'relay' ? 'Relayed' : 'Direct'}` : 'Active') : hideIP ? 'Ready · Relay' : 'Ready'}
                                </div>
                            </div>

                            {/* body */}
                            <div className="space-y-4 px-5 py-4">

                                {/* ── SEND VIEW ─────────────────────────────────── */}
                                {mode === 'send' ? (
                                    <div className="space-y-4">
                                        {/* what to stage: a file selection or a typed text note */}
                                        {!sending && (
                                            <div className="flex gap-4 px-0.5">
                                                {(['files', 'text'] as const).map((k) => (
                                                    <button
                                                        key={k}
                                                        onClick={() => setSendKind(k)}
                                                        className={cn(
                                                            'border-b pb-0.5 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors',
                                                            sendKind === k ? 'border-white text-zinc-200' : 'border-transparent text-zinc-600 hover:text-zinc-400',
                                                        )}
                                                    >
                                                        {k === 'files' ? 'Files' : 'Text'}
                                                    </button>
                                                ))}
                                            </div>
                                        )}

                                        {/* selector: full dropzone when empty, slim add-row once files
                                            are picked, hidden entirely while a transfer is in flight */}
                                        {!sending && sendKind === 'files' && (
                                            <Dropzone expanded={!files.length} onPickFiles={pickFiles} onPickFolder={pickSendFolder}/>
                                        )}

                                        {/* text note editor (Ctrl+Enter sends) */}
                                        {!sending && sendKind === 'text' && (
                                            <textarea
                                                value={sendText}
                                                onChange={(e) => setSendText(e.target.value)}
                                                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && sendText.trim() && !busy) send(); }}
                                                placeholder="Type or paste text to send"
                                                rows={4}
                                                className="custom-scrollbar w-full resize-none rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-100 outline-none transition-[color,box-shadow] placeholder:text-zinc-500 focus-visible:border-ice/50 focus-visible:ring-[3px] focus-visible:ring-ice/25"
                                            />
                                        )}

                                        {/* selection: editable list while idle, one-row summary while sending */}
                                        {sendKind === 'files' && files.length > 0 && !sending && (
                                            <div className="animate-floe-in space-y-2">
                                                <div className="flex items-baseline justify-between px-0.5">
                                                    <Eyebrow>Files</Eyebrow>
                                                    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">
                                                        {files.length} {files.length === 1 ? 'item' : 'items'}
                                                    </span>
                                                </div>
                                                <FileList files={files} onRemove={removeFile}/>
                                            </div>
                                        )}
                                        {sending && (
                                            <FileSummary
                                                files={sendKind === 'text' ? ['message.txt'] : files}
                                                open={filesOpen}
                                                onToggle={() => setFilesOpen((o) => !o)}
                                            />
                                        )}

                                        {/* action: a stable slot across stages so the button never jumps */}
                                        {sending ? (
                                            <Button variant="outline" className="w-full" onClick={cancel}>
                                                <X/> Cancel
                                            </Button>
                                        ) : (
                                            <Button
                                                className="w-full"
                                                onClick={send}
                                                disabled={busy || (sendKind === 'text' ? !sendText.trim() : !files.length)}
                                            >
                                                <Send/> {sendKind === 'text'
                                                    ? 'Send text'
                                                    : `Send${files.length ? ` · ${files.length} ${files.length === 1 ? 'item' : 'items'}` : ''}`}
                                            </Button>
                                        )}

                                        {/* share surface: full while waiting, slim once the receiver joins */}
                                        {sending && sendLink && (
                                            <SharePanel code={sendCode} link={sendLink} compact={peerConnected || !!sendProg}/>
                                        )}

                                        {sendProg && <ProgressRow prog={sendProg}/>}
                                        {sendDone && !sending && (
                                            <div className="animate-floe-in flex items-center justify-center gap-2 text-sm text-zinc-300">
                                                <Check className="size-4 shrink-0 text-green-500"/>
                                                <span>Sent {sentCount} {sentCount === 1 ? 'item' : 'items'}</span>
                                            </div>
                                        )}
                                        <StatusLine text={sendStatus} busy={sending}/>
                                    </div>

                                ) : mode === 'receive' ? (
                                /* ── RECEIVE VIEW ─────────────────────────────── */
                                    <div className="space-y-4">
                                        <div className="space-y-2">
                                            <Eyebrow>Code or link</Eyebrow>
                                            <Input
                                                placeholder="e.g. olive-tiger-castle"
                                                value={code}
                                                onChange={(e) => setCode(e.target.value)}
                                                onKeyDown={(e) => { if (e.key === 'Enter' && !receiving && code.trim()) receive(); }}
                                                disabled={receiving}
                                                autoFocus
                                                autoComplete="off"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <Eyebrow>Save to</Eyebrow>
                                            <div className="flex gap-2">
                                                <Input
                                                    className="flex-1"
                                                    placeholder="blank = Downloads"
                                                    value={output}
                                                    onChange={(e) => setOutput(e.target.value)}
                                                    disabled={receiving}
                                                    autoComplete="off"
                                                />
                                                <Button variant="outline" onClick={pickSaveFolder} disabled={receiving}>
                                                    <Folder/> Browse
                                                </Button>
                                            </div>
                                        </div>

                                        {receiving ? (
                                            <Button variant="outline" className="w-full" onClick={cancel}>
                                                <X/> Cancel
                                            </Button>
                                        ) : (
                                            <Button className="w-full" onClick={receive} disabled={busy}>
                                                <Download/> Receive
                                            </Button>
                                        )}

                                        {recvProg && <ProgressRow prog={recvProg}/>}
                                        {recvDone && !receiving && (
                                            <div className="animate-floe-in flex items-center gap-2 text-sm text-zinc-300">
                                                <Check className="size-4 shrink-0 text-green-500"/>
                                                <span className="truncate">Saved to {recvDir}</span>
                                            </div>
                                        )}
                                        {recvDir && !receiving && (
                                            <Button variant="outline" className="animate-floe-in w-full" onClick={() => { OpenFolder(recvDir).catch(() => {}); }}>
                                                <FolderOpen/> Show in folder
                                            </Button>
                                        )}
                                        <StatusLine text={recvStatus} busy={receiving}/>
                                    </div>

                                ) : (
                                /* ── HISTORY VIEW ─────────────────────────────── */
                                    <div className="space-y-3">
                                        <div className="flex items-baseline justify-between px-0.5">
                                            <Eyebrow>History</Eyebrow>
                                            {history.length > 0 && (
                                                <button
                                                    onClick={() => setHistory([])}
                                                    className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600 transition-colors hover:text-zinc-300"
                                                >
                                                    Clear
                                                </button>
                                            )}
                                        </div>
                                        {history.length === 0 ? (
                                            <p className="py-8 text-center text-xs text-zinc-500">No transfers yet.</p>
                                        ) : (
                                            <ul className="custom-scrollbar max-h-80 divide-y divide-white/[0.04] overflow-y-auto rounded-lg border border-white/[0.06] bg-white/[0.02]">
                                                {history.map((h, i) => (
                                                    <li
                                                        key={`${h.at}-${i}`}
                                                        title={h.names.length > 1
                                                            ? h.names.slice(0, 10).join(', ') + (h.names.length > 10 ? ` +${h.names.length - 10} more` : '')
                                                            : undefined}
                                                        className="group flex items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-white/[0.03]"
                                                    >
                                                        {h.kind === 'send'
                                                            ? <ArrowUpRight className="size-4 shrink-0 text-zinc-500"/>
                                                            : <ArrowDownLeft className="size-4 shrink-0 text-zinc-500"/>}
                                                        <span className="min-w-0 flex-1">
                                                            <span className="block truncate text-sm text-zinc-200">
                                                                {h.count === 1 ? (h.names[0] || '1 file') : `${h.count} files`}
                                                            </span>
                                                            <span className="block text-xs text-zinc-500">
                                                                {h.kind === 'send' ? 'Sent' : 'Received'} · {fmtWhen(h.at)}
                                                            </span>
                                                        </span>
                                                        {h.kind === 'recv' && h.dir && (
                                                            <button
                                                                onClick={() => { OpenFolder(h.dir!).catch(() => {}); }}
                                                                aria-label="Show in folder"
                                                                className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-500 opacity-0 transition-[color,background-color,opacity] hover:bg-white/10 hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100"
                                                            >
                                                                <FolderOpen className="size-3.5"/>
                                                            </button>
                                                        )}
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* footer note */}
                            <div className="border-t border-white/[0.06] px-5 py-3">
                                <FooterNote busy={busy}/>
                            </div>
                        </div>
                    </div>
                </main>
            </div>
            )}
        </div>
    );
}

export default App;
