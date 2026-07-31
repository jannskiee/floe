import {useEffect, useRef, useState} from 'react';
import type {CSSProperties, MutableRefObject, ReactNode} from 'react';
import {
    CancelTransfer,
    ContextMenuEnabled,
    DisableContextMenu,
    EnableContextMenu,
    EngineProtocolVersion,
    GetPendingFiles,
    GetSettings,
    GetVersion,
    OpenFile,
    OpenFolder,
    PasteFiles,
    ReceiveByCode,
    RevealFile,
    SelectFiles,
    SelectFolder,
    SetSettings,
    StartSend,
    StartSendText,
    TestServer,
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
    History,
    Loader2,
    QrCode,
    Send,
    Share2,
    SquareArrowOutUpRight,
    UploadCloud,
    X,
} from 'lucide-react';
import QRCode from 'react-qr-code';
import {BoltMark, Button, Eyebrow, Input, StatusDot, cn} from './components/ui';
import {advancedSummary, hostOf} from './settings';
import TitleBar from './components/TitleBar';
import FileIcon from './components/FileIcon';
import {Tooltip} from './components/Tooltip';

type Mode = 'send' | 'receive' | 'history';

// One completed transfer, persisted locally in localStorage['floe:history'].
interface HistEntry {
    kind: 'send' | 'recv';
    names: string[];
    count: number;
    dir?: string;
    at: number;
    bytes?: number; // total transferred size; absent on entries from older builds
}

const HISTORY_CAP = 50;

// Initial status lines, shared by the useState initializers and Start-over so
// a reset lands on the exact same copy a fresh launch shows.
const INITIAL_SEND_STATUS = 'Select or drag files, then click Send.';
const INITIAL_RECV_STATUS = 'Enter a code or link, then click Receive.';

function loadHistory(): HistEntry[] {
    // A corrupted store must never break the app; fall back to empty.
    try {
        const raw = JSON.parse(localStorage.getItem('floe:history') || '[]');
        return Array.isArray(raw) ? raw : [];
    } catch {
        return [];
    }
}

// fmtWhen renders a history timestamp as "Today, 19:55", "Yesterday, 09:12",
// or "Jul 19, 19:55", comparing calendar days (not 24h windows).
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
    return `${day}, ${hh}:${mm}`;
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
    if (s) label += `, ${s}`;
    if (e && pct < 100) label += `, ETA ${e}`;
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

/** webPlaceholder shows what the Web address field falls back to when left blank,
 *  so the derivation is visible instead of implied. Mirrors engine/serverurl.Web,
 *  which is what actually builds the link; keep the two in step. */
function webPlaceholder(server: string): string {
    const s = server.trim().replace(/\/+$/, '');
    if (s === '' || s === 'https://api.floe.one') return 'https://floe.one';
    if (s === 'http://localhost:3001') return 'http://localhost:3000';
    return s;
}

/** StatusLine is the small centred status/error line under a card.
 *
 *  `live` is opt-in. An aria-live region only announces changes while it is in the
 *  DOM, so the element has to stay mounted through the empty state to work, which
 *  costs a permanently reserved 20px. That is right for the Settings server test,
 *  where the result arrives seconds later and is the entire point of pressing the
 *  button, and wrong for the send and receive lines, which sit in tight layouts and
 *  should collapse to nothing when idle. */
function StatusLine({text, busy, live}: {text: string; busy: boolean; live?: boolean}) {
    if (!text && !live) return null;
    const isError = text.startsWith('Error');
    return (
        <p
            {...(live ? {role: 'status' as const, 'aria-live': 'polite' as const} : {})}
            className={cn('flex min-h-5 items-center justify-center gap-2 text-center text-xs', isError ? 'text-red-400' : 'text-zinc-500')}
        >
            {busy && <Loader2 className="size-3.5 shrink-0 animate-spin"/>}
            {isError && <AlertCircle className="size-3.5 shrink-0"/>}
            <span>{text}</span>
        </p>
    );
}


// Windows paths compare case-insensitively; normalize for dedupe and removal but
// keep the original strings for display and for the Go side.
const isWindows = navigator.userAgent.includes('Windows');
// macOS reserves some Cmd combos for its app menu, so a few shortcuts differ there.
// WKWebView reports "Macintosh" even on Apple Silicon; the UA is synchronous, unlike
// the Wails Environment() promise, so the once-registered key listener can read it.
const isMac = navigator.userAgent.includes('Macintosh');
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
 *  sr-only checkbox so keyboard and screen-reader behavior come for free.
 *  32x18 with a 14px thumb (travel 32 - 14 - 2*2 = 14px = translate-x-3.5),
 *  desktop proportions rather than the chunkier mobile 36x20. Deliberately no
 *  group-hover coupling: the primitive stays context-free, and the row's own
 *  hover fill already signals interactivity. */
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
                    'relative h-[18px] w-8 rounded-full transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ice/60',
                    checked ? 'bg-white' : 'bg-white/10 ring-1 ring-inset ring-white/15',
                )}
            >
                <span
                    className={cn(
                        'absolute left-0.5 top-0.5 size-3.5 rounded-full transition-transform duration-150 ease-out',
                        checked ? 'translate-x-3.5 bg-zinc-950' : 'bg-zinc-400',
                    )}
                />
            </span>
        </span>
    );
}

// One geometry, three call sites: SettingRow, SettingField, and the Advanced
// disclosure button. Kept as consts so the three cannot drift apart.
//
// 13px labels match the TitleBar wordmark; 12/16 descriptions are one line under
// the 12-word copy rule. About rows flip the emphasis: dim key, legible mono
// value, with the label at zinc-400 rather than zinc-500 so it keeps AA contrast.
const rowLabelClass = 'block text-[13px] font-medium leading-5 text-zinc-200';
const rowDescClass = 'mt-0.5 block text-xs leading-4 text-zinc-500';
const aboutLabelClass = 'text-[13px] leading-5 text-zinc-400';
const aboutValueClass = 'shrink-0 font-mono text-xs text-zinc-300';

// The settings card. overflow-hidden clips full-bleed row hover fills to the
// rounded corners.
const cardClass = 'overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.02]';
// Inset separators between card rows, replacing divide-y: they start 14px inside
// the card edges (the macOS/Linear read), and unlike divide-y they are drawn by
// each row's own before: pseudo, so they cannot leak a stray line under the
// collapsed Advanced disclosure (v4 divide-y compiles to :not(:last-child)
// border-bottom with no hidden/collapsed escape).
const insetHairline = '[&>*+*]:relative [&>*+*]:before:absolute [&>*+*]:before:inset-x-3.5 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-white/[0.05]';

/** SettingRow is one settings entry: stacked label and one-line description with
 *  a trailing switch. The hover fill is the row's interactivity signal (the card
 *  clips it to the rounded corners); the whole row stays one click target. */
function SettingRow({checked, onChange, label, description}: {
    checked: boolean;
    onChange: (v: boolean) => void;
    label: string;
    description?: string;
}) {
    return (
        <label className="flex cursor-pointer select-none items-center justify-between gap-4 px-3.5 py-2.5 transition-colors hover:bg-white/[0.04]">
            <span className="min-w-0">
                <span className={rowLabelClass}>{label}</span>
                {description && <span className={rowDescClass}>{description}</span>}
            </span>
            <Switch checked={checked} onChange={onChange}/>
        </label>
    );
}

/** SettingField is the text-input counterpart to SettingRow: the same label and
 *  description treatment, but the control sits underneath, because a settings row
 *  is too narrow to hold a description and a usable text field side by side.
 *
 *  This used to render its label as a <span>, which looks identical but is not a
 *  label, so both address inputs had no accessible name at all and announced as
 *  "edit text, blank".
 *
 *  children is a render prop rather than a plain node so the wiring cannot be got
 *  wrong. aria-describedby has to sit on the control itself; on a wrapping element
 *  it associates with nothing and silently does nothing. Handing the ids to the
 *  caller means a new field is spelled the same way as the existing ones or it
 *  does not compile.
 *
 *  description is optional under the 12-word copy rule; when absent the ids
 *  object OMITS the aria-describedby key entirely, never a dangling id. Padding
 *  comes from the caller, so the same field works inside a card row and inside
 *  the Advanced panel. */
function SettingField({htmlFor, label, description, className, children}: {
    htmlFor: string;
    label: string;
    description?: string;
    className?: string;
    children: (ids: {id: string; 'aria-describedby'?: string}) => ReactNode;
}) {
    const descId = `${htmlFor}-description`;
    return (
        <div className={className}>
            <label htmlFor={htmlFor} className={rowLabelClass}>{label}</label>
            {description && <p id={descId} className={rowDescClass}>{description}</p>}
            <div className="mt-2">
                {children(description ? {id: htmlFor, 'aria-describedby': descId} : {id: htmlFor})}
            </div>
        </div>
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
 *  code hero + a [Copy link] [Show QR] [Share] action row. Shown only while
 *  waiting for the receiver: rooms are one-to-one, so the code is consumed
 *  (dead to anyone else) the moment the receiver joins. Callers gate on the
 *  link because code registration can fail while the link is always valid; the
 *  code hero simply drops out when the code is empty. */
function SharePanel({code, link}: {code: string; link: string}) {
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

function App() {
    // Only the transfer tabs are ever persisted; anything else in the store
    // (stale or hand-edited) falls back to Send.
    const [mode, setMode] = useState<Mode>(() => {
        const m = localStorage.getItem('floe:mode');
        return m === 'send' || m === 'receive' ? m : 'send';
    });
    // Where the header clock button returns to when leaving the history view.
    const prevModeRef = useRef<Mode>('send');
    // Whether the full-screen settings view covers the transfer UI.
    const [settingsOpen, setSettingsOpen] = useState(false);
    // Whether the "start over while transferring?" confirm overlay is showing.
    const [confirmReset, setConfirmReset] = useState(false);
    // Whether the "reset all settings?" confirm overlay is showing. Deliberately
    // NOT named confirmReset: that one guards Start over, which clears the
    // transfer UI and keeps every preference. This one is the opposite.
    const [confirmDefaults, setConfirmDefaults] = useState(false);
    // Failure text, rendered inside the open dialog. It cannot borrow testStatus,
    // which lives in the Advanced section: that section is usually collapsed and
    // below the fold, so a failed reset would report itself somewhere hidden,
    // beside a button nobody pressed.
    const [resetErr, setResetErr] = useState('');
    // Success announcement for the zero-height live region under the Reset card.
    // Sighted users see the rows change by themselves, so this exists for screen
    // readers, which otherwise get silence.
    const [resetDone, setResetDone] = useState('');
    // Seeded from the key this used to live in, then replaced by the Go-owned
    // record on mount. See the GetSettings effect for why both steps exist.
    const [hideIP, setHideIP] = useState(() => localStorage.getItem('floe:hideIP') === '1');

    // Self-hosting: the signaling server this app talks to, and the web app its
    // share links point at. Both empty means Floe's own servers. These are read
    // from Go on mount rather than seeded from localStorage, because Go owns them.
    const [serverAddr, setServerAddr] = useState('');
    const [webAddr, setWebAddr] = useState('');
    const [testStatus, setTestStatus] = useState('');
    const [testing, setTesting] = useState(false);
    // Transient label flip on the About Copy button.
    const [aboutCopied, setAboutCopied] = useState(false);

    // Whether the Advanced section is open. null means "not touched this visit",
    // which is what lets a configured server force it open without preventing the
    // user from collapsing it again. Resolved into advExpanded further down.
    const [advOpen, setAdvOpen] = useState<boolean | null>(null);

    // Mirrors of the settings values, following the file's existing ref idiom.
    // Two callers need them: saveSettings, which must not read a stale render
    // closure, and the send:error handler, which is registered once with an empty
    // dependency array and so can never see current state.
    const serverAddrRef = useRef('');
    serverAddrRef.current = serverAddr;
    const webAddrRef = useRef('');
    webAddrRef.current = webAddr;
    const hideIPRef = useRef(false);
    hideIPRef.current = hideIP;

    // Send state
    const [files, setFiles] = useState<string[]>([]);
    // What the send view is staging: a file selection or a typed text note.
    const [sendKind, setSendKind] = useState<'files' | 'text'>('files');
    const [sendText, setSendText] = useState('');
    const [sendCode, setSendCode] = useState('');
    const [sendLink, setSendLink] = useState('');
    const [sendStatus, setSendStatus] = useState(INITIAL_SEND_STATUS);
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
    // Total bytes of the in-flight send, harvested from progress events for the
    // history entry (same once-registered-closure rule: refs only).
    const sendBytesRef = useRef(0);

    // Receive state
    const [code, setCode] = useState('');
    const [output, setOutput] = useState(() => localStorage.getItem('floe:saveDir') || '');
    // Opt-OUT model like the browser: report unless explicitly disabled. Seeded
    // from localStorage, then replaced by the Go-owned record on mount.
    const [reportStats, setReportStats] = useState(() => localStorage.getItem('floe:report-stats') !== '0');
    const reportStatsRef = useRef(true);
    reportStatsRef.current = reportStats;
    const [recvStatus, setRecvStatus] = useState(INITIAL_RECV_STATUS);
    const [receiving, setReceiving] = useState(false);
    const [recvProg, setRecvProg] = useState<{pct: number; label: string} | null>(null);
    const [recvDir, setRecvDir] = useState('');
    const [recvDone, setRecvDone] = useState(false);
    const recvStart = useRef<Marker>(null);
    const recvCancel = useRef(false);
    // Receive file names harvested from progress events (the Go throttle always
    // emits each file's final update, so every name is captured).
    const recvNamesRef = useRef<string[]>([]);
    // Total bytes of the in-flight receive, for the history entry.
    const recvBytesRef = useRef(0);

    // Local transfer history (successful transfers only), newest first.
    const [history, setHistory] = useState<HistEntry[]>(loadHistory);
    // Whether the destructive Clear action is awaiting its inline confirm.
    const [confirmClear, setConfirmClear] = useState(false);
    // Which history row (keyed `${at}-${i}`) has its file list expanded.
    const [expandedRow, setExpandedRow] = useState<string | null>(null);

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
            localStorage.setItem('floe:ctx-menu', v ? '1' : '0');
        } catch {
            setCtxMenu(!v); // revert on failure, marker untouched
        }
    }

    // saveSettings writes the whole record, because Go persists it as one file.
    //
    // Every value is read from a ref rather than from the render closure, and a
    // changed value is passed in explicitly. React state updates are asynchronous,
    // so a handler that calls setHideIP(v) and then saves would otherwise persist
    // the value it just replaced.
    function saveSettings(next?: {hideIP?: boolean; reportStats?: boolean}) {
        return SetSettings(
            serverAddrRef.current.trim(),
            webAddrRef.current.trim(),
            next?.hideIP ?? hideIPRef.current,
            next?.reportStats ?? reportStatsRef.current,
        ).catch((e) => { setTestStatus('Error: could not save settings. ' + e); });
    }

    // Addresses are saved on blur rather than per keystroke: a half-typed address
    // written to disk would be picked up by a transfer started before typing
    // finished. Blur alone is not enough, though. React does not fire blur on
    // unmount, and Escape, the Back button and the history shortcut all close
    // Settings directly, so a typed address was previously discarded while the UI
    // still showed it. The closing-edge effect below covers those exits.
    //
    // Wrapped rather than passed straight to onBlur: React would hand the
    // FocusEvent to saveSettings as its `next` argument.
    const saveOnBlur = () => { void saveSettings(); };

    // The check runs in Go: the WebView's own content-security policy blocks
    // cross-origin requests, so the frontend cannot reach a server itself.
    async function testServer() {
        // Guarded rather than disabled. A disabled button loses focus to <body>,
        // and this probe runs three stages at six seconds each, so a keyboard user
        // could be stranded for eighteen seconds. The button stays focusable and
        // reports aria-disabled instead.
        if (testing) return;
        setTesting(true);
        setTestStatus('Checking the server...');
        try {
            await saveSettings();
            const r = await TestServer(serverAddrRef.current.trim());
            setTestStatus(r.ok ? (r.message || 'Connected.') : 'Error: ' + r.message);
        } catch (e) {
            setTestStatus('Error: ' + e);
        } finally {
            setTesting(false);
        }
    }

    // serverNote is appended to transfer failures while a custom server is set.
    //
    // This is the moment a forgotten server override actually costs somebody
    // something: two people on different servers simply never find each other, and
    // every message they see describes a network problem. Settings can explain the
    // setting perfectly and still not reach a user who is not in Settings, so the
    // explanation has to come to them. Reads a ref because the send:error handler
    // is registered once and cannot see current state.
    function serverNote(): string {
        const s = serverAddrRef.current.trim();
        return s ? ` This app uses ${hostOf(s)}. Both people must be on the same server.` : '';
    }

    // Copies the About rows for pasting into a bug report. Mirrors SharePanel's
    // copy handler, including the 1500ms label flip.
    //
    // The server line is the whole reason this button is worth having: almost every
    // confusing report about a transfer that will not connect comes down to the two
    // people being on different servers, and that is invisible in a screenshot.
    async function copyAbout() {
        const lines = [
            'Floe desktop',
            `App version: ${appVer || 'dev'}`,
            `Transfer protocol: ${proto == null ? 'unknown' : proto}`,
            `Server: ${serverAddrRef.current.trim() || 'api.floe.one (default)'}`,
        ];
        if (webAddrRef.current.trim()) lines.push(`Share links: ${webAddrRef.current.trim()}`);
        try {
            await navigator.clipboard.writeText(lines.join('\n'));
            setAboutCopied(true);
            setTimeout(() => setAboutCopied(false), 1500);
        } catch {
            // clipboard unavailable
        }
    }

    // Clears both addresses and persists immediately. It cannot rely on the blur
    // path, because no input was focused when the button was pressed.
    async function useFloeServer() {
        setServerAddr('');
        setWebAddr('');
        setTestStatus('');
        serverAddrRef.current = '';
        webAddrRef.current = '';
        await saveSettings();
    }

    // Puts every setting this screen owns back to the value Floe ships with.
    //
    // Writes FIRST, then updates React state, so a failed write leaves the screen
    // showing what is actually still on disk. There is nothing to roll back.
    //
    // Calls SetSettings with explicit literals rather than going through
    // saveSettings(), which reads serverAddrRef and friends. Those refs are
    // assigned during render, so calling it in the same tick as setServerAddr('')
    // would persist the values being cleared. The refs are updated by hand here
    // for the same reason.
    //
    // It deliberately does NOT call EnableContextMenu. The Windows right-click
    // entry is registry state, not a setting this screen owns: enabling it writes
    // the running executable's path (and this binary ships under two names), and
    // clearing the 'floe:ctx-menu' marker alone would make the auto-enable branch
    // in the mount effect write the registry silently on the NEXT launch. Touch
    // both or neither, and the answer is neither. The dialog says so out loud.
    // Do not "fix" this by wiring the context menu in.
    async function resetAllSettings() {
        setResetErr('');
        try {
            await SetSettings('', '', false, true);
        } catch (e) {
            setResetErr('Error: could not save settings. ' + e);
            return;
        }
        setServerAddr('');
        setWebAddr('');
        setHideIP(false);
        setReportStats(true);
        setOutput('');
        setTestStatus('');
        serverAddrRef.current = '';
        webAddrRef.current = '';
        setConfirmDefaults(false);
        setResetDone('Settings are back to their defaults.');
        focusResetTrigger();
    }

    // Returns focus to the trigger after the dialog closes, so a keyboard user is
    // not dropped at the top of the document. The trigger is never unmounted, so
    // this always has somewhere to land.
    //
    // Looked up by id rather than by ref because Button is a plain React 18
    // function component shared with the transfer screen: accepting a ref would
    // mean wrapping it in forwardRef, and this is not worth widening that surface.
    // The rAF waits for the dialog to unmount before moving focus.
    function focusResetTrigger() {
        requestAnimationFrame(() => document.getElementById('floe-reset-trigger')?.focus());
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
            sendBytesRef.current = p.grandTotal || p.totalBytes;
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
            setHistory((prev) => [{kind: 'send' as const, names, count: names.length, bytes: sendBytesRef.current || undefined, at: Date.now()}, ...prev].slice(0, HISTORY_CAP));
        });
        EventsOn('send:error', (msg: string) => {
            if (sendCancel.current) return;
            setSendStatus('Error: ' + msg + serverNote());
            setSending(false);
            // The room is dead after an error; drop the stale code and link.
            setSendCode('');
            setSendLink('');
            setPeerConnected(false);
        });
        EventsOn('recv:progress', (p: Prog) => {
            if (recvCancel.current) return;
            recvBytesRef.current = p.grandTotal || p.totalBytes;
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
        // First run defaults it ON; an explicit user OFF (floe:ctx-menu = '0')
        // stays off. The auto-enable never writes the marker, so it records
        // user choice only and the default self-heals if the key vanishes.
        if (isWindows) {
            ContextMenuEnabled().then((on) => {
                if (on) {
                    setCtxMenu(true);
                    return;
                }
                if (localStorage.getItem('floe:ctx-menu') === null) {
                    EnableContextMenu().then(() => setCtxMenu(true)).catch(() => {});
                }
            }).catch(() => {});
        }
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

    // Settings live in a Go-owned file, not localStorage, so they survive the app
    // being installed under a different executable name: the WebView2 profile is
    // keyed to the executable's basename, and this binary ships as both
    // desktop.exe and floe-desktop.exe. Pulled once, the same way the About rows are.
    //
    // The toggles used to live in localStorage and are imported here exactly once.
    // `migrated` is what makes that safe in both directions: Go's zero value for a
    // bool is false while reportStats defaults to TRUE, so a fresh file is
    // indistinguishable from "switched everything off" without it, and re-running
    // the import would resurrect a preference the user had since changed.
    useEffect(() => {
        GetSettings()
            .then((c) => {
                setServerAddr(c.server || '');
                setWebAddr(c.web || '');
                if (c.migrated) {
                    setHideIP(c.hideIP);
                    setReportStats(c.reportStats);
                    return;
                }
                const hip = localStorage.getItem('floe:hideIP') === '1';
                const rep = localStorage.getItem('floe:report-stats') !== '0';
                setHideIP(hip);
                setReportStats(rep);
                void SetSettings(c.server || '', c.web || '', hip, rep);
            })
            .catch(() => {});
    }, []);

    // Persist only the transfer tabs; relaunching into History would be odd.
    useEffect(() => { if (mode !== 'history') localStorage.setItem('floe:mode', mode); }, [mode]);
    useEffect(() => { localStorage.setItem('floe:history', JSON.stringify(history)); }, [history]);
    useEffect(() => { localStorage.setItem('floe:saveDir', output); }, [output]);

    // Per-visit settings-screen state, forgotten when Settings closes by ANY route.
    // Collapsing Advanced is a per-visit choice, so reopening Settings with a
    // custom server configured always shows the fields again, which is what makes
    // "set it and forget it" structurally hard to do. The reset dialog and its
    // messages ride along here rather than being cleared at each exit point,
    // because doReset, addFiles and the history shortcut all close Settings
    // directly and would each need their own line otherwise.
    useEffect(() => {
        if (settingsOpen) return;
        setAdvOpen(null);
        setConfirmDefaults(false);
        setResetErr('');
        setResetDone('');
    }, [settingsOpen]);

    // Flush the addresses whenever Settings closes, by any route.
    //
    // The inputs save on blur, but React does not fire blur on unmount, and three
    // exits bypass it entirely: Escape, the Back button, and the Ctrl+H history
    // shortcut. Typing an address and pressing Escape used to discard it silently
    // while the field still showed the value, so the setting looked saved and was
    // not. Keyed on the closing edge only, so it does not run on mount.
    const wasSettingsOpen = useRef(false);
    useEffect(() => {
        if (wasSettingsOpen.current && !settingsOpen) void saveSettings();
        wasSettingsOpen.current = settingsOpen;
    }, [settingsOpen]);

    useEffect(() => { busyRef.current = sending || receiving; }, [sending, receiving]);

    // Leaving the history view abandons a pending Clear confirmation.
    useEffect(() => { if (mode !== 'history') setConfirmClear(false); }, [mode]);

    // Escape dismisses whichever overlay is on top, else the settings screen.
    //
    // The branch order matches the paint order below: Start over renders last and
    // so sits on top, and it is dismissed first. No guard is needed for
    // confirmDefaults, because its trigger only exists inside the settingsOpen
    // branch, so confirmDefaults implies settingsOpen.
    useEffect(() => {
        if (!settingsOpen && !confirmReset) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            if (confirmReset) setConfirmReset(false);
            else if (confirmDefaults) { setConfirmDefaults(false); focusResetTrigger(); }
            else setSettingsOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [settingsOpen, confirmReset, confirmDefaults]);

    // Ctrl/Cmd+R starts over (muscle memory for "reload"). preventDefault stops
    // WebView2 from doing a real reload, which would orphan a running transfer.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R')) {
                e.preventDefault();
                startOverRef.current();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // Ctrl/Cmd+V pastes files (copied in Explorer) or a screenshot into the send
    // list, mirroring drag-drop. Ignored while typing in a field (so pasting a
    // code or a text note is untouched), while a transfer is busy, and on OS
    // key-repeat so holding the key pastes once instead of flooding the list.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V'))) return;
            if (e.repeat) return;
            if (busyRef.current) return;
            const el = document.activeElement as HTMLElement | null;
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
            e.preventDefault();
            PasteFiles().then((paths) => { if (paths && paths.length) addFiles(paths); }).catch(() => {});
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // App-level shortcuts: Ctrl/Cmd + O / Enter / , and History on Ctrl+H
    // (Windows, Linux) or Cmd+Y (macOS). One listener, once-registered like the
    // paste/reset handlers; state-reading actions go through refs (openPickerRef /
    // primaryActionRef / toggleHistoryRef) so this never re-binds. Fields keep
    // their own Enter handlers, so the letter keys and Enter skip while typing
    // (prevents a double-fire); comma is global, like a standard prefs key.
    useEffect(() => {
        const openHistory = () => {
            setSettingsOpen(false);
            toggleHistoryRef.current();
        };
        const onKey = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey) || e.repeat) return;
            const el = document.activeElement as HTMLElement | null;
            const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
            switch (e.key.toLowerCase()) {
                case 'o': // add files: jump to Send > Files and open the picker
                    if (typing) return;
                    e.preventDefault();
                    openPickerRef.current();
                    break;
                case 'enter': // the current tab's primary action (fields handle their own)
                    if (typing) return;
                    e.preventDefault();
                    primaryActionRef.current();
                    break;
                case ',': // toggle Settings
                    e.preventDefault();
                    setSettingsOpen((o) => !o);
                    break;
                // History (also leaves the Settings screen). The key is platform
                // specific: macOS gets Cmd+Y, the Safari/Chrome/Edge/Firefox
                // convention, because Cmd+H is the "Hide <App>" item in the default
                // macOS app menu Wails installs when main.go sets no Menu. Binding
                // it there would hide Floe instead of showing History.
                case 'h':
                    if (isMac || typing) return; // leave Cmd+H to the Hide menu item
                    e.preventDefault();
                    openHistory();
                    break;
                case 'y':
                    if (!isMac || typing) return; // Ctrl+Y is Redo on Windows
                    e.preventDefault();
                    openHistory();
                    break;
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

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
        sendBytesRef.current = 0;
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
        recvBytesRef.current = 0;
        setRecvStatus('Connecting... keep this window open.');
        try {
            const dir = await ReceiveByCode(code.trim(), output.trim(), hideIP, reportStats);
            setRecvDir(dir);
            setRecvDone(true);
            setRecvProg(null);
            setRecvStatus('');
            const names = recvNamesRef.current;
            setHistory((prev) => [{kind: 'recv' as const, names, count: names.length, dir, bytes: recvBytesRef.current || undefined, at: Date.now()}, ...prev].slice(0, HISTORY_CAP));
        } catch (e: any) {
            setRecvStatus(recvCancel.current ? 'Cancelled.' : 'Error: ' + e + serverNote());
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

    // doReset returns the app to its just-launched state: it stands the engine
    // down (CancelTransfer) and clears every transient field while keeping
    // persisted preferences (hideIP/reportStats/ctxMenu/saveDir/history), just
    // like a real relaunch. Cancel refs go true first so late Go events are
    // swallowed; the next real transfer re-arms them.
    function doReset() {
        setConfirmReset(false);
        sendCancel.current = true;
        recvCancel.current = true;
        CancelTransfer().catch(() => {});

        setSettingsOpen(false);
        const stored = localStorage.getItem('floe:mode');
        const fresh = stored === 'send' || stored === 'receive' ? stored : 'send';
        setMode(fresh);
        prevModeRef.current = fresh;
        setConfirmClear(false);
        setExpandedRow(null);
        sendBytesRef.current = 0;
        recvBytesRef.current = 0;

        // Send
        setFiles([]);
        setSendKind('files');
        setSendText('');
        setSendCode('');
        setSendLink('');
        setSendStatus(INITIAL_SEND_STATUS);
        setSending(false);
        setSendProg(null);
        setSendDone(false);
        setSentCount(0);
        setPeerConnected(false);
        setFilesOpen(false);
        sendStart.current = null;
        sentNamesRef.current = [];

        // Receive
        setCode('');
        setRecvStatus(INITIAL_RECV_STATUS);
        setReceiving(false);
        setRecvProg(null);
        setRecvDir('');
        setRecvDone(false);
        recvStart.current = null;
        recvNamesRef.current = [];

        setRoute('');
    }

    // startOver is the Floe-lockup / Ctrl+R action. It confirms first only when
    // bytes are actively moving, so escaping a stuck (connecting/idle) state is
    // instant while a real transfer is protected from a fat-finger.
    function startOver() {
        if (sendProg || recvProg) {
            setConfirmReset(true);
            return;
        }
        doReset();
    }

    // Keep a stable reference to the latest startOver so the once-registered
    // Ctrl+R listener always sees current progress state without re-binding.
    const startOverRef = useRef(startOver);
    startOverRef.current = startOver;

    const busy = sending || receiving;
    // Amber marks anything relay-flavored: a known relayed route, or (before
    // the route is known / while idle) the Hide-my-IP preference forcing one.
    const relayTone = route ? route === 'relay' : hideIP;

    // The header clock toggles the history view; leaving returns to the tab it
    // covered. The ref never holds 'history' (only set when entering from a tab).
    function toggleHistory() {
        if (mode === 'history') {
            setMode(prevModeRef.current);
        } else {
            prevModeRef.current = mode;
            setMode('history');
        }
    }

    // Live refs to the shortcut actions so the once-registered keydown listener
    // always sees current state without re-binding (mirrors startOverRef above).
    const toggleHistoryRef = useRef(toggleHistory);
    toggleHistoryRef.current = toggleHistory;

    // Ctrl+O: leave Settings, land on Send > Files, open the native picker.
    function openPicker() {
        if (busy) return;
        setSettingsOpen(false);
        setMode('send');
        setSendKind('files');
        pickFiles();
    }
    const openPickerRef = useRef(openPicker);
    openPickerRef.current = openPicker;

    // Ctrl+Enter: the current tab's primary action, mirroring the action button's
    // enabled rules. No-op in Settings, while busy, or in History (no action there).
    function primaryAction() {
        if (busy || settingsOpen) return;
        if (mode === 'send') {
            if (sendKind === 'text' ? sendText.trim() : files.length) send();
        } else if (mode === 'receive') {
            if (code.trim()) receive();
        }
    }
    const primaryActionRef = useRef(primaryAction);
    primaryActionRef.current = primaryAction;

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

    // Advanced is open when the user says so, and otherwise whenever a non-default
    // address is configured. Derived rather than an effect: it is correct on the
    // very first render after GetSettings resolves, needs no guard against React's
    // double-invocation in development, and cannot fall out of step with the state
    // it describes.
    const usingCustomServer = serverAddr.trim() !== '';
    const usingCustomWeb = webAddr.trim() !== '';
    const advExpanded = advOpen ?? (usingCustomServer || usingCustomWeb);

    // Three states, not two. See settings.ts and its test.
    const advSummary = advancedSummary(serverAddr, webAddr);


    return (
        <div className="flex h-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100 selection:bg-ice/20">
            <TitleBar onSettings={() => setSettingsOpen((o) => !o)} settingsActive={settingsOpen} onStartOver={startOver}/>

            {settingsOpen ? (
            /* ── SETTINGS SCREEN ─────────────────────────────────────────── */
                <div className="flex flex-1 flex-col overflow-hidden">
                    <div className="custom-scrollbar flex-1 overflow-y-auto">
                        {/* The one entry animation: the whole column rises once. No
                            per-section stagger, nothing else on this screen animates
                            on mount. */}
                        <div className="mx-auto w-full max-w-lg px-8 py-8 animate-floe-in motion-reduce:animate-none">
                            <div className="flex items-center gap-3">
                                <Tooltip label="Back" keys="Esc">
                                    <button
                                        aria-label="Back"
                                        onClick={() => setSettingsOpen(false)}
                                        className="grid h-7 w-7 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
                                    >
                                        <ArrowLeft className="size-4"/>
                                    </button>
                                </Tooltip>
                                <h2 className="text-base font-semibold tracking-tight text-white">Settings</h2>
                                {/* Screen-scoped action: it acts on everything below it, so the
                                    header is where it belongs, and a whole card for one button was
                                    heavier than what it does.

                                    Deliberately NOT the mono uppercase of the History Clear
                                    control. That is the eyebrow voice, and it works there because
                                    it sits beside an actual Eyebrow; here its neighbour is the
                                    Settings h2 in sans, so mono read as a stray label rather than
                                    a control. It was also zinc-600 on zinc-950, which is 2.57:1
                                    and fails the 4.5:1 AA floor for text this size. zinc-400 is
                                    7.76:1, and the hover fill mirrors the Back button at the other
                                    end of the same row so the two read as a pair.
                                    align="end" keeps the bubble on the panel edge. */}
                                <Tooltip label="Reset all settings" align="end" className="ml-auto">
                                    <button
                                        id="floe-reset-trigger"
                                        onClick={() => { setResetDone(''); setResetErr(''); setConfirmDefaults(true); }}
                                        className="rounded-md px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ice/60"
                                    >
                                        Reset
                                    </button>
                                </Tooltip>
                            </div>
                            {/* Zero height. Sighted users watch the rows change by themselves;
                                this exists so screen readers are not left with silence. */}
                            <span className="sr-only" role="status" aria-live="polite">{resetDone}</span>

                            <div className="mt-6 space-y-6">
                                <section className="space-y-2">
                                    <Eyebrow as="h3">Transfers</Eyebrow>
                                    <div className={cardClass}>
                                        {/* The placeholder must stay in step with defaultReceiveDir
                                            (app.go:406) and with the receive screen's own field: a
                                            blank value saves to ~/Downloads, it does NOT prompt.
                                            An earlier "Ask every time" here was simply false. */}
                                        <SettingField
                                            htmlFor="floe-save-folder"
                                            label="Save received files to"
                                            description="Everything you receive is saved here. Leave it blank to use your Downloads folder."
                                            className="px-3.5 py-3"
                                        >
                                            {(ids) => (
                                                <div className="flex gap-2">
                                                    <Input
                                                        {...ids}
                                                        className="h-8 min-w-0 flex-1 font-mono text-xs"
                                                        placeholder="Downloads (default)"
                                                        value={output}
                                                        onChange={(e) => setOutput(e.target.value)}
                                                        spellCheck={false}
                                                        autoComplete="off"
                                                    />
                                                    <Button variant="outline" className="h-8 shrink-0" onClick={pickSaveFolder}>
                                                        Browse
                                                    </Button>
                                                </div>
                                            )}
                                        </SettingField>
                                    </div>
                                </section>

                                <section className="space-y-2">
                                    <Eyebrow as="h3">Privacy</Eyebrow>
                                    {/* Both rows state the benefit first, then the cost, because a
                                        toggle described only by its cost reads as a trap. What is
                                        still missing (why the relay caps at 2 GB, that only the
                                        RECEIVER reports, relay-only failing on a server with no
                                        TURN) is on the launch list in desktop/README.md. */}
                                    <div className={cn(cardClass, insetHairline)}>
                                        <SettingRow
                                            checked={hideIP}
                                            onChange={(v) => { setHideIP(v); void saveSettings({hideIP: v}); }}
                                            label="Hide my IP address"
                                            description="The other person never sees your IP. Transfers go through a relay, so they are slower and capped at 2 GB."
                                        />
                                        <SettingRow
                                            checked={reportStats}
                                            onChange={(v) => { setReportStats(v); void saveSettings({reportStats: v}); }}
                                            label="Contribute to global stats"
                                            description="Each transfer you receive adds its size to a public total. Floe never sends file names or contents."
                                        />
                                    </div>
                                </section>

                                {isWindows && (
                                    <section className="space-y-2">
                                        <Eyebrow as="h3">Windows</Eyebrow>
                                        <div className={cardClass}>
                                            {/* The wording of this description is tied to contextmenu_windows.go:
                                                the entry is a legacy per-user verb under
                                                Software\Classes\*\shell\Floe, which Windows 11 files under
                                                "Show more options", and the `*` means files only. If that
                                                registration ever moves to IExplorerCommand, this text becomes
                                                wrong and has to change with it. The per-user/no-admin detail
                                                moved to the docs. */}
                                            <SettingRow
                                                checked={ctxMenu}
                                                onChange={toggleCtxMenu}
                                                label="Show in right-click menu"
                                                description="Right-click any file in File Explorer and pick Send with Floe. On Windows 11 it sits under Show more options."
                                            />
                                        </div>
                                    </section>
                                )}

                                <section className="space-y-2">
                                    <Eyebrow as="h3">Advanced</Eyebrow>
                                    {/* cardClass ALONE, never insetHairline or divide-y: a separator
                                        drawn on the card's second child would paint a stray line under
                                        the collapsed disclosure. The only interior linework lives inside
                                        the panel's clip, where the collapse animation hides it. */}
                                    <div className={cardClass}>
                                        {/* A button with aria-expanded rather than <details>. The same idiom
                                            as the history row below, and <details> would paint its open state
                                            before a controlled handler could run, because the toggle event is
                                            not cancelable. */}
                                        <button
                                            type="button"
                                            onClick={() => setAdvOpen(!advExpanded)}
                                            aria-expanded={advExpanded}
                                            aria-controls="floe-advanced-panel"
                                            className="flex w-full items-center justify-between gap-4 px-3.5 py-2.5 text-left transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ice/60"
                                        >
                                            <span className="min-w-0">
                                                <span className={rowLabelClass}>Server</span>
                                                <span className={rowDescClass}>{advSummary}</span>
                                            </span>
                                            <span className="flex shrink-0 items-center gap-2">
                                                {usingCustomServer && <StatusDot className="bg-ice"/>}
                                                <ChevronDown className={cn('size-4 text-zinc-500 transition-transform duration-200 motion-reduce:transition-none', advExpanded && 'rotate-180')}/>
                                            </span>
                                        </button>

                                        {/* The animated collapse: grid-rows 0fr/1fr plus visibility.
                                            `invisible` removes the collapsed content from the
                                            accessibility tree and tab order exactly as `hidden` did, and
                                            visibility interpolates discretely, so the panel stays visible
                                            through the whole 200ms collapse and from the first expanding
                                            frame. WebView2 and WKWebView 16+ animate it; older engines
                                            snap open, fully functional. Nothing may ever depend on
                                            transitionend. */}
                                        <div
                                            id="floe-advanced-panel"
                                            className={cn(
                                                'grid transition-[grid-template-rows,visibility] duration-200 ease-out motion-reduce:transition-none',
                                                advExpanded ? 'visible grid-rows-[1fr]' : 'invisible grid-rows-[0fr]',
                                            )}
                                        >
                                            <div className="min-h-0 overflow-hidden">
                                                {/* The div's own before: is the hairline under the
                                                    disclosure button, revealed by the height animation and
                                                    clipped to nothing while collapsed; insetHairline draws
                                                    the separators between the fields. */}
                                                <div className={cn('relative before:absolute before:inset-x-3.5 before:top-0 before:h-px before:bg-white/[0.05]', insetHairline)}>
                                                    <SettingField
                                                        htmlFor="floe-server-address"
                                                        label="Server address"
                                                        description="This server introduces the two devices and never touches your files. Both people need to be on the same one."
                                                        className="px-3.5 py-3"
                                                    >
                                                        {(ids) => (
                                                            <div className="flex gap-2">
                                                                <Input
                                                                    {...ids}
                                                                    className="h-8 min-w-0 flex-1 font-mono text-xs"
                                                                    placeholder="https://api.floe.one"
                                                                    value={serverAddr}
                                                                    onChange={(e) => { setServerAddr(e.target.value); setTestStatus(''); }}
                                                                    onBlur={saveOnBlur}
                                                                    spellCheck={false}
                                                                    autoComplete="off"
                                                                />
                                                                <Button
                                                                    variant="outline"
                                                                    onClick={testServer}
                                                                    aria-disabled={testing}
                                                                    className={cn('h-8 shrink-0', testing && 'opacity-50')}
                                                                >
                                                                    {testing ? 'Testing' : 'Test'}
                                                                </Button>
                                                            </div>
                                                        )}
                                                    </SettingField>
                                                    <SettingField
                                                        htmlFor="floe-share-link-address"
                                                        label="Share link address"
                                                        description="Set this only if your web app has its own address. Leave it blank and Floe uses the server address."
                                                        className="px-3.5 py-3"
                                                    >
                                                        {(ids) => (
                                                            <Input
                                                                {...ids}
                                                                className="h-8 font-mono text-xs"
                                                                placeholder={webPlaceholder(serverAddr)}
                                                                value={webAddr}
                                                                onChange={(e) => setWebAddr(e.target.value)}
                                                                onBlur={saveOnBlur}
                                                                spellCheck={false}
                                                                autoComplete="off"
                                                            />
                                                        )}
                                                    </SettingField>
                                                    {usingCustomServer && (
                                                        <div className="flex items-center justify-between gap-4 px-3.5 py-2.5 animate-floe-in motion-reduce:animate-none">
                                                            <span className="text-xs leading-4 text-zinc-500">This clears both addresses and puts you back on Floe's server.</span>
                                                            <Button variant="outline" className="h-7 shrink-0 text-xs" onClick={useFloeServer}>
                                                                Use Floe's server
                                                            </Button>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    {/* Deliberately outside the collapsible panel. An invisible or
                                        hidden ancestor removes the element from the accessibility tree
                                        entirely, so an aria-live region inside it would announce nothing,
                                        and collapsing mid-probe would discard a result the user is
                                        waiting for. */}
                                    <div className="px-3.5 pt-1.5">
                                        <StatusLine text={testStatus} busy={testing} live/>
                                    </div>
                                </section>

                                <section className="space-y-2">
                                    <Eyebrow as="h3">About</Eyebrow>
                                    {/* Readout rows flip the emphasis: dim label, legible mono value.
                                        No hover fills; nothing here is interactive except Copy. */}
                                    <div className={cn(cardClass, insetHairline)}>
                                        <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
                                            <span className={aboutLabelClass}>App version</span>
                                            <span className={aboutValueClass}>{appVer || 'dev'}</span>
                                        </div>
                                        <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
                                            {/* The dotted underline is the tooltip's discoverability
                                                affordance; without it the tooltip exists but nothing
                                                invites the hover. */}
                                            {/* Not "must match": CheckCompat is a range-overlap test,
                                                not equality, so compatible versions can differ. */}
                                            <Tooltip label="Both devices need compatible versions. Update the older app if a transfer will not start.">
                                                <span className={cn(aboutLabelClass, 'cursor-default underline decoration-dotted decoration-zinc-600 underline-offset-4')}>Transfer protocol</span>
                                            </Tooltip>
                                            <span className={aboutValueClass}>{proto == null ? '...' : `Version ${proto}`}</span>
                                        </div>
                                        {/* The permanent record of which server this app is on. It lives here,
                                            in a section that can never be collapsed, so that collapsing
                                            Advanced can never hide the fact that a custom server is set. */}
                                        <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
                                            <span className={aboutLabelClass}>Server</span>
                                            <span className="flex min-w-0 items-center justify-end gap-2">
                                                {usingCustomServer && <StatusDot className="bg-ice"/>}
                                                <span className="min-w-0 break-all text-right font-mono text-xs text-zinc-300">
                                                    {usingCustomServer ? hostOf(serverAddr) : 'api.floe.one (default)'}
                                                </span>
                                            </span>
                                        </div>
                                        {usingCustomWeb && (
                                            <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
                                                <span className={aboutLabelClass}>Share links</span>
                                                <span className="min-w-0 break-all text-right font-mono text-xs text-zinc-300">{hostOf(webAddr)}</span>
                                            </div>
                                        )}
                                        <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
                                            <span className="text-xs leading-4 text-zinc-500">These are the details to include in a bug report.</span>
                                            <Button variant="outline" className="h-7 shrink-0 text-xs" onClick={copyAbout}>
                                                {aboutCopied ? 'Copied' : 'Copy'}
                                            </Button>
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
                                {n: '01', title: 'Direct & unlimited', note: 'Direct transfers stream device to device with no size cap. Relay fallback is capped at 2 GB.'},
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
                        <span aria-hidden className="h-3 w-px bg-white/10"/>
                        <button
                            onClick={() => BrowserOpenURL('https://www.floe.one/docs')}
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
                                </div>
                                <div className="flex items-center gap-3">
                                    {/* one-word status; the dot color carries the route (site parity:
                                        green = direct, amber = relay), details live in the tooltip */}
                                    <Tooltip
                                        label={busy
                                            ? (route === 'relay' ? 'Relay connection' : route === 'direct' ? 'Direct peer connection' : 'Connecting')
                                            : hideIP ? 'Hide my IP is on. Transfers go through the relay (capped at 2 GB).' : 'Ready for a transfer'}
                                    >
                                        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                                            <StatusDot className={cn('transition-colors duration-500', relayTone ? 'bg-amber-500' : 'bg-green-500')} pulse={busy}/>
                                            {busy ? (route ? (route === 'relay' ? 'Relay' : 'Direct') : 'Active') : 'Ready'}
                                        </span>
                                    </Tooltip>
                                    <Tooltip label="History" keys={isMac ? '⌘Y' : 'Ctrl+H'} align="end">
                                        <button
                                            onClick={toggleHistory}
                                            aria-label="History"
                                            aria-pressed={mode === 'history'}
                                            className={cn(
                                                'grid h-7 w-7 place-items-center rounded-md transition-colors hover:bg-white/10',
                                                mode === 'history' ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-300',
                                            )}
                                        >
                                            <History className="size-4"/>
                                        </button>
                                    </Tooltip>
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
                                                    : `Send${files.length ? ` ${files.length} ${files.length === 1 ? 'item' : 'items'}` : ''}`}
                                            </Button>
                                        )}

                                        {/* share surface: waiting stage only — the 1:1 room is consumed
                                            once the receiver joins, so the code is dead from then on */}
                                        {sending && sendLink && !peerConnected && !sendProg && (
                                            <SharePanel code={sendCode} link={sendLink}/>
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
                                                placeholder="amber-otter-cloud"
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
                                                    placeholder="Downloads (default)"
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
                                        {recvDir && !receiving && (() => {
                                            // recvNamesRef is a ref, but recvDir is set (setRecvDir) only after
                                            // receive() completes, so the names are fully populated by this render.
                                            const only = recvNamesRef.current.length === 1 ? recvNamesRef.current[0] : '';
                                            return only ? (
                                                <div className="animate-floe-in flex gap-2">
                                                    <Button variant="outline" className="flex-1" onClick={() => { OpenFile(recvDir, only).catch(() => {}); }}>
                                                        <SquareArrowOutUpRight/> Open
                                                    </Button>
                                                    <Button variant="outline" className="flex-1" onClick={() => { RevealFile(recvDir, only).catch(() => {}); }}>
                                                        <FolderOpen/> Show in folder
                                                    </Button>
                                                </div>
                                            ) : (
                                                <Button variant="outline" className="animate-floe-in w-full" onClick={() => { OpenFolder(recvDir).catch(() => {}); }}>
                                                    <FolderOpen/> Show in folder
                                                </Button>
                                            );
                                        })()}
                                        <StatusLine text={recvStatus} busy={receiving}/>
                                    </div>

                                ) : (
                                /* ── HISTORY VIEW ─────────────────────────────── */
                                    <div className="space-y-3">
                                        <div className="flex items-baseline justify-between px-0.5">
                                            <Eyebrow>History</Eyebrow>
                                            {history.length > 0 && !confirmClear && (
                                                <button
                                                    onClick={() => setConfirmClear(true)}
                                                    className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600 transition-colors hover:text-zinc-300"
                                                >
                                                    Clear
                                                </button>
                                            )}
                                            {confirmClear && (
                                                <span className="animate-floe-in flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.2em]">
                                                    <span className="text-zinc-500">Clear all?</span>
                                                    <button
                                                        onClick={() => { setHistory([]); setConfirmClear(false); }}
                                                        className="text-red-400 transition-colors hover:text-red-300"
                                                    >
                                                        Yes
                                                    </button>
                                                    <button
                                                        onClick={() => setConfirmClear(false)}
                                                        className="text-zinc-600 transition-colors hover:text-zinc-300"
                                                    >
                                                        No
                                                    </button>
                                                </span>
                                            )}
                                        </div>
                                        {history.length === 0 ? (
                                            <p className="py-8 text-center text-xs text-zinc-500">No transfers yet.</p>
                                        ) : (
                                            <ul className="custom-scrollbar max-h-80 divide-y divide-white/[0.04] overflow-y-auto rounded-lg border border-white/[0.06] bg-white/[0.02]">
                                                {history.map((h, i) => {
                                                    const key = `${h.at}-${i}`;
                                                    const multi = h.count > 1;
                                                    const expanded = expandedRow === key;
                                                    return (
                                                        <li key={key} className="group px-3.5 py-2.5 transition-colors hover:bg-white/[0.03]">
                                                            <div
                                                                className={cn('flex items-center gap-3', multi && 'cursor-pointer')}
                                                                onClick={multi ? () => setExpandedRow(expanded ? null : key) : undefined}
                                                            >
                                                                {h.kind === 'send'
                                                                    ? <ArrowUpRight className="size-4 shrink-0 text-zinc-500"/>
                                                                    : <ArrowDownLeft className="size-4 shrink-0 text-zinc-500"/>}
                                                                <span className="min-w-0 flex-1">
                                                                    <span className="block truncate text-sm text-zinc-200">
                                                                        {h.count === 1 ? (h.names[0] || '1 file') : `${h.count} files`}
                                                                    </span>
                                                                    <span className="flex items-center gap-2 text-xs text-zinc-500">
                                                                        <span>{h.kind === 'send' ? 'Sent' : 'Received'}</span>
                                                                        {h.bytes != null && h.bytes > 0 && <span>{fmtBytes(h.bytes)}</span>}
                                                                        <span>{fmtWhen(h.at)}</span>
                                                                    </span>
                                                                </span>
                                                                {multi && (
                                                                    <button
                                                                        onClick={(e) => { e.stopPropagation(); setExpandedRow(expanded ? null : key); }}
                                                                        aria-label={expanded ? 'Hide files' : 'Show files'}
                                                                        aria-expanded={expanded}
                                                                        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-600 transition-colors hover:bg-white/10 hover:text-zinc-200"
                                                                    >
                                                                        <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}/>
                                                                    </button>
                                                                )}
                                                                {h.kind === 'recv' && h.dir && (
                                                                    <button
                                                                        onClick={(e) => { e.stopPropagation(); (h.count === 1 ? RevealFile(h.dir!, h.names[0] || '') : OpenFolder(h.dir!)).catch(() => {}); }}
                                                                        aria-label="Show in folder"
                                                                        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-500 opacity-0 transition-[color,background-color,opacity] hover:bg-white/10 hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100"
                                                                    >
                                                                        <FolderOpen className="size-3.5"/>
                                                                    </button>
                                                                )}
                                                                <button
                                                                    onClick={(e) => { e.stopPropagation(); setHistory((prev) => prev.filter((_, idx) => idx !== i)); }}
                                                                    aria-label="Remove entry"
                                                                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-500 opacity-0 transition-[color,background-color,opacity] hover:bg-white/10 hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100"
                                                                >
                                                                    <X className="size-3.5"/>
                                                                </button>
                                                            </div>
                                                            {expanded && (
                                                                <ul className="custom-scrollbar mt-2 max-h-32 space-y-1 overflow-y-auto pl-7">
                                                                    {h.names.map((n, j) => (
                                                                        <li key={`${key}-${j}`} className="truncate text-xs text-zinc-500">{n}</li>
                                                                    ))}
                                                                </ul>
                                                            )}
                                                        </li>
                                                    );
                                                })}
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

            {/* Rendered BEFORE the start-over guard on purpose. Paint order and
                Escape order have to agree: the guard protects a live transfer, so
                it must sit on top and be dismissed first, and a preferences dialog
                must never occlude it. */}
            {confirmDefaults && (
                <div className="fixed inset-x-0 bottom-0 top-9 z-50 grid place-items-center bg-black/60 backdrop-blur-sm">
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="floe-reset-title"
                        className="animate-floe-in mx-4 w-full max-w-sm rounded-xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
                    >
                        <h2 id="floe-reset-title" className="text-sm font-semibold text-white">Reset all settings?</h2>
                        <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
                            Your save folder, both privacy switches and the server addresses go back to the way Floe shipped.
                        </p>
                        {/* Names what the user will actually notice. The path is the
                            thing they cannot retype from memory, so it is shown in
                            full rather than summarised. */}
                        {(output.trim() !== '' || !reportStats) && (
                            <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                                {output.trim() !== '' && (
                                    <>Floe will forget <span className="break-all font-mono text-zinc-300">{output.trim()}</span> and save to your Downloads folder again.</>
                                )}
                                {output.trim() !== '' && !reportStats && ' '}
                                {!reportStats && (
                                    <>Floe will {output.trim() !== '' ? 'also ' : ''}start adding the size of transfers you receive to the public total again.</>
                                )}
                            </p>
                        )}
                        {/* The exclusions, stated rather than left to be discovered.
                            An unstated exclusion is what makes a reset feel dishonest. */}
                        <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                            Your transfer history and the files you have already received are left alone{isWindows ? ', and so is your right-click menu, because that entry lives in Windows rather than in Floe' : ''}.
                        </p>
                        <StatusLine text={resetErr} busy={false}/>
                        <div className="mt-4 flex justify-end gap-2">
                            <Button variant="outline" onClick={() => { setConfirmDefaults(false); focusResetTrigger(); }}>Cancel</Button>
                            <Button onClick={resetAllSettings}>Reset all settings</Button>
                        </div>
                    </div>
                </div>
            )}

            {/* start-over guard: only shown when a transfer is actively moving
                bytes, so escaping a stuck state stays one click. Sits below the
                titlebar so the window controls remain reachable. */}
            {confirmReset && (
                <div className="fixed inset-x-0 bottom-0 top-9 z-50 grid place-items-center bg-black/60 backdrop-blur-sm">
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="floe-startover-title"
                        className="animate-floe-in mx-4 w-full max-w-sm rounded-xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
                    >
                        <h2 id="floe-startover-title" className="text-sm font-semibold text-white">Start over?</h2>
                        <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">A transfer is in progress. Starting over will cancel it.</p>
                        <div className="mt-4 flex justify-end gap-2">
                            <Button variant="outline" onClick={() => setConfirmReset(false)}>Keep going</Button>
                            <Button onClick={doReset}>Start over</Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default App;
