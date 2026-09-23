// Receive > REQUEST LINK: everything the owner sees of the Request link, one
// block per lane phase, drawn from the approved Checkpoint C canvas (DY, DE,
// DW, DC, DP, DD, DV, DO, DT and DX artboards). A top-level module component
// on purpose: declared inside App it would be a new type on every render and
// the label field would remount under the caret.
//
// Every string comes from requestCopy.ts. The only visitor-derived text that
// renders here is the engine's display-safe file name while a drop receives,
// as a React text node; the prompt shows numbers and host-computed values only.

import {useEffect, useRef, useState, type MouseEvent} from 'react';
import {AlertCircle, Check, ChevronDown, Folder, FolderOpen, Loader2, X} from 'lucide-react';
import {Button, cn, Eyebrow, Input} from './ui';
import * as copy from '../requestCopy';
import {etaLines, guardActive, GUARD_MS, type Phase, type RequestLinkSnapshot} from '../requestLink';
import {fmtEta, fmtSpeed, type Prog} from '../progress';

/** The link block and the activity slot below it: the phases in which a link
 *  exists on screen. Close link keeps one box across all of them (spec 06 5.5:
 *  the prompt mounts below, and nothing above it ever moves). */
const LINK_PHASES = new Set<Phase>(['waiting', 'reconnecting', 'connecting', 'deciding', 'declined']);

export const PROMPT_HEADING_ID = 'floe-request-prompt-heading';
export const LABEL_INPUT_ID = 'floe-request-label';

// Shared pieces of the canvas grammar.
const headClass = 'font-mono text-[10px] font-medium uppercase leading-4 tracking-[0.2em] text-zinc-300';
const t1Class = 'text-sm leading-normal text-zinc-200';
const t2Class = 'text-xs leading-relaxed text-zinc-400';
const t3Class = 'text-xs leading-relaxed text-zinc-500';
const warnClass = 'text-xs leading-relaxed text-amber-300/80';
// The quiet right-rail text action (Dismiss), the History row's Remove look.
const quietClass = '-mr-2 rounded-md px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ice/60';

export interface RequestLinkViewProps {
    phase: Phase;
    snap: RequestLinkSnapshot;
    /** The refusal code for the Error phase. */
    errorCode: string;
    /** The latest request:progress event of the running drop, or null. */
    progress: Prog | null;
    hideIP: boolean;
    /** The base folder for the next link (localStorage floe:requestSaveDir). */
    saveDir: string;
    onSaveDirChange: (v: string) => void;
    onMake: (label: string, lifetime: '24h' | '7d') => void;
    onClose: () => void;
    onAnswer: (promptGen: number, answer: 'accept' | 'decline' | 'keep-waiting') => void;
    onCancelDrop: () => void;
    onRetry: () => void;
    onShowInFolder: (folder: string) => void;
    onDismiss: () => void;
    onMakeAnother: () => void;
    onBrowse: () => void;
    /** Any edit of the form while an error shows (T5). */
    onEdit: () => void;
    /** The guard lifted on a prompt (A2 is announced once, by App). */
    onGuardLift: () => void;
    /** Whether the prompt block is in view (the notice hides while it is). */
    onPromptVisible: (visible: boolean) => void;
}

export default function RequestLinkView(props: RequestLinkViewProps) {
    const {phase, snap} = props;
    if (phase === 'ready' || phase === 'making' || phase === 'error') return <ReadyForm {...props}/>;
    if (LINK_PHASES.has(phase)) {
        return (
            <div className="space-y-4">
                <LinkBlock snap={snap} onClose={props.onClose}/>
                <div aria-hidden className="-mx-5 h-px bg-white/[0.06]"/>
                <ActivitySlot {...props}/>
            </div>
        );
    }
    if (phase === 'receiving') return <Receiving {...props}/>;
    if (phase === 'done' || phase === 'stopped') return <Result {...props}/>;
    if (phase === 'ended') {
        return (
            <div className="space-y-4">
                <p className={headClass}>{copy.linkHeading(snap.label)}</p>
                <p className={t1Class}>{copy.endedLine(snap.code, snap.expiresAt)}</p>
                <Button className="w-full" onClick={props.onMakeAnother}>{copy.MAKE_ANOTHER_LINK}</Button>
            </div>
        );
    }
    return null;
}

// ---- Ready, making and error (DY-01 to DY-03, DE-01 to DE-08) --------------
function ReadyForm({phase, errorCode, hideIP, saveDir, onSaveDirChange, onMake, onBrowse, onEdit}: RequestLinkViewProps) {
    // View-local only: what the owner is typing and choosing.
    const [label, setLabel] = useState('');
    const [lifetime, setLifetime] = useState<'24h' | '7d'>('24h');
    const making = phase === 'making';
    const edited = () => { if (phase === 'error') onEdit(); };
    return (
        <div className="space-y-4">
            <p className={t2Class}>{copy.READY_HELPER}</p>
            <div className="space-y-2">
                <div className="flex items-baseline justify-between px-0.5">
                    <Eyebrow><label htmlFor={LABEL_INPUT_ID}>{copy.LABEL_EYEBROW}</label></Eyebrow>
                    <span className="text-[11px] text-zinc-500">{copy.LABEL_HINT}</span>
                </div>
                <Input
                    id={LABEL_INPUT_ID}
                    value={label}
                    onChange={(e) => { setLabel(e.target.value); edited(); }}
                    disabled={making}
                    maxLength={64}
                    autoComplete="off"
                    spellCheck={false}
                />
            </div>
            <div className="space-y-2">
                <Eyebrow className="px-0.5"><label htmlFor="floe-request-save">{copy.SAVE_TO_EYEBROW}</label></Eyebrow>
                <div className="flex gap-3">
                    <Input
                        id="floe-request-save"
                        className="flex-1"
                        placeholder={copy.SAVE_TO_PLACEHOLDER}
                        value={saveDir}
                        onChange={(e) => { onSaveDirChange(e.target.value); edited(); }}
                        disabled={making}
                        autoComplete="off"
                        spellCheck={false}
                    />
                    <Button variant="outline" onClick={onBrowse} disabled={making}>
                        <Folder/> {copy.BROWSE}
                    </Button>
                </div>
            </div>
            <div className="space-y-2">
                <Eyebrow className="px-0.5"><label htmlFor="floe-request-lifetime">{copy.LINK_ENDS_EYEBROW}</label></Eyebrow>
                <div className="relative">
                    <select
                        id="floe-request-lifetime"
                        value={lifetime}
                        onChange={(e) => { setLifetime(e.target.value === '7d' ? '7d' : '24h'); edited(); }}
                        disabled={making}
                        className="h-[38px] w-full appearance-none rounded-md border border-white/10 bg-white/[0.03] px-3 pr-9 text-sm text-zinc-100 outline-none transition-[color,box-shadow] focus-visible:border-ice/50 focus-visible:ring-[3px] focus-visible:ring-ice/25 disabled:opacity-50"
                    >
                        <option value="24h" className="bg-zinc-900">{copy.LIFETIME_24H}</option>
                        <option value="7d" className="bg-zinc-900">{copy.LIFETIME_7D}</option>
                    </select>
                    <ChevronDown aria-hidden className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500"/>
                </div>
            </div>
            {hideIP && <p className={warnClass}>{copy.READY_HIDE_IP_LINE}</p>}
            {making ? (
                <Button className="w-full" disabled>
                    <Loader2 className="animate-spin"/> {copy.MAKING_LINK}
                </Button>
            ) : (
                <Button className="w-full" onClick={() => onMake(label.trim(), lifetime)}>{copy.MAKE_LINK}</Button>
            )}
            {phase === 'error' && (
                <p role="alert" className="flex min-h-5 items-center justify-center gap-2 text-center text-xs text-red-400">
                    <AlertCircle className="size-3.5 shrink-0"/>
                    <span>{copy.errorLine(errorCode)}</span>
                </p>
            )}
            <p className={t3Class}>{copy.READY_IP_LINE}</p>
        </div>
    );
}

// ---- The link block (DW-01): the fixed geometry of every link phase --------
function LinkBlock({snap, onClose}: {snap: RequestLinkSnapshot; onClose: () => void}) {
    const [copied, setCopied] = useState(false);
    const timer = useRef<number | null>(null);
    useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
    async function copyLink() {
        try {
            await navigator.clipboard.writeText(snap.link);
            setCopied(true);
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 1500);
        } catch {
            // clipboard unavailable
        }
    }
    return (
        <div className="space-y-4">
            <div className="space-y-2">
                <p id="floe-request-link-heading" className={headClass}>{copy.linkHeading(snap.label)}</p>
                <Input
                    readOnly
                    value={snap.link}
                    aria-labelledby="floe-request-link-heading"
                    className="font-mono text-xs"
                    onFocus={(e) => e.currentTarget.select()}
                />
                <div className="flex gap-3">
                    <Button className="flex-1" onClick={copyLink}>{copied ? copy.COPIED : copy.COPY_LINK}</Button>
                    {/* The one Close link, on the right rail, in the same box in
                        every link phase (the prompt mounts below the hairline). */}
                    <Button id="floe-close-link" variant="secondary" className="min-w-24" onClick={onClose}>{copy.CLOSE_LINK}</Button>
                </div>
                <p className={t3Class}>{copy.scopeLine(snap.expiresAt, Date.now())}</p>
            </div>
            <div className="flex min-w-0 items-baseline gap-3 px-0.5">
                <Eyebrow className="shrink-0">{copy.SAVE_TO_EYEBROW}</Eyebrow>
                <span className="truncate font-mono text-xs text-zinc-400" title={snap.saveDir}>{snap.saveDir}</span>
            </div>
        </div>
    );
}

// ---- The activity slot: waiting lines, reconnecting, connecting, the prompt
function ActivitySlot(props: RequestLinkViewProps) {
    const {phase, snap} = props;
    if (phase === 'deciding' && snap.prompt) {
        // Keyed on the prompt, so a new request gets a fresh guard.
        return <Prompt key={snap.promptGen} {...props}/>;
    }
    if (phase === 'declined') {
        return (
            <div className="space-y-1.5">
                <p className={t1Class}>{copy.DECLINED_LINE}</p>
                <p className={t2Class}>{copy.DECLINED_QUESTION}</p>
                <div className="h-0.5"/>
                <Button variant="outline" className="w-full" onClick={() => props.onAnswer(snap.promptGen, 'keep-waiting')}>{copy.KEEP_WAITING}</Button>
            </div>
        );
    }
    if (phase === 'reconnecting') {
        return (
            <div className="space-y-1.5">
                <p className={t1Class}>{copy.reconnectingLine(snap.expiresAt)}</p>
                <div className="h-0.5"/>
                <Button variant="outline" className="w-full" onClick={props.onRetry}>{copy.RETRY_NOW}</Button>
            </div>
        );
    }
    if (phase === 'connecting') {
        return (
            <div className="space-y-1.5">
                <p className="flex items-center gap-2 text-sm text-zinc-200">
                    <Loader2 className="size-3.5 shrink-0 animate-spin"/>
                    <span>{copy.CONNECTING_LINE}</span>
                </p>
                <p className={t3Class}>{copy.WAITING_IP_LINE}</p>
            </div>
        );
    }
    // Waiting, or deciding without a prompt yet.
    const reopened = copy.reopenLine(snap);
    return reopened ? (
        <div className="space-y-1.5">
            <p className={t1Class}>{reopened}</p>
            <p className={t2Class}>{copy.WAITING_LINE}</p>
            <p className={t3Class}>{copy.WAITING_IP_LINE}</p>
        </div>
    ) : (
        <div className="space-y-1.5">
            <p className={t1Class}>{copy.WAITING_LINE}</p>
            <p className={t3Class}>{copy.WAITING_IP_LINE}</p>
        </div>
    );
}

// ---- The prompt (DP-01 to DP-03) and its guard (spec 06 5.5, E-44) ---------
function Prompt({snap, onAnswer, onGuardLift, onPromptVisible}: RequestLinkViewProps) {
    const prompt = snap.prompt!;
    // When this prompt rendered, and when the window last regained focus.
    const mountedAt = useRef(Date.now());
    const focusAt = useRef<number | null>(null);
    // The last pointerdown on either button: a mouse activation counts only
    // when it also started after the prompt rendered.
    const downAt = useRef<number | null>(null);
    const lifted = useRef(false);
    const timer = useRef<number | null>(null);
    const [guarded, setGuarded] = useState(true);
    const [now, setNow] = useState(() => Date.now());
    const block = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const tick = () => {
            const t = Date.now();
            if (guardActive(t, mountedAt.current, focusAt.current)) {
                setGuarded(true);
                const until = Math.max(mountedAt.current, focusAt.current ?? 0) + GUARD_MS;
                timer.current = window.setTimeout(tick, Math.max(0, until - t));
                return;
            }
            setGuarded(false);
            if (!lifted.current) {
                lifted.current = true;
                onGuardLift();
            }
        };
        timer.current = window.setTimeout(tick, GUARD_MS);
        // The guard re-arms for 1 s whenever the window regains focus: a click
        // that brought the window forward must not land on Accept.
        const onFocus = () => {
            focusAt.current = Date.now();
            if (timer.current !== null) clearTimeout(timer.current);
            tick();
        };
        window.addEventListener('focus', onFocus);
        return () => {
            if (timer.current !== null) clearTimeout(timer.current);
            window.removeEventListener('focus', onFocus);
        };
        // Registered once per prompt: the parent keys this on promptGen.
    }, []);

    // The answer window, in whole minutes, refreshed once a minute and kept
    // out of every live region (spec 06 5.6).
    useEffect(() => {
        const id = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(id);
    }, []);

    // Whether the prompt is on screen, for the notice (spec 06 5.4). WebView2
    // has IntersectionObserver; where it is missing the notice simply stays.
    useEffect(() => {
        const el = block.current;
        if (!el || typeof IntersectionObserver === 'undefined') return;
        const io = new IntersectionObserver((entries) => {
            for (const e of entries) onPromptVisible(e.isIntersecting);
        });
        io.observe(el);
        return () => { io.disconnect(); onPromptVisible(false); };
    }, []);

    const answer = (a: 'accept' | 'decline') => (e: MouseEvent<HTMLButtonElement>) => {
        if (guardActive(Date.now(), mountedAt.current, focusAt.current)) return;
        // detail > 0 is a pointer activation; Enter and Space arrive as 0. A
        // pointer activation counts only when its press began after the
        // prompt rendered and outside the guard (a press held across the end
        // of the guard is one the guard was there to stop).
        if (e.detail > 0) {
            const down = downAt.current;
            if (down === null || down < mountedAt.current || guardActive(down, mountedAt.current, focusAt.current)) return;
        }
        onAnswer(snap.promptGen, a);
    };
    const onDown = () => { downAt.current = Date.now(); };
    const guardClass = guarded ? 'cursor-not-allowed opacity-50' : '';

    return (
        <div ref={block} className="space-y-2">
            <h3 id={PROMPT_HEADING_ID} tabIndex={-1} className={cn(headClass, 'outline-none')}>{copy.promptHeading(snap.label)}</h3>
            <p className="text-sm font-medium text-zinc-100">{copy.promptSize(prompt.files, prompt.totalBytes)}</p>
            <p className={t2Class}>{copy.INTO} <span className="font-mono text-zinc-300">{prompt.folder}</span></p>
            {prompt.warnings.map((w) => {
                const line = copy.warningLine(w, prompt, snap.saveDir);
                return line ? <p key={w} className={warnClass}>{line}</p> : null;
            })}
            <p className={t3Class}>{copy.answerWithin(prompt.answerBy, now)}</p>
            <div className="h-1"/>
            <div className="flex gap-3">
                <Button className={cn('flex-1', guardClass)} aria-disabled={guarded} onPointerDown={onDown} onClick={answer('accept')}>
                    {copy.ACCEPT}
                </Button>
                <Button variant="secondary" className={cn('min-w-24', guardClass)} aria-disabled={guarded} onPointerDown={onDown} onClick={answer('decline')}>
                    {copy.DECLINE}
                </Button>
            </div>
            <p className={t3Class}>{copy.PROMPT_CAUTION}</p>
        </div>
    );
}

// ---- Receiving (DV-01 to DV-03) ---------------------------------------------
function Receiving({snap, progress, onCancelDrop}: RequestLinkViewProps) {
    // Speed and time left, averaged since this drop's first progress event
    // (the track() rule in progress.ts), keyed on the lane generation.
    const start = useRef<{gen: number; t: number; bytes: number} | null>(null);
    const now = Date.now();
    const done = progress ? (progress.grandTotal > 0 ? progress.totalBytes : progress.fileBytes) : 0;
    const total = progress ? (progress.grandTotal > 0 ? progress.grandTotal : progress.fileSize) : 0;
    if (progress && (!start.current || start.current.gen !== snap.gen)) start.current = {gen: snap.gen, t: now, bytes: done};
    const dt = start.current ? (now - start.current.t) / 1000 : 0;
    const speed = start.current && dt > 0.2 ? (done - start.current.bytes) / dt : 0;
    const eta = speed > 0 ? (total - done) / speed : Infinity;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const count = progress?.fileCount || snap.result?.files || snap.prompt?.files || 0;
    const index = progress?.fileIndex || (count ? 1 : 0);
    const speedText = fmtSpeed(speed);
    const etaText = fmtEta(eta);
    return (
        <div className="space-y-4">
            <p className={headClass}>{copy.receivingHeading(index, count, snap.label)}</p>
            <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-3 font-mono text-[11px] text-zinc-400">
                    {/* The engine's display-safe name (displayText, 200 max), as text. */}
                    <span className="truncate">{progress?.fileName ?? ''}</span>
                    <span className="shrink-0 text-zinc-500">{pct}%</span>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-white transition-[width] duration-150" style={{width: `${pct}%`}}/>
                </div>
                <div className="flex gap-3.5 font-mono text-[11px] text-zinc-500">
                    <span>{copy.receivedOf(done, total)}</span>
                    {speedText && <span>{speedText}</span>}
                    {etaText && pct < 100 && <span>{copy.timeLeft(etaText)}</span>}
                </div>
            </div>
            {etaLines(snap, eta, dt).map((l) => <p key={l} className={warnClass}>{l}</p>)}
            <div className="flex justify-end">
                <Button variant="outline" onClick={onCancelDrop}><X/> {copy.CANCEL_DROP}</Button>
            </div>
        </div>
    );
}

// ---- Done and Stopped (DO-01 to DO-03, DT-01 to DT-13) ----------------------
function Result({phase, snap, onDismiss, onMakeAnother, onShowInFolder}: RequestLinkViewProps) {
    const r = snap.result ?? {files: 0, saved: 0, bytes: 0, verified: 0, renamed: 0, folder: '', names: []};
    const [confirming, setConfirming] = useState(false);
    const done = phase === 'done';
    const showFolder = !!r.folder && (done ? r.saved > 0 : copy.stoppedShowsFolder(snap.code, r.saved));
    // Show in folder asks first after renames (DN8): Explorer parses some file
    // types by itself, and the renamed count is the warning that survives.
    const show = () => { if (r.renamed > 0) setConfirming(true); else onShowInFolder(r.folder); };
    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
                <p className={cn(headClass, 'leading-7')}>{done ? copy.doneHeading(r.saved, r.bytes) : copy.STOPPED_HEADING}</p>
                <button type="button" className={quietClass} onClick={onDismiss}>{copy.DISMISS}</button>
            </div>
            {done ? (
                <div className="space-y-2">
                    {copy.verifiedAll(r) && (
                        <p className="flex items-start gap-2 text-xs leading-relaxed text-zinc-400">
                            <Check className="mt-0.5 size-3.5 shrink-0 text-green-500" strokeWidth={2.5}/>
                            <span>{copy.VERIFIED_LINE}</span>
                        </p>
                    )}
                    {r.renamed > 0 && <p className={warnClass}>{copy.renamedLine(r.renamed)}</p>}
                    <p className={t3Class}>{copy.NOT_SCANNED_LINE}</p>
                </div>
            ) : (
                <p className={t1Class}>{copy.stoppedCard(snap.code, r.saved, r.files)}</p>
            )}
            {showFolder && (
                <div className="flex min-w-0 items-center justify-between gap-3">
                    <span className="truncate font-mono text-xs text-zinc-300" title={r.folder}>{copy.folderName(r.folder)}</span>
                    <Button variant="outline" className="h-[30px] shrink-0 text-xs" onClick={show}>
                        <FolderOpen/> {copy.SHOW_IN_FOLDER}
                    </Button>
                </div>
            )}
            {!done && showFolder && <p className={t3Class}>{copy.STOPPED_FOLLOW_UP}</p>}
            <Button className="w-full" onClick={onMakeAnother}>{copy.MAKE_ANOTHER_LINK}</Button>
            {confirming && (
                <RenamedConfirm
                    onCancel={() => setConfirming(false)}
                    onConfirm={() => { setConfirming(false); onShowInFolder(r.folder); }}
                />
            )}
        </div>
    );
}

/** RenamedConfirm is the DN8 and DN9 dialog, in the app's z-50 dialog style,
 *  with the safe choice (Cancel) focused. Exported for History (S1-DSK-09),
 *  which asks the same question from a request row. */
export function RenamedConfirm({onCancel, onConfirm}: {onCancel: () => void; onConfirm: () => void}) {
    return (
        <div className="fixed inset-x-0 bottom-0 top-9 z-50 grid place-items-center bg-black/60 backdrop-blur-sm">
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="floe-renamed-title"
                onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
                className="animate-floe-in mx-4 w-full max-w-sm rounded-xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
            >
                <h2 id="floe-renamed-title" className="text-sm font-semibold text-white">{copy.RENAMED_CONFIRM_TITLE}</h2>
                <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{copy.RENAMED_CONFIRM_QUESTION}</p>
                <div className="mt-4 flex justify-end gap-2">
                    <Button variant="outline" autoFocus onClick={onCancel}>{copy.CANCEL}</Button>
                    <Button onClick={onConfirm}>{copy.SHOW_IN_FOLDER}</Button>
                </div>
            </div>
        </div>
    );
}
