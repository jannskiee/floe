import {useEffect, useRef, useState} from 'react';
import type {CSSProperties, MutableRefObject, ReactNode} from 'react';
import {
    CancelTransfer,
    CheckForUpdate,
    ContextMenuEnabled,
    DisableContextMenu,
    EnableContextMenu,
    EngineProtocolVersion,
    GetPendingFiles,
    GetSettings,
    GetVersion,
    IsPackaged,
    OpenFile,
    OpenFolder,
    PasteFiles,
    ReceiveByCode,
    RevealFile,
    SelectFiles,
    SelectFolder,
    SetCheckUpdates,
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
import {histKey} from './history';
import {UNDO_WINDOW_MS, clearLabel, clearedAnnouncement, clearedLabel, isExpired, stagedSnapshot, undoLabel, type Cleared} from './clear';
import {resetWarning} from './reset';
import {friendlyError} from './errors';
import {fmtBytes, formatIncoming, type IncomingPreview} from './incoming';
import {DOWNLOAD_URL, bareVersion, isNewerDesktopVersion} from './update';
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
    // On-disk name the receiver wrote, relative to the save folder. Differs from
    // fileName when a collision was de-duplicated to "name (1).ext". Empty on
    // send events. Anything that opens or reveals a received file must use this.
    savedName: string;
}

type Marker = {t: number; bytes: number} | null;

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
    let label = `${tag}${p.savedName || p.fileName} - ${pct}%  (${fmtBytes(num)} / ${fmtBytes(denom)})`;
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

/** UpdateNotice is the app's one toast, and a notice only: nothing downloads or
 *  installs here, so it carries a single action plus a dismiss (a "Later"
 *  button would just be a second X, and snooze semantics belong to
 *  auto-updaters with a payload waiting). It persists until acted on: an
 *  actionable notice that auto-hides is one most users never see, and there is
 *  no notification center to replay it. z-30 keeps tooltips (z-40) and the
 *  dialogs (z-50) painting over it, so the documented paint-order/Escape
 *  invariant is untouched; Escape closes it only while focus is inside the
 *  card, never from the global chain. It must not steal focus on appear.
 *  Screen-reader announcement lives in the persistent sr-only region at the
 *  app root, not here: a live region that mounts with its content already
 *  inside announces nothing. */
function UpdateNotice({version, onDismiss}: {version: string; onDismiss: () => void}) {
    return (
        <div
            role="group"
            aria-label="Update available"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDismiss(); } }}
            className={cn(
                'floe-notice-edge fixed right-4 top-[52px] z-30 isolate flex h-12 items-center gap-3 rounded-xl pl-4 pr-1.5',
                'bg-zinc-900/80 ring-1 ring-inset ring-white/10 backdrop-blur-xl backdrop-saturate-150',
                'shadow-[0_1px_1px_rgba(0,0,0,0.06),0_4px_8px_-4px_rgba(0,0,0,0.28),0_16px_32px_-12px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.07)]',
                'animate-floe-notice-in motion-reduce:animate-none',
            )}
        >
            {/* strokeWidth 3 on a 16px lucide renders a whole 2.0 device px, so
                the glyph is true white and crisp; the default 2 draws 1.33px
                straddling pixel boundaries, which antialiases to fuzzy grey. */}
            <Download className="size-4 shrink-0 text-white" strokeWidth={3} aria-hidden/>
            <div className="flex min-w-0 items-center gap-2">
                <h2 className="whitespace-nowrap text-[13px] font-semibold leading-none tracking-[-0.01em] text-zinc-50">Update available</h2>
                {/* A chip, not bare text, by the owner's choice: the boxed
                    version reads as a badge. Center-aligned like any badge, so
                    no baseline nudge. */}
                <span className="whitespace-nowrap rounded bg-white/[0.07] px-1.5 py-1 font-mono text-[11px] leading-none text-zinc-300">{bareVersion(version)}</span>
            </div>
            <div className="flex shrink-0 items-center">
                {/* No px override: cn is a plain join, so the base px-3 wins
                    over any px-* here anyway (equal specificity, later in the
                    sheet). h-7 and text-xs do apply. */}
                <Button className="h-7 text-xs" onClick={() => { BrowserOpenURL(DOWNLOAD_URL); onDismiss(); }}>
                    Get update
                </Button>
                {/* Ink-symmetric margins, not flex gaps: the button's edge is
                    flush while the X's ink sits ~10px inside its hit box, so
                    14px of margin on the button side and 4px on the X side
                    give the divider equal ~14px optical gaps to both. */}
                <span className="ml-3.5 mr-1 h-5 w-px bg-white/[0.14]" aria-hidden/>
                <button
                    aria-label="Dismiss update notice"
                    onClick={onDismiss}
                    className="grid size-7 shrink-0 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-ice"
                >
                    <X className="size-3.5"/>
                </button>
            </div>
        </div>
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
            <div style={dropVar} className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-white/40 bg-white/[0.02] py-1.5 pl-3 pr-1.5 transition-colors hover:border-white/70">
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
        <div style={dropVar} className="group rounded-xl border border-dashed border-white/40 bg-white/[0.02] p-5 text-center transition-colors hover:border-white/70 hover:bg-white/[0.03]">
            <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] transition group-hover:border-white/25">
                <UploadCloud className="h-5 w-5 text-white/70 transition group-hover:text-white"/>
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
    // Whether the "start over?" confirm overlay is showing. Not only about a live
    // transfer: see resetWarning in reset.ts for every state that raises it.
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
    // The note the last COMPLETED send put on the wire, '' when that send was
    // files. Start over compares the box against it: send:done leaves the
    // textarea mounted and still full, so this is the only way to tell "the note
    // I just sent is sitting there" (no prompt) from "I have started typing the
    // next one" (prompt, because that text lives in this field and nowhere else).
    const [sentText, setSentText] = useState('');
    const [peerConnected, setPeerConnected] = useState(false);
    const [filesOpen, setFilesOpen] = useState(false);
    // What Clear last took away, and the timer that retires the offer to put it
    // back. The snapshot is state because the offer renders from it; the timer
    // id is a ref because nothing renders from it and because the
    // once-registered handlers have to be able to cancel it.
    const [cleared, setCleared] = useState<Cleared | null>(null);
    const clearedTimer = useRef<number | null>(null);
    // When the standing offer runs out. Checked again on the click, because a
    // background window can have its timers clamped; Infinity while held.
    const clearedUntil = useRef(0);
    // Marks the one programmatic focus clearStaged performs, so that landing on
    // Undo does not read as "the user reached for it" and stop the countdown.
    const undoAutoFocus = useRef(false);
    const sendStart = useRef<Marker>(null);
    const sendCancel = useRef(false);
    // Snapshot of the sent file names, readable from the once-registered
    // send:done closure (which must not touch React state directly).
    const sentNamesRef = useRef<string[]>([]);
    // The text handed to the engine by the send in flight, '' for a file send.
    // Same once-registered-closure rule as sentNamesRef above: send:done reads
    // this rather than sendText, which it would only ever see as '' from mount.
    const outgoingTextRef = useRef('');
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
    // The pre-transfer preview line ("Incoming: 3 files · 812 MB"), set by the
    // recv:incoming event before the first byte lands.
    const [incoming, setIncoming] = useState('');
    const recvStart = useRef<Marker>(null);
    const recvCancel = useRef(false);
    // Monotonic id of the latest receive attempt: the frontend twin of the Go
    // generation tag. A cancelled attempt's promise settles AFTER an instant
    // restart has re-armed the UI, so its catch/finally must go quiet instead
    // of stomping the live attempt's state.
    const recvAttempt = useRef(0);
    // Receive file names harvested from progress events (the Go throttle always
    // emits each file's final update, so every name is captured).
    const recvNamesRef = useRef<string[]>([]);
    // Total bytes of the in-flight receive, for the history entry.
    const recvBytesRef = useRef(0);

    // Local transfer history (successful transfers only), newest first.
    const [history, setHistory] = useState<HistEntry[]>(loadHistory);
    // Whether the destructive Clear action is awaiting its inline confirm.
    const [confirmClear, setConfirmClear] = useState(false);
    // Which history row (keyed by histKey, position-independent) is expanded.
    const [expandedRow, setExpandedRow] = useState<string | null>(null);

    // Selected ICE path of the in-flight transfer ('' until known). One transfer
    // at a time (busy-gated), so a single value covers send and receive.
    const [route, setRoute] = useState('');

    // Live busy flag for the OnFileDrop closure, which is registered once with []
    // deps and would otherwise read a stale `busy`.
    const busyRef = useRef(false);

    // Windows Explorer right-click menu registration state.
    const [ctxMenu, setCtxMenu] = useState(false);
    // Whether this build runs from an MSIX package (Microsoft Store install).
    // Packaged builds hide the right-click toggle: an MSIX process's registry
    // writes land in a private view Explorer never reads, so the entry cannot
    // work there. Defaults to false (fail-open, matching the Go probe), so the
    // NSIS/portable builds never lose the row to a detection hiccup.
    const [packaged, setPackaged] = useState(false);

    // About row data, fetched once from the Go side.
    const [appVer, setAppVer] = useState('');
    const [proto, setProto] = useState<number | null>(null);

    // Update notice. updateVer arrives from the Go checker at most once per
    // launch ('' = nothing to show). The dismissal is session state on
    // purpose: the notice may legitimately return on a later launch while the
    // build is still behind, and nothing on disk needs to remember an X.
    const [updateVer, setUpdateVer] = useState('');
    const [updateDismissed, setUpdateDismissed] = useState(false);
    const [checkUpdates, setCheckUpdates] = useState(true);

    // addFiles merges incoming paths into the send selection. Shared by OS
    // drops, second-instance launches, and cold-start args; safe to call from
    // once-registered closures (functional updates + stable setters only).
    function addFiles(paths: string[]) {
        if (!paths || !paths.length || busyRef.current) return;
        forgetCleared();
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

    // Not routed through saveSettings: the field is owned by its own Go setter
    // so the Settings screen's whole-record save can never clobber it.
    async function toggleCheckUpdates(v: boolean) {
        setCheckUpdates(v);
        try {
            await SetCheckUpdates(v);
        } catch {
            setCheckUpdates(!v); // revert on failure, the toggleCtxMenu pattern
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
            await SetCheckUpdates(true);
        } catch (e) {
            // Two persists means a partial failure is possible: re-pull what
            // actually landed on disk so the screen never diverges from it.
            try {
                const c = await GetSettings();
                setServerAddr(c.server || '');
                setWebAddr(c.web || '');
                setHideIP(c.hideIP);
                setReportStats(c.reportStats);
                setCheckUpdates(!c.noUpdateCheck);
                serverAddrRef.current = c.server || '';
                webAddrRef.current = c.web || '';
            } catch { /* unreadable config: leave the screen as is */ }
            setResetErr('Error: could not save settings. ' + e);
            return;
        }
        setServerAddr('');
        setWebAddr('');
        setHideIP(false);
        setReportStats(true);
        setCheckUpdates(true);
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
            // Record what went out, so Start over can tell the note that was
            // delivered from one typed afterwards. Only a completed send writes
            // this, so a failed or cancelled one leaves the note unsent and it
            // keeps its prompt. Guarded on non-empty because a file send must not
            // erase the record of a note that really did go out earlier.
            if (outgoingTextRef.current) setSentText(outgoingTextRef.current);
            const names = sentNamesRef.current;
            setHistory((prev) => [{kind: 'send' as const, names, count: names.length, bytes: sendBytesRef.current || undefined, at: Date.now()}, ...prev].slice(0, HISTORY_CAP));
        });
        EventsOn('send:error', (msg: string) => {
            if (sendCancel.current) return;
            setSendStatus(friendlyError(msg) + serverNote());
            setSending(false);
            // The progress row goes with the transfer. Left behind it froze
            // on screen at whatever percent it died at, and worse, kept Start
            // over's "a transfer is in progress" branch true for a dead
            // transfer, which then outranked and hid the unsent-note warning.
            // cancel() has always done this; the error path never did.
            setSendProg(null);
            // The room is dead after an error; drop the stale code and link.
            setSendCode('');
            setSendLink('');
            setPeerConnected(false);
        });
        EventsOn('recv:incoming', (p: IncomingPreview) => {
            if (recvCancel.current) return;
            setIncoming(formatIncoming(p));
        });
        EventsOn('recv:progress', (p: Prog) => {
            if (recvCancel.current) return;
            recvBytesRef.current = p.grandTotal || p.totalBytes;
            setRecvProg(track(recvStart, p));
            // Collect the on-disk names (savedName): after a collision the file
            // lands as "name (1).ext", and Open/Reveal and history must target
            // that, not the sender's name, or they act on the pre-existing file.
            const name = p.savedName || p.fileName;
            if (name && !recvNamesRef.current.includes(name)) recvNamesRef.current.push(name);
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
        //
        // Skipped entirely in a packaged (Microsoft Store) build: the write
        // would land in the package's private registry view, Explorer would
        // never show the entry, and ContextMenuEnabled could then read the
        // private copy back as "on" while the menu shows nothing. A failed
        // IsPackaged probe falls through to the unpackaged flow, matching the
        // Go side's fail-open default.
        if (isWindows) {
            const initCtxMenu = () => {
                ContextMenuEnabled().then((on) => {
                    if (on) {
                        setCtxMenu(true);
                        return;
                    }
                    if (localStorage.getItem('floe:ctx-menu') === null) {
                        EnableContextMenu().then(() => setCtxMenu(true)).catch(() => {});
                    }
                }).catch(() => {});
            };
            IsPackaged().then((p) => {
                if (p) {
                    setPackaged(true);
                    return;
                }
                initCtxMenu();
            }).catch(initCtxMenu);
        }
        return () => {
            EventsOff('send:code');
            EventsOff('send:status');
            EventsOff('send:progress');
            EventsOff('send:done');
            EventsOff('send:error');
            EventsOff('recv:incoming');
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

    // Update notice: one pull per launch, the same shape as the About rows
    // (pull, not an event: startup runs before listeners exist). Go owns the
    // daily cache and every opt-out gate; an empty version means nothing to
    // show and a failure means silence. The promise can take seconds on the
    // first launch of a day, so nothing waits on it - the card just appears.
    useEffect(() => {
        CheckForUpdate().then((u) => { if (u && u.version) setUpdateVer(u.version); }).catch(() => {});
    }, []);

    // Settings live in a Go-owned file, not localStorage, so they survive the
    // webview profile. The profile is pinned to a stable path now (it used to be
    // keyed to the exe basename, which is how these toggles got stranded when the
    // binary shipped under two names), but the Go file also gives atomic writes
    // and pre-webview readability. Pulled once, the same way the About rows are.
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
                // Not part of the migration below: the field never lived in
                // localStorage, and its zero value is the shipped default.
                setCheckUpdates(!c.noUpdateCheck);
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

    // Leaving the send view abandons a pending undo offer: it belongs to a screen
    // the user is no longer looking at, and its timer would otherwise fire there.
    // Settings is not a mode but it covers the send view all the same, so it
    // counts as leaving: without this, closing Settings inside the window would
    // bring a ghost offer back with a partly spent timer.
    useEffect(() => { if (mode !== 'send' || settingsOpen) forgetCleared(); }, [mode, settingsOpen]);

    // The undo timer is the one thing here that outlives a render, so it needs an
    // explicit teardown. (Started in the click handler, never in an effect: this
    // app renders under StrictMode, which double-invokes effects in dev.)
    useEffect(() => () => { if (clearedTimer.current !== null) clearTimeout(clearedTimer.current); }, []);

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

    // Ctrl/Cmd+R starts over (muscle memory for "reload").
    //
    // Skipped while a field has focus, like the o/Enter/h shortcuts below, but
    // for a sharper reason than theirs: this one destroys. doReset calls
    // setSendText(''), and a half-typed note lives in that state field and
    // nowhere else, so Ctrl+R with the caret in the textarea used to erase it
    // with no prompt and no undo. startOver's guard did not catch it either,
    // because nothing was transferring yet.
    //
    // preventDefault is belt and braces, not the mechanism. Wails disables the
    // webview's browser accelerator keys outright during setup
    // (PutAreBrowserAcceleratorKeysEnabled(false), frontend.go:589, ungated and
    // fatal on failure), and Ctrl+R is on that list, so this key has never been
    // able to reload the app. An earlier comment here claimed otherwise. It is
    // kept because it costs nothing and would still be right if Wails ever
    // stopped doing that.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R')) {
                e.preventDefault();
                const el = document.activeElement as HTMLElement | null;
                if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
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
                forgetCleared();
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
                forgetCleared();
                setFiles((prev) => mergePaths(prev, [dir]));
                setSendDone(false);
                setSendStatus('');
            }
        } catch {
            // dialog cancelled
        }
    }

    // No forgetCleared here, and not by oversight: an offer only ever stands over
    // an emptied tab, so there is no row left to remove from while one is up. If
    // Clear ever learns to clear a subset, this needs the call.
    function removeFile(path: string) {
        setFiles((prev) => prev.filter((f) => normPath(f) !== normPath(path)));
        setSendDone(false);
    }

    // forgetCleared retires a pending undo offer and its timer. Every path that
    // stages something new or moves the send view on calls it, so Undo can never
    // put a payload back into a screen that changed underneath it. Safe from the
    // once-registered closures: a ref and a stable setter, nothing else.
    function forgetCleared() {
        holdUndo();
        setCleared(null);
    }

    // holdUndo stops the countdown without retiring the offer, and armUndo
    // starts a fresh one. Pointing at the offer holds it, so it cannot expire
    // out from under the pointer travelling towards it.
    function holdUndo() {
        if (clearedTimer.current !== null) {
            clearTimeout(clearedTimer.current);
            clearedTimer.current = null;
        }
        clearedUntil.current = Infinity;
    }

    function armUndo() {
        if (clearedTimer.current !== null) return;
        clearedUntil.current = Date.now() + UNDO_WINDOW_MS;
        clearedTimer.current = window.setTimeout(() => {
            clearedTimer.current = null;
            // Never unmount the element the keyboard is sitting on. If Undo has
            // focus when its time runs out, hand focus back the way the settings
            // dialog hands it to the trigger that opened it. The target is the
            // active tab button, not Send: Send is disabled the moment a clear
            // empties the tab, and focus() on a disabled button goes nowhere.
            const onUndo = document.activeElement?.id === 'floe-undo-clear';
            setCleared(null);
            if (onUndo) requestAnimationFrame(() => document.getElementById('floe-send-kind')?.focus());
        }, UNDO_WINDOW_MS);
    }

    // clearStaged empties what the current tab is holding and offers it back for
    // a few seconds. No confirm: re-picking files is tedious rather than
    // destructive, the same judgement resetWarning makes about staged files, and
    // an undo catches the slip a prompt would have caught without taxing every
    // deliberate clear.
    function clearStaged() {
        const snap = stagedSnapshot(sendKind, files, sendText);
        if (!snap) return;
        forgetCleared();
        if (snap.kind === 'files') setFiles([]);
        else setSendText('');
        setSendDone(false);
        // Blanked for the same reason every staging path blanks it: whatever it
        // said was about a payload that no longer exists. Without this, a
        // "Cancelled." from an earlier send would reappear when the offer went.
        setSendStatus('');
        setCleared(snap);
        armUndo();
        // Clear unmounts with the last thing it cleared, so focus would fall to
        // the body. Moving it to Undo keeps the keyboard where the user was, and
        // is what tells a screen reader the offer exists: an aria-live region
        // that mounts with its own text already inside announces nothing, which
        // this file has learned twice already. The button describes itself with
        // the sentence beside it, so the landing reads "Undo, Cleared 12 items."
        // Same id lookup as focusResetTrigger, for the same reason.
        undoAutoFocus.current = true;
        requestAnimationFrame(() => {
            const el = document.getElementById('floe-undo-clear');
            if (el) el.focus();
            else undoAutoFocus.current = false;
        });
    }

    // Undo replaces rather than merges, because it cannot collide: anything that
    // could have staged something in the meantime has already retired the offer.
    function undoClear() {
        if (!cleared) return;
        if (isExpired(clearedUntil.current, Date.now())) { forgetCleared(); return; }
        const snap = cleared;
        forgetCleared();
        if (snap.kind === 'files') setFiles(snap.files);
        else setSendText(snap.text);
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
        forgetCleared();
        sendCancel.current = false;
        setSending(true);
        setSendDone(false);
        setRoute('');
        if (sendKind === 'text') {
            setSentCount(1);
            sentNamesRef.current = ['message.txt'];
            outgoingTextRef.current = sendText;
        } else {
            setSentCount(files.length);
            sentNamesRef.current = files.map((f) => baseName(f) || f);
            // A file send puts no text on the wire, so it must not claim any.
            outgoingTextRef.current = '';
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
            setSendStatus(friendlyError(e));
            setSending(false);
        }
    }

    async function receive() {
        if (!code.trim()) {
            setRecvStatus('Please enter a code or link.');
            return;
        }
        const attempt = ++recvAttempt.current;
        setReceiving(true);
        setRecvProg(null);
        setRecvDir('');
        setRecvDone(false);
        setIncoming('');
        setRoute('');
        recvCancel.current = false;
        recvStart.current = null;
        recvNamesRef.current = [];
        recvBytesRef.current = 0;
        setRecvStatus('Connecting... keep this window open.');
        try {
            const dir = await ReceiveByCode(code.trim(), output.trim(), hideIP, reportStats);
            if (recvAttempt.current !== attempt) return;
            setRecvDir(dir);
            setRecvDone(true);
            setRecvStatus('');
            const names = recvNamesRef.current;
            setHistory((prev) => [{kind: 'recv' as const, names, count: names.length, dir, bytes: recvBytesRef.current || undefined, at: Date.now()}, ...prev].slice(0, HISTORY_CAP));
        } catch (e: any) {
            if (recvAttempt.current !== attempt) return;
            setRecvStatus(recvCancel.current ? 'Cancelled.' : friendlyError(e) + serverNote());
        } finally {
            if (recvAttempt.current !== attempt) return;
            setReceiving(false);
            // Every exit clears the progress row, not just the successful one.
            // On failure it used to stay frozen on screen and keep Start over
            // convinced a transfer was still running, which showed the cancel
            // warning for a dead transfer and hid the unsent-note one behind it.
            setRecvProg(null);
        }
    }

    // cancel aborts the in-flight transfer: flag it so late Go events are ignored,
    // reset the UI optimistically, then close the connections on the Go side.
    function cancel() {
        forgetCleared();
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
            setIncoming('');
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
        // Invalidate any in-flight receive attempt: its promise settles on a
        // later tick, and without this bump its catch/finally would pass the
        // attempt guard and overwrite the fresh state this reset installs.
        recvAttempt.current++;
        CancelTransfer().catch(() => {});

        setSettingsOpen(false);
        const stored = localStorage.getItem('floe:mode');
        const fresh = stored === 'send' || stored === 'receive' ? stored : 'send';
        setMode(fresh);
        prevModeRef.current = fresh;
        setConfirmClear(false);
        setExpandedRow(null);
        forgetCleared();
        sendBytesRef.current = 0;
        recvBytesRef.current = 0;

        // Send
        setFiles([]);
        setSendKind('files');
        setSendText('');
        setSentText('');
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
        outgoingTextRef.current = '';

        // Receive
        setCode('');
        setRecvStatus(INITIAL_RECV_STATUS);
        setReceiving(false);
        setRecvProg(null);
        setRecvDir('');
        setRecvDone(false);
        setIncoming('');
        recvStart.current = null;
        recvNamesRef.current = [];

        setRoute('');
    }

    // startOver is the Floe-lockup / Ctrl+R action. It confirms first when the
    // reset would destroy something the user cannot get back: bytes actually
    // moving, or a note in the box that has not gone out. Everything else resets
    // on the first click or keypress, so escaping a stuck (connecting/idle)
    // state stays instant. resetWarning in reset.ts owns that decision and
    // supplies the sentence, so do not restate its rules here.
    function startOver() {
        if (resetLoss) {
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

    // What the send tab is holding, or null when it is empty. One rule, read by
    // three places: whether Send is enabled, whether Clear is offered at all, and
    // what an undo would have to put back.
    const staged = stagedSnapshot(sendKind, files, sendText);

    // Update-notice visibility. updateAvailable drives the quiet About row and
    // survives dismissal; showUpdate adds the popup's manners: never over a
    // live transfer, never behind a dialog's scrim, gone for the session once
    // dismissed. The isNewer re-check is defense in depth (Go already compared)
    // and keeps the card from flashing before GetVersion resolves.
    const updateAvailable = updateVer !== '' && isNewerDesktopVersion(updateVer, appVer);
    const showUpdate = updateAvailable && !updateDismissed && !busy && !confirmReset && !confirmDefaults;
    // What Start over would destroy, phrased for its own dialog, so the decision
    // to interrupt and the sentence explaining why can never drift apart. Empty
    // means nothing worth a prompt and the reset runs on the first click or
    // keypress, exactly as it did before.
    const resetLoss = resetWarning({
        transferring: !!(sendProg || recvProg),
        busy,
        text: sendText,
        sentText,
        // A cleared note lives in the undo offer and nowhere else, and Start
        // over drops the offer, so it earns the same prompt the box does.
        clearedText: cleared?.kind === 'text' ? cleared.text : '',
    });
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

            {/* App-scoped, so it renders on both screens: Settings is where
                version-curious users already are. The sr-only twin is the
                announcement: a live region only announces content CHANGES, so
                a region that mounts with the popup already inside it is
                silent (the StatusLine comment explains the same trap). This
                span exists from first paint and its text arrives later. */}
            <span className="sr-only" role="status" aria-live="polite">
                {updateAvailable ? `Update available: Floe ${bareVersion(updateVer)}. See Settings.` : ''}
            </span>
            {showUpdate && <UpdateNotice version={updateVer} onDismiss={() => setUpdateDismissed(true)}/>}

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
                                        toggle described only by its cost reads as a trap. The
                                        details left out here (why the relay caps at 2 GB, that only
                                        the RECEIVER reports, relay-only failing on a server with no
                                        TURN) live in the desktop docs: sending and settings. */}
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
                                        {/* Hidden for Store installs: the Store updates the app
                                            itself and the Go side never checks there, so the
                                            switch would be an inert control. */}
                                        {!packaged && (
                                            <SettingRow
                                                checked={checkUpdates}
                                                onChange={(v) => void toggleCheckUpdates(v)}
                                                label="Check for updates"
                                                description="Shows a notice when a new version is out. Asks GitHub once a day; off means no request at all."
                                            />
                                        )}
                                    </div>
                                </section>

                                {isWindows && !packaged && (
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
                                            <ChevronDown className={cn('size-4 shrink-0 text-zinc-500 transition-transform duration-200 motion-reduce:transition-none', advExpanded && 'rotate-180')}/>
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
                                                            <span className="text-xs leading-4 text-zinc-500">This removes both addresses and returns the app to api.floe.one.</span>
                                                            <Button variant="outline" className="h-7 shrink-0 text-xs" onClick={useFloeServer}>
                                                                Use default server
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
                                        No hover fills; nothing here is interactive except Copy and
                                        the update row's button. */}
                                    <div className={cn(cardClass, insetHairline)}>
                                        <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
                                            <span className={aboutLabelClass}>App version</span>
                                            <span className={aboutValueClass}>{appVer || 'dev'}</span>
                                        </div>
                                        {/* The popup's quiet, permanent mirror: it ignores the
                                            session dismissal, so the fact an update exists always
                                            has a home. Omitted entirely when up to date - a
                                            readout card earns no "all good" row. */}
                                        {updateAvailable && (
                                            <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
                                                <span className={aboutLabelClass}>Update</span>
                                                <span className="flex shrink-0 items-center gap-2.5">
                                                    <span className={aboutValueClass}>{bareVersion(updateVer)} available</span>
                                                    <Button variant="outline" className="h-7 shrink-0 text-xs" onClick={() => BrowserOpenURL(DOWNLOAD_URL)}>
                                                        Get update
                                                    </Button>
                                                </span>
                                            </div>
                                        )}
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
                                            Advanced can never hide the fact that a custom server is set.
                                            This row and the Advanced summary sentence are now the only two
                                            places that report it: an accent dot used to sit here and on the
                                            disclosure row, and both were removed deliberately. If a signal
                                            is ever wanted again, prefer words over a coloured mark, which
                                            carries nothing on its own for anyone who cannot see it. */}
                                        <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
                                            <span className={aboutLabelClass}>Server</span>
                                            <span className="min-w-0 break-all text-right font-mono text-xs text-zinc-300">
                                                {usingCustomServer ? hostOf(serverAddr) : 'api.floe.one (default)'}
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
                            {/* "no uploads", not "no middleman": a relayed
                                transfer does pass through a TURN relay (bullet
                                01 admits as much), while nothing is uploaded
                                on any path. Matches docs/introduction.mdx. */}
                            End-to-end encrypted. No accounts,<br/>no storage, no uploads.
                        </p>

                        <div className="mt-10 space-y-6">
                            {[
                                {n: '01', title: 'Direct & unlimited', note: 'Direct transfers stream device to device with no size cap. Relay fallback is capped at 2 GB.'},
                                // DTLS alone: data channels are SCTP over DTLS. SRTP carries
                                // media, which Floe never sends.
                                {n: '02', title: 'End-to-end encrypted', note: 'DTLS, the same as a video call.'},
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
                                                        // The active tab is where focus lands if the undo
                                                        // offer expires under the keyboard, so exactly one
                                                        // of the two carries the id at a time.
                                                        id={sendKind === k ? 'floe-send-kind' : undefined}
                                                        onClick={() => { forgetCleared(); setSendKind(k); }}
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
                                                onChange={(e) => { if (cleared) forgetCleared(); setSendText(e.target.value); }}
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

                                        {/* action: one slot across every stage, so the primary button stays
                                            put. Clear joins Send exactly when the tab is holding something,
                                            which is the same rule that enables Send, and never while
                                            sending, where the slot belongs to Cancel. A receive running on
                                            the other tab does not take Clear away: the send stage is
                                            separate state, and clearing it is both harmless and undoable.
                                            Send does narrow when
                                            Clear arrives; on Files that lands with the list and the label
                                            gaining its count, on Text it is the one visible shift, and it
                                            marks the moment there is something to send either way.
                                            Clear sits left of Send like the safe choice in this app's
                                            dialogs (Cancel before Reset all settings, Keep going before
                                            Start over), which also puts it first in the tab order. That is
                                            the opposite of the history row, where Remove is outermost, and
                                            deliberately so: that row has no primary action to defer to. */}
                                        {sending ? (
                                            <Button variant="outline" size="lg" className="w-full" onClick={cancel}>
                                                <X/> Cancel
                                            </Button>
                                        ) : (
                                            <div className="flex gap-3">
                                                {/* The visible word stays "Clear" because its object is
                                                    right there in the Send label beside it; the accessible
                                                    name carries that object for anyone who cannot see the
                                                    pair. No tooltip: a labelled button next to the thing it
                                                    acts on does not need one, and the wrapper would take
                                                    the layout classes with it. */}
                                                {staged && (
                                                    <Button
                                                        variant="secondary"
                                                        size="lg"
                                                        // A floor on the width so the short word cannot
                                                        // collapse into a chip beside a stretched primary,
                                                        // and font-medium so the pair differs by material
                                                        // rather than by weight as well as everything else.
                                                        className="min-w-24 font-medium"
                                                        onClick={clearStaged}
                                                        aria-label={clearLabel(staged)}
                                                    >
                                                        Clear
                                                    </Button>
                                                )}
                                                {/* The gradient paints over the primary variant's flat white,
                                                    because a background-image sits above a background-color.
                                                    That is also why the hover moves the stops instead of the
                                                    colour: the variant's own hover:bg-zinc-200 is underneath
                                                    the gradient and would never be seen. */}
                                                <Button
                                                    size="lg"
                                                    className="flex-1 bg-gradient-to-b from-white to-zinc-100 shadow-sm hover:from-zinc-100 hover:to-zinc-200"
                                                    onClick={send}
                                                    disabled={busy || !staged}
                                                >
                                                    <Send/> {sendKind === 'text'
                                                        ? 'Send text'
                                                        : `Send${files.length ? ` ${files.length} ${files.length === 1 ? 'item' : 'items'}` : ''}`}
                                                </Button>
                                            </div>
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
                                        {/* While it stands, the undo offer speaks for the status line:
                                            two rows of small print under the button would be one too many. */}
                                        {cleared ? (
                                            <p className="flex min-h-5 items-center justify-center gap-2 text-center text-xs">
                                                <span className="text-zinc-500">{clearedLabel(cleared)}</span>
                                                <button
                                                    type="button"
                                                    id="floe-undo-clear"
                                                    aria-label={undoLabel(cleared)}
                                                    onClick={undoClear}
                                                    onMouseEnter={holdUndo}
                                                    onMouseLeave={() => { if (cleared) armUndo(); }}
                                                    onFocus={() => { if (undoAutoFocus.current) { undoAutoFocus.current = false; return; } holdUndo(); }}
                                                    onBlur={() => { if (cleared) armUndo(); }}
                                                    className="rounded-md px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ice/60"
                                                >
                                                    Undo
                                                </button>
                                            </p>
                                        ) : (
                                            <StatusLine text={sendStatus} busy={sending}/>
                                        )}
                                        {/* Zero height, and mounted whether or not there is anything to
                                            say, because a live region only announces a CHANGE: one that
                                            mounts with its text already inside stays silent, which this
                                            file has learned twice (StatusLine's docblock, and the update
                                            notice's sr-only twin). sr-only is absolutely positioned, so it
                                            adds no row to the stack. Belt and braces with the focus move:
                                            whichever of the two a screen reader honours, the user hears
                                            both what went and that there is a way back. */}
                                        <span className="sr-only" role="status" aria-live="polite">
                                            {cleared ? clearedAnnouncement(cleared) : ''}
                                        </span>
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
                                                onKeyDown={(e) => { if (e.key === 'Enter' && !busy && code.trim()) receive(); }}
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

                                        {receiving && incoming && (
                                            <p className="animate-floe-in text-center text-xs text-zinc-400">{incoming}</p>
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
                                                    const key = histKey(h);
                                                    const multi = h.count > 1;
                                                    const expanded = expandedRow === key;
                                                    const panelId = `floe-hist-panel-${i}`;
                                                    return (
                                                        <li key={key} className="transition-colors hover:bg-white/[0.03]">
                                                            {/* The whole row is one disclosure button, the same idiom as the
                                                                Advanced section. Every entry expands, single-file rows included,
                                                                because collapsed titles truncate. Nothing else is clickable on
                                                                the row; the actions live inside the panel as labeled text. */}
                                                            <button
                                                                type="button"
                                                                onClick={() => setExpandedRow(expanded ? null : key)}
                                                                aria-expanded={expanded}
                                                                aria-controls={expanded ? panelId : undefined}
                                                                className="group flex w-full items-center gap-3 px-3.5 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ice/60"
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
                                                                <ChevronDown className={cn('size-3.5 shrink-0 text-zinc-600 transition-[color,transform] duration-200 group-hover:text-zinc-400 motion-reduce:transition-none', expanded && 'rotate-180')}/>
                                                            </button>
                                                            {expanded && (
                                                                <div id={panelId} className="animate-floe-in space-y-2 px-3.5 pb-2.5 motion-reduce:animate-none">
                                                                    {multi ? (
                                                                        <ul className="custom-scrollbar max-h-32 space-y-1 overflow-y-auto pl-7">
                                                                            {h.names.map((n, j) => (
                                                                                <li key={`${key}-${j}`} className="truncate text-xs text-zinc-500">{n}</li>
                                                                            ))}
                                                                        </ul>
                                                                    ) : h.names[0] ? (
                                                                        <p className="break-all pl-7 text-xs text-zinc-500">{h.names[0]}</p>
                                                                    ) : null}
                                                                    {h.kind === 'recv' && h.dir && (
                                                                        <p className="truncate pl-7 font-mono text-xs text-zinc-500" title={h.dir}>{h.dir}</p>
                                                                    )}
                                                                    {/* Footer actions behind an inset hairline. The border-t is the
                                                                        row dividers' white/[0.04] but stops at the px-3.5 content
                                                                        edges, so it reads as this panel's footer, not the next row's
                                                                        edge. Both actions group to the right rail, dialog-footer
                                                                        style with the destructive action outermost: Show in folder,
                                                                        then Remove. Remove's -mr-2 cancels its own px-2 so its label
                                                                        right-aligns to the px-3.5 rail under the chevron (hover pill
                                                                        mirroring into the gutter) - the same right-rail grammar as
                                                                        the header Clear and Settings' Reset. gap-4 keeps the safe
                                                                        action a deliberate reach away from the destructive one, and
                                                                        DOM order keeps Show in folder before Remove for Tab. */}
                                                                    <div className="flex items-center justify-end gap-4 border-t border-white/[0.04] pt-2">
                                                                        {h.kind === 'recv' && h.dir && (
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => { (h.count === 1 ? RevealFile(h.dir!, h.names[0] || '') : OpenFolder(h.dir!)).catch(() => {}); }}
                                                                                className="rounded-md px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ice/60"
                                                                            >
                                                                                Show in folder
                                                                            </button>
                                                                        )}
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => { setHistory((prev) => prev.filter((_, idx) => idx !== i)); setExpandedRow(null); }}
                                                                            className="-mr-2 rounded-md px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-red-400/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ice/60"
                                                                        >
                                                                            Remove
                                                                        </button>
                                                                    </div>
                                                                </div>
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
                            Your save folder, the privacy switches and the server addresses go back to the way Floe shipped.
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

            {/* start-over guard: shown only when the reset would destroy moving
                bytes or an unsent text note, so escaping a stuck state still
                stays one click. See resetWarning in reset.ts for exactly which
                states earn a prompt and which deliberately do not. Sits below
                the titlebar so the window controls remain reachable. */}
            {confirmReset && (
                <div className="fixed inset-x-0 bottom-0 top-9 z-50 grid place-items-center bg-black/60 backdrop-blur-sm">
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="floe-startover-title"
                        className="animate-floe-in mx-4 w-full max-w-sm rounded-xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
                    >
                        <h2 id="floe-startover-title" className="text-sm font-semibold text-white">Start over?</h2>
                        {/* resetWarning decided to open this dialog, so it also
                            supplies the sentence. One source, so the guard and
                            the copy cannot disagree about why you were stopped. */}
                        <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{resetLoss}</p>
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
