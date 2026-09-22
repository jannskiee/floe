'use client';

import 'buffer';

/* eslint-disable @typescript-eslint/no-explicit-any */
// simple-peer's browser build reads Node's `global` and `process`; the same
// shim the main page's transfer component installs.
if (typeof window !== 'undefined') {
    if (!(window as any).global) (window as any).global = window;
    if (!(window as any).process) (window as any).process = { env: {} };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

import React, { useCallback, useEffect, useState } from 'react';
import SimplePeer, { type Instance as PeerInstance } from 'simple-peer';
import type { Socket } from 'socket.io-client';
import * as Sentry from '@sentry/nextjs';
import { getSocket } from '@/hooks/useSignaling';
import { useWakeLock } from '@/hooks/useWakeLock';
import { useConnectionType } from '@/hooks/useConnectionType';
import { useRequestFiles } from '@/hooks/useRequestFiles';
import { useVisitorGuards } from '@/hooks/useVisitorGuards';
import { resolveSocketUrl } from '@/lib/socketUrl';
import { evaluateRelayGate, probeIsRelay, RELAY_SIZE_LIMIT } from '@/lib/relay';
import { sendFiles, sendAbortReason, CONTROL_FLUSH_MS } from '@/lib/transfer/sender';
import { createReconnectBackoff } from '@/lib/reconnectBackoff';
import { parseRequestLink } from '@/lib/request/requestLink';
import {
    canPickFolders,
    hasDataChannelSupport,
    hasRelayUrl,
    isCoarsePointer,
    parseIceServers,
} from '@/lib/request/browserSupport';
import {
    reduce,
    initialModel,
    arrivedCount,
    peerOptionsFor,
    sendBlock,
    ATTEMPT_ENDING_STATES,
    type VisitorEffect,
    type VisitorEvent,
    type VisitorModel,
} from '@/lib/request/visitorState';
import { createAttemptGate } from '@/lib/request/attempt';
import { createFlushTracker } from '@/lib/request/flushes';
import { deliveredBytes, dropEtaSeconds, dropPercent, etaAdvice } from '@/lib/request/eta';
import { reportMailtoFromLocation } from '@/lib/request/report';
import { afterSettle, firstStringFrame, watchSend } from '@/lib/request/sendOutcome';
import { senderEvents } from '@/lib/request/senderEvents';
import {
    adviceLines,
    announcement,
    progressParts,
    sendingHeader,
    statusCopy,
    visitorCopy,
    type StatusContext,
} from '@/lib/request/visitorCopy';
import {
    DEFAULT_STUN_SERVERS,
    FIRST_ACK_TIMEOUT_MS,
    JOIN_NO_ANSWER_MS,
    RELAY_BLOCK_REASON,
    RELAY_PROBE_DELAY_MS,
    ROOM_FULL_RETRY_DELAY_MS,
    SETUP_TIMEOUT_MS,
    SOCKET_CONNECT_TIMEOUT_MS,
    VISITOR_CANCEL_REASON,
} from '@/lib/request/constants';
import type { RequestFile } from '@/lib/request/mergeSelection';
import type { PathRow } from '@/components/request/ArrivedList';
import { NoticeCard } from '@/components/request/NoticeCard';
import { RequestReady } from '@/components/request/RequestReady';
import { RequestStatus } from '@/components/request/RequestStatus';
import { RequestProgress } from '@/components/request/RequestProgress';
import { ReportLink } from '@/components/request/ReportLink';

// ---------------------------------------------------------------------------
// The connection controller.
//
// Everything that talks to the network lives here, outside React's render:
// the socket, the peer, the timers, and the sequence of spec 07 4.8. The
// decisions are the reducer's (lib/request/visitorState.ts); this runs the
// effects it names, in order, and turns socket, peer and sender callbacks
// into its events. Nothing here runs before the visitor presses Send: the
// first network call is inside the 'startAttempt' effect.
//
// Every continuation after an await, and every callback from the socket, the
// peer or the sender, is gated on the attempt it started under (attempt.ts).
// A late answer from a finished attempt is dropped rather than written.
// ---------------------------------------------------------------------------

type TimerName = 'connect' | 'join' | 'setup' | 'retryJoin' | 'retryConnect' | 'probe';

interface ControllerDeps {
    setModel: (model: VisitorModel) => void;
    setAttemptFiles: (files: RequestFile[]) => void;
    tick: () => void;
    wake: { request: () => void; release: () => void };
    badge: { start: (peer: PeerInstance) => void; stop: () => void; reset: () => void };
}

function createVisitorController(deps: ControllerDeps) {
    let model: VisitorModel = initialModel;
    const gate = createAttemptGate();
    let attempt = 0;
    let pendingFiles: RequestFile[] = [];
    let files: RequestFile[] = [];
    let peer: PeerInstance | null = null;
    // The peer this page tore down on purpose; its close and error events are
    // not news (the main page's closedByUsRef idiom).
    let closedByUs: PeerInstance | null = null;
    // Set when the host stopped the drop with a refusal: that verdict wins
    // over whatever the transport reports next.
    let wireCode = false;
    let socket: Socket | null = null;
    let listeners: Array<[string, (...args: any[]) => void]> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    let ice: RTCIceServer[] = [...DEFAULT_STUN_SERVERS];
    let lastEndedAt: number | null = null;
    const backoff = createReconnectBackoff();
    const timers = new Map<TimerName, ReturnType<typeof setTimeout>>();
    // Cancel reasons still on their way to the host; a reload waits for them.
    const flushes = createFlushTracker();
    // Set once a new fragment asked for a reload: the page is leaving, and no
    // Send or Try again may start an attempt to the old room meanwhile
    // (WP-W1 review R3-1).
    let reloadPending = false;

    function arm(name: TimerName, ms: number, fire: () => void) {
        clearTimer(name);
        timers.set(
            name,
            setTimeout(() => {
                timers.delete(name);
                fire();
            }, ms)
        );
    }
    function clearTimer(name: TimerName) {
        const t = timers.get(name);
        if (t) clearTimeout(t);
        timers.delete(name);
    }

    function dispatch(event: VisitorEvent) {
        const before = model;
        const { model: next, effects } = reduce(model, event);
        if (next === before && effects.length === 0) return;
        model = next;
        deps.setModel(next);
        const ending = ATTEMPT_ENDING_STATES.includes(next.state) && !ATTEMPT_ENDING_STATES.includes(before.state);
        if (ending) {
            gate.end();
            lastEndedAt = Date.now();
        }
        for (const effect of effects) run(effect);
    }

    /** Dispatch only while `a` is the live attempt. */
    function dispatchFor(a: number, event: VisitorEvent) {
        gate.guard(a, () => dispatch(event));
    }

    function run(effect: VisitorEffect) {
        const a = attempt;
        switch (effect) {
            case 'startAttempt':
                attempt = gate.begin();
                files = pendingFiles;
                deps.setAttemptFiles(files);
                wireCode = false;
                closedByUs = null;
                backoff.reset();
                deps.badge.reset();
                deps.wake.request();
                void fetchIce(attempt);
                return;
            case 'buildPeer':
                buildPeer(a);
                return;
            case 'connectSocket':
                connectSocket(a);
                return;
            case 'emitJoin':
                emitJoin(a);
                return;
            case 'retryJoin':
                arm('retryJoin', ROOM_FULL_RETRY_DELAY_MS, () => {
                    if (gate.isLive(a)) emitJoin(a);
                });
                return;
            case 'retryConnect':
                arm('retryConnect', backoff.next(), () => {
                    if (gate.isLive(a)) socket?.connect();
                });
                return;
            case 'clearConnectTimer':
                clearTimer('connect');
                return;
            case 'clearJoinTimer':
                clearTimer('join');
                return;
            case 'armSetupTimer':
                arm('setup', SETUP_TIMEOUT_MS, () => dispatchFor(a, { type: 'SETUP_TIMEOUT' }));
                return;
            case 'clearSetupTimer':
                clearTimer('setup');
                return;
            case 'startBadgePoll':
                if (peer) deps.badge.start(peer);
                return;
            case 'armProbe': {
                const p = peer;
                if (p) arm('probe', RELAY_PROBE_DELAY_MS, () => void probeRoute(a, p));
                return;
            }
            case 'sendFiles':
                startSend(a);
                return;
            case 'startCountdown':
                deps.tick();
                return;
            case 'sendCancelAbort':
                cancelWithReason();
                return;
            case 'destroyPeer':
                destroyPeer();
                return;
            case 'disconnectSocket':
                disconnectSocket();
                return;
            case 'clearTimers':
                for (const name of [...timers.keys()]) clearTimer(name);
                return;
            case 'releaseWakeLock':
                deps.wake.release();
                return;
            case 'reload':
                // A new fragment reloads the page, but only once a Cancel
                // reason still flushing has reached the host, or its bound
                // has passed (WP-W1 review R2-3).
                reloadPending = true;
                void flushes.settled(CONTROL_FLUSH_MS + 1_000).then(() => window.location.reload());
                return;
        }
    }

    /** Step 4: one GET of the ICE list per attempt, after resolving the server
     *  the same way the socket does. A missing or malformed answer keeps the
     *  STUN defaults. The answer is never logged, stored beyond this attempt's
     *  peer config, or put in a breadcrumb. */
    async function fetchIce(a: number) {
        let servers: RTCIceServer[] = [...DEFAULT_STUN_SERVERS];
        try {
            const base = await resolveSocketUrl();
            const res = await fetch(`${base}/api/turn-credentials`, {
                cache: 'no-store',
                referrerPolicy: 'no-referrer',
            });
            if (res.ok) {
                const parsed = parseIceServers(await res.json());
                if (parsed) servers = parsed;
            }
        } catch {
            // Keep the STUN defaults.
        }
        if (!gate.isLive(a)) return;
        ice = servers;
        dispatch({ type: 'ICE_READY', hasTurn: hasRelayUrl(servers) });
    }

    /** Step 5: the answering peer, built before the socket joins so an early
     *  offer always finds it. Hide my IP is iceTransportPolicy 'relay'. */
    function buildPeer(a: number) {
        // peerOptionsFor pins the whole option set, the relay policy with it.
        const p = new SimplePeer(peerOptionsFor(ice, model.hideIp));
        peer = p;
        p.on('signal', (signal) => {
            if (gate.isLive(a)) socket?.emit('signal', { signal, target: null });
        });
        p.on('connect', () => {
            Sentry.addBreadcrumb({
                category: 'webrtc',
                message: 'Visitor peer connected',
                level: 'info',
                data: { filesCount: files.length, bytes: totalSize() },
            });
            dispatchFor(a, { type: 'CHANNEL_OPEN' });
        });
        p.on('error', () => {
            if (closedByUs === p || wireCode) return;
            dispatchFor(a, { type: 'PEER_ERROR' });
        });
        p.on('close', () => {
            if (closedByUs === p || wireCode) return;
            dispatchFor(a, { type: 'CHANNEL_CLOSED' });
        });
    }

    /** Step 3's socket half: the shared lazy socket, this attempt's listeners,
     *  and the 20 s connect timer (row R4). */
    function connectSocket(a: number) {
        arm('connect', SOCKET_CONNECT_TIMEOUT_MS, () => dispatchFor(a, { type: 'SOCKET_CONNECT_TIMEOUT' }));
        void getSocket().then((s) => {
            if (!gate.isLive(a)) return;
            socket = s;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const on = (name: string, fn: (...args: any[]) => void) => {
                s.on(name, fn);
                listeners.push([name, fn]);
            };
            const answer = (kind: 'request-joined' | 'host-absent' | 'room-full' | 'disabled' | 'error') => () =>
                dispatchFor(a, {
                    type: 'JOIN_ANSWER',
                    answer: kind,
                    sincePreviousAttemptMs: lastEndedAt === null ? null : Date.now() - lastEndedAt,
                });
            on('connect', () => {
                backoff.reset();
                dispatchFor(a, { type: 'SOCKET_CONNECTED' });
            });
            on('connect_error', () => {
                // Inactive means the server refused the handshake (the per-IP
                // limiter), which socket.io-client never retries on its own.
                // Active is a transport failure the manager is already
                // retrying; the connect timer bounds that one.
                if (s.active === false) dispatchFor(a, { type: 'SOCKET_REFUSED' });
            });
            on('disconnect', () => dispatchFor(a, { type: 'SOCKET_LOST' }));
            on('request-joined', answer('request-joined'));
            on('host-absent', answer('host-absent'));
            on('room-full', answer('room-full'));
            on('disabled', answer('disabled'));
            // The server's words are never read: an error answer is a fixed
            // Couldn't connect.
            on('error', answer('error'));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            on('signal', (data: any) => {
                if (!gate.isLive(a)) return;
                const sig = data?.signal;
                const p = peer;
                if (!sig || !p || p.destroyed) return;
                try {
                    p.signal(sig);
                } catch {
                    dispatch({ type: 'PEER_ERROR' });
                }
            });
            on('peer-disconnected', () => dispatchFor(a, { type: 'PEER_DISCONNECTED' }));
            if (s.connected) dispatchFor(a, { type: 'SOCKET_CONNECTED' });
            else if (!s.active) s.connect();
        });
    }

    /** request-join with the bare room id, then the 10 s no-answer timer. */
    function emitJoin(a: number) {
        socket?.emit('request-join', model.roomId);
        arm('join', JOIN_NO_ANSWER_MS, () => dispatchFor(a, { type: 'JOIN_NO_ANSWER' }));
    }

    function totalSize(): number {
        return files.reduce((sum, f) => sum + f.file.size, 0);
    }

    /** Step 4 of the card, duplicated from the main page's sender on purpose
     *  (OD-13) and pinned to it by lib/relay.test.ts: the same probe, the
     *  same verdict, and the fixed TEXT abort awaited before destroy. */
    async function probeRoute(a: number, p: PeerInstance) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pc = (p as any)._pc as RTCPeerConnection | undefined;
        let isRelay = false;
        if (pc) {
            try {
                isRelay = probeIsRelay(await pc.getStats());
            } catch {
                // Fail open: a probe hiccup never blocks a drop.
            }
        }
        if (!gate.isLive(a)) return;
        const size = totalSize();
        Sentry.addBreadcrumb({
            category: 'webrtc',
            message: `Visitor ICE resolved: ${isRelay ? 'relay' : 'direct'}`,
            level: 'info',
            data: { isRelay, bytes: size },
        });
        const verdict = evaluateRelayGate({ isRelay, relayEnabled: true, totalSize: size });
        if (verdict.action === 'block-over-limit') {
            Sentry.addBreadcrumb({
                category: 'transfer',
                message: 'Visitor blocked: relay size limit exceeded',
                level: 'warning',
                data: { bytes: verdict.totalSize, limitBytes: RELAY_SIZE_LIMIT },
            });
            // Tell the host why, as TEXT, and wait for it to reach the wire,
            // or the destroy below takes it along and the host sees only a
            // close.
            await sendAbortReason(
                (d) => p.send(d),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (p as any)._channel as RTCDataChannel | undefined,
                RELAY_BLOCK_REASON
            );
            closedByUs = p;
            p.destroy();
            dispatchFor(a, { type: 'RELAY_VERDICT', action: verdict.action, isRelay });
            return;
        }
        dispatch({ type: 'RELAY_VERDICT', action: verdict.action, isRelay });
    }

    /** Step 4's proceed: the send, with the first-ack clock and success only
     *  after the host's received. The page reads its verdicts as events and
     *  never renders onError's text. */
    function startSend(a: number) {
        const p = peer;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const channel = p ? ((p as any)._channel as RTCDataChannel | undefined) : undefined;
        if (!p || !channel) {
            dispatchFor(a, { type: 'SEND_SETTLED_SILENT' });
            return;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pc = (p as any)._pc as RTCPeerConnection | undefined;
        const live = () => gate.isLive(a) && !p.destroyed;
        // The callback-to-event mapping, and with it E22 from onAllSent only
        // and the refusal latch, lives in senderEvents (tested there).
        const watch = watchSend(
            senderEvents({
                dispatch: (event) => dispatchFor(a, event),
                now: () => Date.now(),
                // Mandatory under requireReceived, which has no deadline
                // (E-36): Cancel, which ends the attempt, is the only way out
                // of a host that neither answers nor closes.
                isDestroyed: () => !live(),
                onWireVerdict: () => {
                    wireCode = true;
                },
            })
        );
        const send = firstStringFrame(
            (d) => p.send(d),
            () => dispatchFor(a, { type: 'FIRST_METADATA_SENT', now: Date.now() })
        );
        sendFiles(
            {
                send,
                onData: (handler) => {
                    p.on('data', handler);
                    return () => p.off('data', handler);
                },
                channel,
                sctpMaxMessageSize: pc?.sctp?.maxMessageSize,
            },
            files.map((f) => ({ id: f.id, file: f.file, relativePath: f.relativePath })),
            watch.callbacks,
            { ackTimeoutMs: FIRST_ACK_TIMEOUT_MS, requireReceived: true }
        )
            .catch(() => undefined)
            .then(() => {
                // E31: settled with no verdict. Two of the three ways there
                // are values the host chose (a version range miss on the ack,
                // an unusable resume offset), so this is Lost, not a wait.
                const settled = afterSettle({ live: live(), reported: watch.reported() });
                if (settled) dispatch(settled);
            });
    }

    /** Cancel with the channel open: the fixed reason, awaited, then the
     *  destroy. The socket and timers go at once through the other effects. */
    function cancelWithReason() {
        const p = peer;
        peer = null;
        deps.badge.stop();
        if (!p) return;
        closedByUs = p;
        flushes.add(
            (async () => {
                await sendAbortReason(
                    (d) => p.send(d),
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (p as any)._channel as RTCDataChannel | undefined,
                    VISITOR_CANCEL_REASON
                );
                p.destroy();
            })()
        );
    }

    function destroyPeer() {
        const p = peer;
        peer = null;
        deps.badge.stop();
        if (!p) return;
        closedByUs = p;
        p.destroy();
    }

    /** E-04: every attempt-ending state disconnects, which frees seat 1 for
     *  the host's request-reopen. Listeners go first, so the disconnect this
     *  causes is not read as a lost socket. */
    function disconnectSocket() {
        const s = socket;
        if (!s) return;
        for (const [name, fn] of listeners) s.off(name, fn);
        listeners = [];
        s.disconnect();
    }

    return {
        dispatch,
        /** A Send or a Try again with this selection. The reducer decides
         *  whether it starts an attempt; the selection is taken only if so. */
        start(type: 'SEND' | 'TRY_AGAIN', selection: RequestFile[], hideIp: boolean, reading: boolean) {
            if (reloadPending) return;
            pendingFiles = selection;
            dispatch({
                type,
                count: selection.length,
                size: selection.reduce((sum, f) => sum + f.file.size, 0),
                hideIp,
                reading,
            });
        },
        dispose() {
            gate.end();
            for (const name of [...timers.keys()]) clearTimer(name);
            disconnectSocket();
            destroyPeer();
            deps.wake.release();
        },
    };
}

type VisitorController = ReturnType<typeof createVisitorController>;

/** Read the link and the browser once, with no network call (E01 to E03). */
function readLink(win: typeof window): VisitorEvent {
    const link = parseRequestLink(win.location.pathname, win.location.hash);
    if ('error' in link) return { type: 'LINK_INCOMPLETE' };
    if (!hasDataChannelSupport(win)) return { type: 'NO_WEBRTC' };
    return { type: 'LINK_OK', roomId: link.roomId };
}

function rowsOf(files: RequestFile[]): PathRow[] {
    return files.map((f) => ({ id: f.id, relativePath: f.relativePath, size: f.file.size }));
}

/**
 * The request link visitor (spec 07 4.7): one top-level component, never a
 * mode of the main transfer page. It renders the state the reducer is in and
 * hands every action to the controller above.
 */
export function RequestVisitor() {
    const [model, setModel] = useState<VisitorModel>(initialModel);
    const [attemptFiles, setAttemptFiles] = useState<RequestFile[]>([]);
    const [now, setNow] = useState(0);
    const [hideIp, setHideIp] = useState(false);
    const [env, setEnv] = useState<{ canPickFolders: boolean; coarsePointer: boolean; reportHref: string | null }>({
        canPickFolders: false,
        coarsePointer: false,
        reportHref: null,
    });
    // Set once the page saw the computer sleep during a drop; C-98 then
    // replaces C-96 for the rest of the session.
    const [slept, setSlept] = useState(false);
    const onSlept = useCallback(() => setSlept(true), []);
    const { requestWakeLock, releaseWakeLock } = useWakeLock();
    const { connectionType, startPolling, stopPolling, reset } = useConnectionType();

    // One controller for the life of the page. Its dependencies are React
    // setters and hook functions whose behavior does not change between
    // renders, so the first render's are the ones it keeps.
    const [controller] = useState<VisitorController>(() =>
        createVisitorController({
            setModel,
            setAttemptFiles,
            tick: () => setNow(Date.now()),
            wake: { request: () => void requestWakeLock(), release: releaseWakeLock },
            badge: { start: startPolling, stop: stopPolling, reset },
        })
    );

    const picks = useRequestFiles({
        onPicked: () => controller.dispatch({ type: 'FILES_ADDED' }),
        onRefused: () => controller.dispatch({ type: 'PICK_REFUSED' }),
    });

    // Load: the link shape and the browser, decided in the browser because
    // both inputs exist only there; a changed fragment reloads (E29); and the
    // whole attempt is torn down on unmount.
    useEffect(() => {
        controller.dispatch(readLink(window));
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setEnv({
            canPickFolders: canPickFolders(window, navigator.userAgent),
            coarsePointer: isCoarsePointer(window),
            // The link id from the path, never the fragment (report.ts).
            reportHref: reportMailtoFromLocation(window.location),
        });
        const onHash = () => {
            const link = parseRequestLink(window.location.pathname, window.location.hash);
            controller.dispatch({ type: 'HASHCHANGE', roomId: 'error' in link ? null : link.roomId });
        };
        window.addEventListener('hashchange', onHash);
        return () => {
            window.removeEventListener('hashchange', onHash);
            controller.dispose();
        };
    }, [controller]);

    // The page's clock: the Waiting countdown every 15 s so the minute changes
    // on time, and the whole-drop estimate in Sending every 5 s.
    useEffect(() => {
        if (model.state !== 'V7' && model.state !== 'V10') return;
        const t = setInterval(() => setNow(Date.now()), model.state === 'V7' ? 15_000 : 5_000);
        return () => clearInterval(t);
    }, [model.state]);

    const sizes = attemptFiles.map((f) => f.file.size);
    useVisitorGuards({
        state: model.state,
        progress: {
            percent: model.state === 'V13' ? 100 : dropPercent(sizes, model.ackIndex, model.percent),
            index: model.state === 'V13' ? model.total : model.ackIndex,
            total: model.total,
        },
        requestWakeLock,
        releaseWakeLock,
        onSlept,
    });

    const ctx: StatusContext = {
        pathAt: (index) => attemptFiles[index - 1]?.relativePath,
        route: connectionType,
        now,
    };
    const status = statusCopy(model, ctx);
    // Arrived, from the sender's own index (row R5), never a host count.
    const arrivedRows = rowsOf(attemptFiles.slice(0, arrivedCount(model)));
    const route = connectionType ?? model.route;
    const block = sendBlock({
        count: picks.files.length,
        size: picks.totalBytes,
        hideIp,
        reading: picks.reading,
    });

    const onStatusAction = () => {
        if (!status) return;
        if (status.action === 'cancel') controller.dispatch({ type: 'CANCEL' });
        else if (status.action === 'back-to-files') controller.dispatch({ type: 'BACK_TO_FILES' });
        else if (status.action === 'try-again') controller.start('TRY_AGAIN', picks.files, hideIp, picks.reading);
    };

    let body: React.ReactNode = null;
    switch (model.state) {
        case 'load':
            body = null;
            break;
        case 'V1':
            body = <NoticeCard title={visitorCopy.incompleteTitle} body={visitorCopy.incompleteBody} />;
            break;
        case 'V2':
            body = <NoticeCard title={visitorCopy.unsupportedTitle} body={visitorCopy.unsupportedBody} />;
            break;
        case 'V3':
        case 'V3c':
        case 'V6b':
        case 'V6d':
            body = (
                <RequestReady
                    rows={rowsOf(picks.files)}
                    size={picks.totalBytes}
                    notice={picks.notice}
                    emptyFolders={picks.emptyFolders}
                    reading={picks.reading}
                    isDragging={picks.isDragging}
                    canPickFolders={env.canPickFolders}
                    coarsePointer={env.coarsePointer}
                    hideIp={hideIp}
                    needsRelay={model.state === 'V6b'}
                    block={block}
                    onHideIp={(on) => {
                        setHideIp(on);
                        controller.dispatch({ type: 'HIDE_IP_TOGGLED' });
                    }}
                    onSend={() => controller.start('SEND', picks.files, hideIp, picks.reading)}
                    onClear={() => {
                        picks.clear();
                        controller.dispatch({ type: 'CLEAR' });
                    }}
                    onDragOver={picks.handleDragOver}
                    onDragLeave={picks.handleDragLeave}
                    onDrop={picks.handleDrop}
                    onFiles={picks.handleFileSelection}
                    onFolder={picks.handleFolderSelection}
                    footerEnd={<ReportLink href={env.reportHref} />}
                />
            );
            break;
        case 'V10': {
            const current = attemptFiles[model.ackIndex - 1];
            const currentSize = current?.file.size ?? 0;
            body = (
                <RequestProgress
                    header={sendingHeader(model.ackIndex, model.total)}
                    route={route}
                    currentPath={current?.relativePath ?? ''}
                    percent={model.percent}
                    parts={progressParts(
                        (currentSize * model.percent) / 100,
                        currentSize,
                        model.bytesPerSec,
                        model.etaSeconds ?? Number.NaN
                    )}
                    arrived={arrivedRows}
                    advice={adviceLines(
                        etaAdvice(
                            dropEtaSeconds({
                                dropBytes: model.size,
                                deliveredBytes: deliveredBytes(sizes, model.ackIndex, model.percent),
                                bytesPerSec: model.bytesPerSec,
                                sendingForMs: model.acceptedAt === null ? 0 : now - model.acceptedAt,
                            })
                        ),
                        slept
                    )}
                    onStop={() => controller.dispatch({ type: 'CANCEL' })}
                />
            );
            break;
        }
        default:
            body = status ? (
                <RequestStatus copy={status} route={route} arrived={arrivedRows} onAction={onStatusAction} />
            ) : null;
    }

    return (
        <>
            {body}
            {/* One persistent status span from first paint, so assistive tech
                is already listening when the first sentence arrives (4.18). */}
            <span role="status" className="sr-only">
                {announcement(model, ctx)}
            </span>
        </>
    );
}
