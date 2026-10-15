'use client';

import 'buffer';

/* eslint-disable @typescript-eslint/no-explicit-any */
if (typeof window !== 'undefined') {
    if (!(window as any).global) (window as any).global = window;
    if (!(window as any).process) (window as any).process = { env: {} };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

import {useEffect, useRef, useState} from 'react';
import SimplePeer, { Instance as PeerInstance } from 'simple-peer';

// simple-peer extends a readable-stream Duplex and forwards its whole
// options object to super(opts), but @types/simple-peer stops at the peer
// options and never declares the stream ones. Declare the single one Floe
// sets rather than casting at each construction site, which would also
// silence a genuine typo in the peer options next to it.
declare module 'simple-peer' {
    interface Options {
        readableObjectMode?: boolean;
    }
}
import {v4 as uuidv4} from 'uuid';
import * as Sentry from '@sentry/nextjs';
import {formatSpeed, formatETA} from '@/lib/transferUtils';
import {createReceiver} from '@/lib/transfer/receiver';
import {reportableCause} from '@/lib/transfer/failureReport';
import {sendFiles as sendFilesEngine, sendAbortReason, CONTROL_FLUSH_MS} from '@/lib/transfer/sender';
import {useWakeLock} from '@/hooks/useWakeLock';
import {useFileManagement, type FileWithId} from '@/hooks/useFileManagement';
import {useDownloadManager, type ReceivedFile} from '@/hooks/useDownloadManager';
import {useSignaling} from '@/hooks/useSignaling';
import {useConnectionType} from '@/hooks/useConnectionType';
import {useTransferAnalytics} from '@/hooks/useTransferAnalytics';
import {useFullLoadLinks, useLeavePrompt, useStrayDropGuard} from '@/hooks/usePageGuards';
import {useRelayConfiguration} from '@/hooks/useRelayConfiguration';
import {RELAY_SIZE_LIMIT, filterIceServers, evaluateRelayGate, probeIsRelay} from '@/lib/relay';
import {buildShareLink, getRoomFromUrl, isValidRoomId} from '@/lib/roomLink';
import {classifyPeerError, peerErrorBanner, peerErrorCodeOf, peerErrorReport, senderErrorBlamesRelay} from '@/lib/peerErrors';
import {decideReceiverClose} from '@/lib/receiverClose';
import {SEND_INTERNAL_ERROR, describeSenderStop, senderCloseInterrupted} from '@/lib/senderStop';
import {RELAY_OFF_REASON, SELF_STOP_REASONS, selfStopOf, type SelfStop} from '@/lib/senderSelfStop';
import {verifiedLine, VERIFIED_LINE} from '@/lib/verifiedLine';
import {receiveSummary, receiverTabMatters} from '@/lib/receiveSummary';
import type {SendEnd} from '@/lib/sendSummary';
import {INITIAL_SEAT, seatStep, type SeatEvent} from '@/lib/roomSeat';
import {REJOIN_FAILED_STATUS, REJOINING_STATUS, rejoinAllowed, rejoinDelay, statusOnceSeated} from '@/lib/rejoinRetry';
import {peerDisconnectAction, teardownClaimsClose} from '@/lib/peerDisconnect';
import {LINK_INVALID, afterReconnect, isLinkInvalid, peerBanner, withRefusalBanner, withoutRefusalBanner} from '@/lib/refusalBanner';
import {copyText} from '@/lib/clipboard';
import {mainPageHoldsTab, receiveUnderWay, unsavedCount} from '@/lib/pageGuards';
import {createIceList, freshenWithin} from '@/lib/iceList';
import {resolveSocketUrl} from '@/lib/socketUrl';

import {
    Card,
    CardContent,
    CardFooter,
    CardHeader,
} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {
    AlertCircle,
    AlertTriangle,
    ArrowRight,
    Link2Off,
    Loader2,
    Plus,
    UploadCloud,
    X,
} from 'lucide-react';
import {formatBytes} from '@/lib/utils';
import {ConnectionStatusBadge} from '@/components/ConnectionStatusBadge';
import {RelayFallbackToggle} from '@/components/RelayFallbackToggle';
import {ShareLinkPanel} from '@/components/ShareLinkPanel';
import {TransferProgressBar} from '@/components/TransferProgressBar';
import {SelectedFilesList} from '@/components/SelectedFilesList';
import {ReceiverPanel} from '@/components/ReceiverPanel';

export function P2PTransfer() {
    const [isSender, setIsSender] = useState<boolean | null>(null);
    const [status, setStatus] = useState('Idle');
    const [generatedLink, setGeneratedLink] = useState('');
    // Set the instant Create is clicked. Everything that can change the file
    // set is gated on this rather than on generatedLink, because the link is
    // not rendered until the room-joined ack (or the 3s fallback), and
    // onUserConnected captures the files array at click time. A file dropped
    // in that window was counted in the header and shown with a green tick by
    // SelectedFilesList, and never sent.
    const [linkPending, setLinkPending] = useState(false);
    const [currentFileIndex, setCurrentFileIndex] = useState(0);
    const [progress, setProgress] = useState(0);
    const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
    // The sender's own record of the receiver's delivery report, reduced to a
    // boolean in the callback. The count itself never reaches a render.
    const [allVerified, setAllVerified] = useState(false);
    // How this page's send ended, for the file rows and the progress row.
    // A fact latched where the send engine reports it, never read back from
    // the status sentence, which three handlers rewrite after a finished send
    // (lib/sendSummary.ts). Every write below is tied to the peer it is
    // about: a session that was replaced must not mark the one that replaced it.
    const [sendEnd, setSendEnd] = useState<SendEnd>('open');
    // The file count the sender announced. expectedFilesRef holds the same
    // number but is a ref, so it does not re-render the success line.
    const [expectedFiles, setExpectedFiles] = useState(0);
    // Latched when this receive is over: the peer connection closed, or the
    // receiver engine stopped on a failure. Never derived from `status`, which
    // onDisconnect also writes when only this side's signaling socket blinked.
    const [receiveEnded, setReceiveEnded] = useState(false);
    // A receiver page only: the server's messages say nobody is on the
    // sending side of this link right now. See lib/roomSeat.ts.
    const [senderAbsent, setSenderAbsent] = useState(false);
    // A receiver page only: the file the sender announced as its last one has
    // arrived (the receiver engine's onAllComplete), so no receive is under
    // way until another file is announced. Read only by the leave prompt.
    const [allArrived, setAllArrived] = useState(false);
    // A receiver page only: the received files this page has handed to the
    // browser to save (a file's own link, Download All, Download ZIP). The
    // leave prompt lets go once every received file is in here.
    const [savedIds, setSavedIds] = useState<ReadonlySet<string>>(() => new Set());
    const markSaved = (ids: readonly string[]) =>
        setSavedIds((prev) => {
            const next = new Set(prev);
            for (const id of ids) next.add(id);
            return next;
        });
    // A sender page only: the page has told the person to reload (the four
    // branches that say so), so that reload must not raise the leave prompt.
    // Down again when a recipient arrives or a connection comes up after all.
    const [deadEnd, setDeadEnd] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState('');
    const [transferSpeed, setTransferSpeed] = useState('');
    const [estimatedTime, setEstimatedTime] = useState('');
    const [showQr, setShowQr] = useState(false);

    const {
        files,
        isDragging,
        dropNotice,
        totalBytes,
        handleFileSelection,
        handleDeleteFile,
        handleDragOver,
        handleDragLeave,
        handleDrop,
    } = useFileManagement();

    const {
        isZipping,
        isDownloading,
        downloadProgress,
        handleDownloadAll,
        handleDownloadZip,
    } = useDownloadManager(receivedFiles, setError, markSaved);

    const {
        connectionType,
        startPolling: startConnectionTypePolling,
        stopPolling: stopConnectionTypePolling,
        reset: resetConnectionType,
    } = useConnectionType();

    const { reportStatsEnabled, setReportStatsEnabled, track, reportBytes } = useTransferAnalytics();

    const { relayEnabled, setRelayEnabled } = useRelayConfiguration();

    const [relayBlocked, setRelayBlocked] = useState(false);
    // The staged set is sealed once Create is clicked and stays sealed.
    const filesLocked = linkPending || generatedLink !== '';
    // Live check, used before the transfer is blocked. It derives from
    // connectionType, which peer.destroy() resets to null, so the blocked state
    // below is latched separately or tearing the connection down would also
    // erase the banner that explains why.
    const isRelayOverLimit = connectionType === 'relay' && totalBytes > RELAY_SIZE_LIMIT;
    const showRelayLimitNotice = isRelayOverLimit || relayBlocked;

    // Whether closing this receiving tab would cost something, for the
    // footer's keep-open line.
    const linkInvalid = isLinkInvalid(error);
    const unsaved = unsavedCount(receivedFiles, savedIds);
    const receiverTabHeld = receiverTabMatters({
        linkInvalid,
        senderAbsent,
        ended: receiveEnded,
        allArrived,
        unsaved,
    });
    // The browser's own "Leave site?" prompt while leaving would cost
    // something, in-app links always loaded in full so the page stays a
    // document of its own and Back and Forward reach the prompt, and a stray
    // drop refused anywhere on the page (lib/pageGuards.ts). The Floe wordmark
    // reloads through window.location, so it asks too.
    const holdsTab = mainPageHoldsTab({
        isSender,
        linkOut: filesLocked,
        sendEnd,
        deadEnd,
        receiveUnderWay: receiveUnderWay({
            linkInvalid,
            senderAbsent,
            ended: receiveEnded,
            allArrived,
        }),
        unsaved,
    });
    useLeavePrompt(holdsTab);
    useFullLoadLinks();
    useStrayDropGuard();

    const peerRef = useRef<PeerInstance | null>(null);
    // A reason that arrived on the wire wins over whatever the transport
    // says next. peer.destroy() raises "User-Initiated Abort" on the far
    // side a moment later, and without this latch its handler overwrites the
    // real explanation with connection advice.
    const wireReasonRef = useRef(false);
    // The peer THIS side tore down on purpose, so its close handler stays
    // quiet and a reconnect does not flash a failure on the way through.
    // Holds the instance rather than a boolean: a boolean is cleared when the
    // replacement peer is built, and the outgoing peer's close can still be in
    // flight at that moment, which is exactly the reconnect path.
    const closedByUsRef = useRef<PeerInstance | null>(null);
    const hasJoinedRef = useRef(false);
    // How many times this page has joined its room as a receiver. Only the
    // first refusal is final at once (see joinRoomAsReceiver's room-full).
    const receiverJoinsRef = useRef(0);
    // The room this page instance is handling as a receiver. Used to detect a
    // fragment-only navigation (scanning a second QR code into the same tab).
    const joinedRoomRef = useRef<string | null>(null);
    // The room this page instance created as a sender (handleCreateLink). The
    // displayed link keeps pointing at this id, so a socket reconnect must
    // re-join it or the link goes dead.
    const createdRoomRef = useRef<string | null>(null);
    // Fallback timer for the room-joined ack gate in handleCreateLink. Held in
    // a ref so a repeated create-link click clears the previous timer instead
    // of letting it later revert the displayed link to an abandoned room.
    const linkAckFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const receivedFilesRef = useRef<ReceivedFile[]>([]);
    const transferCompleteRef = useRef(false);
    const progressRef = useRef(0);
    const fileListRef = useRef<HTMLDivElement>(null);

    // A latest-ref for the once-registered handlers, the same idiom and for the
    // same reason as useSignaling's cbRef: onUserConnected and
    // joinRoomAsReceiver both capture their closure before any peer exists, so
    // reading the state directly reported connection: "unknown" for every
    // transfer on both roles. Written in an effect rather than during render,
    // because react-hooks forbids the render-time assignment and because these
    // reads all happen on a transfer boundary, long after the commit.
    const connectionTypeRef = useRef<string | null>(null);
    // What the sender announced, from the first metadata. 0 until then.
    const expectedFilesRef = useRef(0);
    // Timers the unmount cleanup has to reach.
    const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const iceProbeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // The relay list, read at load and again before a connection when no read
    // has succeeded yet or it is an hour old (lib/iceList.ts).
    const [iceList] = useState(() =>
        createIceList({
            read: async () => {
                const base = await resolveSocketUrl();
                const response = await fetch(`${base}/api/turn-credentials`);
                if (!response.ok) throw new Error(`relay list: ${response.status}`);
                return response.json();
            },
        })
    );
    // Bumped by every new sending session and by unmount, so a session that
    // waited for the relay list builds nothing once it has been replaced.
    const senderSessionRef = useRef(0);
    const unmountedRef = useRef(false);

    // What to say when a receive ends. transferCompleteRef is set after EVERY
    // file, not after the last one, so a receiver that got 1 of 3 and then lost
    // the sender was told "Transfer complete". The ref and every guard that
    // reads it stay exactly as they are: they also gate the reconnect path, and
    // re-pointing them at an all-files meaning would turn a usable partial
    // receive into a permanent reconnect spinner. Only the sentence changes.
    const receiveOutcome = () => {
        const got = receivedFilesRef.current.length;
        const want = expectedFilesRef.current;
        if (want > 0 && got < want) {
            return `Sender disconnected. ${got} of ${want} files received`;
        }
        return 'Transfer complete';
    };

    useEffect(() => {
        connectionTypeRef.current = connectionType;
    });

    // The receiver's seat in the room, fed from the server's own messages.
    // Returns true when this page should give its seat back by re-joining.
    const seatRef = useRef(INITIAL_SEAT);
    const applySeat = (event: SeatEvent): boolean => {
        const step = seatStep(seatRef.current, event);
        seatRef.current = step.state;
        setSenderAbsent(step.state.senderAbsent);
        return step.yieldSeat;
    };

    // The sender's retry of a join its own room refused (lib/rejoinRetry.ts).
    // At most one is pending, and it never outlives the answer it waits for: a
    // second join-room from a socket the server has seated would move this
    // page behind its own receiver.
    const rejoinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const rejoinAttemptRef = useRef(0);
    const clearRejoin = () => {
        if (rejoinTimerRef.current) clearTimeout(rejoinTimerRef.current);
        rejoinTimerRef.current = null;
    };

    const { requestWakeLock, releaseWakeLock } = useWakeLock();

    const {
        isConnected,
        setIsConnected,
        ping,
        joinRoom,
        sendSignal,
        onUserConnected,
        onRoomFull,
        onRoomJoined,
    } = useSignaling({
        onSignal: (data) => {
            // Only a sender signals first, so on a receiver page any signal
            // means one is there, whatever happens to this particular frame.
            if (joinedRoomRef.current && seatRef.current.senderAbsent) applySeat({ type: 'offer' });
            const peer = peerRef.current;
            if (!peer || peer.destroyed) return;
            const sig = data?.signal;
            if (!sig) return;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const pc = (peer as any)._pc as RTCPeerConnection | undefined;
            // A duplicate/late SDP answer applied after negotiation completes throws
            // InvalidStateError ("Called in wrong state: stable"). Skip only answers.
            // Applying an offer in `stable` is the receiver's normal first step.
            if (pc && pc.signalingState === 'stable' && sig.type === 'answer') {
                Sentry.addBreadcrumb({
                    category: 'webrtc',
                    level: 'warning',
                    message: 'Skipped duplicate answer signal: peer already in stable state',
                });
                return;
            }
            try {
                peer.signal(sig);
            } catch (err) {
                Sentry.addBreadcrumb({
                    category: 'webrtc',
                    level: 'warning',
                    // The state is this browser's own word. The error's
                    // message is not: it can quote the signal the other
                    // peer sent (lib/peerErrors.ts).
                    message: `Ignored signal in state ${pc?.signalingState}`,
                    data: { errorCode: peerErrorCodeOf(err) },
                });
            }
        },
        onPeerDisconnected: () => {
            // The notice means the other side's signaling socket went away,
            // not its WebRTC connection. Once the data channel is open, WebRTC
            // reports a dead peer itself (close or error), so leave it be.
            const current = peerRef.current;
            const action = peerDisconnectAction({
                hasPeer: current !== null,
                peerConnected: current?.connected === true,
            });
            if (action === 'ignore') {
                Sentry.addBreadcrumb({
                    category: 'webrtc',
                    message: 'peer-disconnected ignored: data channel open',
                    level: 'info',
                });
                return;
            }
            // A receiver page is alone in the room from here on, and says so.
            // If the sender comes back it arrives BEHIND this page, which then
            // gives the first seat back (see the user-connected handler in
            // joinRoomAsReceiver).
            if (joinedRoomRef.current) applySeat({ type: 'peer-left' });
            // A wire reason wins. The peer told us why it stopped, and the
            // signaling socket it drops about two seconds later is a
            // consequence of that, not a second opinion: a CLI receiver
            // flushes its refusal for controlFlushTimeout, closes the channel,
            // then exits. receiveOutcome() returns the literal 'Transfer
            // complete' whenever expectedFilesRef is 0, and on the sender that
            // ref is never written, so without this the status flipped from
            // 'Transfer failed' back to 'Transfer complete' under a banner
            // saying a file was discarded. The receiver arrives here with the
            // same latch set by its own onError and wants the same answer: a
            // discarded file is not a completed receive. Only the status write
            // is guarded; the teardown below still runs on every path.
            if (!wireReasonRef.current) {
                if (receivedFilesRef.current.length > 0 || transferCompleteRef.current) {
                    setStatus(receiveOutcome());
                } else {
                    setStatus('Peer disconnected. Waiting for reconnection');
                }
            }
            // Set before destroy, so the close handler this triggers sees it.
            // Not for a peer that already closed or a receiver that holds
            // files: their close has to be heard. See teardownClaimsClose.
            if (
                teardownClaimsClose({
                    hasPeer: current !== null,
                    peerDestroyed: current?.destroyed === true,
                    receivedCount: receivedFilesRef.current.length,
                })
            ) {
                closedByUsRef.current = current;
            }
            current?.destroy();
            releaseWakeLock();
        },
        onDisconnect: () => {
            // A retry emitted while the socket is down would be buffered and
            // sent next to the reconnect handler's own join: two joins, and
            // the second one moves a seated sender behind its receiver.
            clearRejoin();
            // The same latch as onPeerDisconnected: this side's own socket
            // going away is not news that overrides the peer's account.
            if (wireReasonRef.current) return;
            if (receivedFilesRef.current.length > 0 || transferCompleteRef.current) {
                setStatus(receiveOutcome());
            }
        },
        onConnectError: (err) => {
            if (err.message === 'Rate limit exceeded') {
                setError(withRefusalBanner);
            }
        },
        // The retry of a refusal ends here and not in onReconnect, so this is
        // where its banner comes down. Nothing else: see lib/refusalBanner.ts.
        onConnect: () => setError(withoutRefusalBanner),
        onReconnect: () => {
            // Cleared, except the Link Invalid card of a page that has no
            // room to re-join: see afterReconnect.
            setError((prev) => afterReconnect(prev, joinedRoomRef.current !== null));
            // A new socket is a new attempt at the room: the join below is the
            // only one in flight, and a refusal starts the schedule again.
            clearRejoin();
            rejoinAttemptRef.current = 0;
            // A Socket.IO auto-reconnect comes back under a fresh socket.id,
            // and the server room only ever contained the old id, so this
            // client is no longer in its room. Re-join while the WebRTC data
            // channel is not yet up and the transfer has not finished; once
            // either is true, signaling is done and re-joining would only
            // churn the room.
            if (transferCompleteRef.current || receivedFilesRef.current.length > 0) return;
            if (peerRef.current?.connected) return;
            if (joinedRoomRef.current) {
                // Receiver: a bare re-join is not enough. The sender reacts to
                // the rejoin's user-connected with a brand-new initiator peer
                // and a fresh offer, which the old half-negotiated peer cannot
                // answer, so recreate the peer by re-running the join flow.
                closedByUsRef.current = peerRef.current;
                peerRef.current?.destroy();
                hasJoinedRef.current = false;
                rejoinAsReceiver(joinedRoomRef.current);
            } else if (createdRoomRef.current) {
                // Sender: re-enter the room only. Peer creation stays driven by
                // user-connected, whose handler (handleCreateLink) replaces any
                // stale peer when a receiver joins or re-joins.
                joinRoom(createdRoomRef.current);
            }
        },
    });

    // A receiver rebuilding its peer (its socket came back, or it gives the
    // first seat back) reads a stale relay list again first. Fresh, the wait
    // is a microtask; the join itself is guarded by hasJoinedRef, so another
    // path that joins in the meantime makes this one a no-op.
    const rejoinAsReceiver = (roomId: string) => {
        void freshenWithin(iceList).then(() => {
            if (unmountedRef.current) return;
            joinRoomAsReceiver(roomId);
        });
    };

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setIsSender(!getRoomFromUrl(window.location.hash, window.location.search));
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => {
            const container = fileListRef.current;
            if (container && !isSender) {
                container.scrollTo({
                    top: container.scrollHeight,
                    behavior: 'smooth',
                });
            }
        }, 100);
        return () => clearTimeout(timer);
    }, [
        files.length,
        receivedFiles.length,
        currentFileIndex,
        generatedLink,
        isSender,
    ]);

    // Nothing is shown when the copy fails. The link is on screen right
    // above this button, so a silent no-op leaves the user with the one thing
    // that still works, where the green "Copied" it used to show regardless
    // told them to stop looking at it.
    const handleCopy = async () => {
        if (!(await copyText(generatedLink))) return;
        setCopied(true);
        if (copyResetRef.current) clearTimeout(copyResetRef.current);
        copyResetRef.current = setTimeout(() => setCopied(false), 2000);
    };

    const handleShare = async () => {
        if (navigator.share) {
            try {
                await navigator.share({
                    url: generatedLink,
                });
            } catch (err) {
                if ((err as Error).name !== 'AbortError') {
                    handleCopy();
                }
            }
        } else {
            handleCopy();
        }
    };

    const joinRoomAsReceiver = (roomId: string) => {
        if (hasJoinedRef.current) return;
        hasJoinedRef.current = true;
        joinedRoomRef.current = roomId;
        // Every join after the page's first is a re-join: after its own socket
        // came back, or to give the first seat back.
        receiverJoinsRef.current += 1;
        const rejoin = receiverJoinsRef.current > 1;

        setStatus('Connecting');
        // A rebuilt peer starts a receive that has not ended.
        setReceiveEnded(false);

        onRoomFull(() => {
            // Deliberately not receiveOutcome(): this branch is unreachable and
            // its string is never rendered. A room-full answer only follows a
            // join-room, and the reconnect path returns before re-joining once
            // a file has landed (see the guard in the socket reconnect
            // handler), so the condition below is false on every real path.
            // The receiver renders status only under includes('Receiving').
            if (receivedFilesRef.current.length > 0 || transferCompleteRef.current) {
                setStatus('Transfer complete');
                return;
            }
            // A re-join refused because this page's own dead socket may still
            // hold the receiving seat, for up to about 45 s: the sender's
            // schedule and limits (lib/rejoinRetry.ts) before the final card.
            // Measured with a half-open socket (e2e/reconnect.spec.ts): the
            // card used to go up at once over a link that worked again
            // within the minute.
            if (rejoinTimerRef.current) return;
            const mayRetry =
                rejoin &&
                rejoinAllowed({
                    peerConnected: peerRef.current?.connected === true,
                    transferComplete: transferCompleteRef.current,
                });
            const delay = mayRetry ? rejoinDelay(rejoinAttemptRef.current) : null;
            if (delay !== null) {
                rejoinAttemptRef.current += 1;
                rejoinTimerRef.current = setTimeout(() => {
                    rejoinTimerRef.current = null;
                    joinRoom(roomId);
                }, delay);
                return;
            }
            setError(LINK_INVALID);
            setStatus('Access Denied');
        });

        // The role the server names is the only word on whether anyone was
        // already here: a receiver page named "sender" opened a link nobody
        // holds. Registered before the join, so the answer cannot be missed.
        // A server that sent no role would leave this page as it was before.
        onRoomJoined((data) => {
            // Seated: a retry still pending would join a second time.
            clearRejoin();
            rejoinAttemptRef.current = 0;
            applySeat({ type: 'joined', role: typeof data?.role === 'string' ? data.role : '' });
        });

        // Announced only to the first seat. On a receiver page that means a
        // peer arrived behind it: a sender coming back, whose own page waits
        // for this same notice before it offers. Give the first seat back by
        // re-joining, once (lib/roomSeat.ts says why once), with a fresh peer
        // as the socket reconnect path builds one.
        onUserConnected(() => {
            const yieldSeat = applySeat({
                type: 'peer-arrived',
                connected: peerRef.current?.connected === true,
                hasFile: receivedFilesRef.current.length > 0 || transferCompleteRef.current,
            });
            if (!yieldSeat || !joinedRoomRef.current) return;
            Sentry.addBreadcrumb({
                category: 'webrtc',
                message: 'Receiver gave the first seat back to an arriving peer',
                level: 'info',
            });
            // A banner from the attempt that failed must not sit over the one
            // that is starting. The socket reconnect path clears it too.
            setError((prev) => (isLinkInvalid(prev) ? prev : ''));
            closedByUsRef.current = peerRef.current;
            peerRef.current?.destroy();
            hasJoinedRef.current = false;
            rejoinAsReceiver(joinedRoomRef.current);
        });

        joinRoom(roomId);

        wireReasonRef.current = false;
        const peer = new SimplePeer({
            initiator: false,
            trickle: true,
            // readableObjectMode keeps the SCTP text/binary bit intact.
            // simple-peer pushes frames into a readable-stream Duplex, and
            // without it every text frame is Buffer.from()ed before Floe sees
            // it, so the receiver could only guess a frame from its bytes and
            // would eat a small file whose whole content was control-shaped
            // JSON (#316). Binary frames still arrive as a Buffer; text frames
            // now arrive as a string. simple-peer passes its options straight
            // to super(opts) and never sets objectMode itself.
            readableObjectMode: true,
            config: {
                iceServers: iceList.current(),
            },
        });

        peer.on('signal', (signal) =>
            sendSignal({ target: null, roomId, signal })
        );
        peer.on('connect', () => {
            setIsConnected(true);
            requestWakeLock();
            startConnectionTypePolling(peer);
            Sentry.addBreadcrumb({
                category: 'webrtc',
                message: 'Receiver peer connected',
                level: 'info',
            });
        });
        peer.on('close', () => {
            releaseWakeLock();
            resetConnectionType();
            stopConnectionTypePolling();
            // A Go sender closes about 50 ms after its last end marker, while
            // this side may still be checking that file's SHA-256, so the
            // decision waits for the check and counts the file it produces.
            void rx.settled().then(() => {
                // The branchy part lives in client/lib/receiverClose.ts, where it
                // can be tested: nothing in the suite mounts this component, and
                // two of these three branches were wrong on the first attempt.
                const decision = decideReceiverClose({
                    closedByUs: closedByUsRef.current === peer,
                    replaced: peerRef.current !== peer,
                    wireReason: wireReasonRef.current,
                    receivedCount: receivedFilesRef.current.length,
                });
                if (decision.kind !== 'silent') {
                    // The connection is gone, so stop saying it is up. This
                    // handler used to write a breadcrumb and nothing else, which
                    // left the connected badge and the last status line on screen
                    // after the sender had walked away.
                    setIsConnected(false);
                    setReceiveEnded(true);
                    if (decision.kind === 'outcome') {
                        setStatus(receiveOutcome());
                    } else {
                        setError((prev) => prev || decision.error);
                        setStatus('Transfer failed');
                    }
                }
                Sentry.addBreadcrumb({
                    category: 'webrtc',
                    message: 'Receiver peer connection closed',
                    level: 'info',
                    data: { filesReceived: receivedFilesRef.current.length, transferComplete: transferCompleteRef.current },
                });
            });
        });
        peer.on('error', (err) => {
            // Read now, not inside the wait below: the close that follows this
            // error clears the progress line (rx.dispose) before the wait
            // resolves, and the report would say 0% again.
            const progressAtError = progressRef.current;
            // Waits for a SHA-256 check in progress, like the close handler, so
            // a file that is about to be handed over is counted before this
            // decides whether anything arrived.
            void rx.settled().then(() => {
                // The peer already told us why. peer.destroy() on either side
                // surfaces here as "User-Initiated Abort" a moment later, and
                // overwriting the reason with connection advice is exactly the
                // wrong-cause problem this is fixing.
                if (wireReasonRef.current) return;
                if (receivedFilesRef.current.length > 0 || transferCompleteRef.current) {
                    setStatus('Connection interrupted');
                    return;
                }

                // Known expected outcomes — not application bugs:
                // "Ice connection failed." / "Connection failed." — relay likely disabled on sender
                // "User-Initiated Abort" — sender closed the tab or peer was destroyed
                // Log a breadcrumb but do NOT send to Sentry.
                const { isExpected, reason } = classifyPeerError(err.message, { code: peerErrorCodeOf(err) });

                if (isExpected) {
                    Sentry.addBreadcrumb({
                        category: 'webrtc',
                        message: 'Receiver: expected connection error',
                        level: 'warning',
                        data: { reason, errorCode: peerErrorCodeOf(err) },
                    });
                    // A deliberate abort is not a connection problem, and telling
                    // someone to enable a relay that may already be on is the
                    // wrong cause dressed up as advice. classifyPeerError already
                    // separated the two for analytics; use the same split here.
                    // The other branch names no control: this page cannot know
                    // what kind of sender it has, and the relay is a checkbox
                    // in the browser, --no-relay on the CLI, and always on in
                    // Floe Desktop. It cannot know the relay was off either:
                    // a sender that slept, lost its network or was stopped
                    // raises the same two errors, so the relay is an "if". And
                    // it says the connection failed, not that nothing
                    // connected: the guard above counts finished files, so
                    // this also shows after the channel opened, with the first
                    // file on its way.
                    setError(
                        reason === 'abort'
                            ? 'The sender ended the transfer. Ask them to start it again.'
                            : 'Connection failed. Ask the sender to try again. If they turned the relay off, ask them to leave it on.'
                    );
                } else {
                    // Unexpected: reported for investigation by its code.
                    // Never the error object or its message, which can quote
                    // what the other peer sent (lib/peerErrors.ts).
                    // The banner first: nothing in the report below may
                    // cost the person the one explanation they get.
                    setError(peerErrorBanner('receiver'));
                    const report = peerErrorReport('receiver', err);
                    Sentry.withScope((scope) => {
                        scope.setContext('webrtc', {
                            role: 'receiver',
                            connectionType,
                            filesReceived: receivedFilesRef.current.length,
                            progressPercent: progressAtError,
                            errorCode: report.code,
                        });
                        scope.setTags(report.tags);
                        scope.setFingerprint(report.fingerprint);
                        Sentry.captureMessage(report.message, 'error');
                    });
                }
                // Track failed connection attempt
                track('transfer-failed', { reason, role: 'receiver' });
                setStatus('Connection failed');
            });
        });

        const rx = createReceiver({
            send: (d) => peer.send(d),
            onFileStart: (index, total) => {
                expectedFilesRef.current = total;
                setExpectedFiles(total);
                setAllArrived(false);
                setTransferSpeed('');
                setEstimatedTime('');
                setStatus(`Receiving file ${index} of ${total}`);
            },
            onProgress: (pct) => {
                // Written on both roles now. It was sender-only, and the
                // receiver error scope reads it, so every receiver failure
                // reached Sentry as 0% however far it had actually got.
                progressRef.current = pct;
                setProgress(pct);
            },
            onSpeed: (bps, eta) => {
                setTransferSpeed(formatSpeed(bps));
                setEstimatedTime(formatETA(eta));
            },
            onSpeedReset: () => {
                setTransferSpeed('');
                setEstimatedTime('');
            },
            // The same slot as the Receiving line: the file's bytes are all
            // here and its SHA-256 is being checked. index and total are the
            // sender's announced position and count, rendered as digits in a
            // fixed template and nowhere else.
            onVerifying: (index, total) => setStatus(`Verifying file ${index} of ${total}`),
            onFileComplete: (file) => {
                const url = URL.createObjectURL(file.blob);
                const newFile = {
                    id: uuidv4(),
                    fileName: file.fileName,
                    fileSize: file.fileSize,
                    downloadUrl: url,
                    // A local compare result from receiver.ts, never a peer
                    // value.
                    verified: file.verified,
                };
                setReceivedFiles((prev) => {
                    const updated = [...prev, newFile];
                    receivedFilesRef.current = updated;
                    return updated;
                });
                transferCompleteRef.current = true;
            },
            onAllComplete: (totalBytes, fileCount) => {
                // No value read: it fires when the file the sender announced
                // as its last is handed over. Lets go only of the leave
                // prompt's under-way half; an unsaved file still holds it.
                setAllArrived(true);
                track('transfer-received', {
                    files: fileCount,
                    bytes: totalBytes,
                    connection: connectionTypeRef.current ?? 'unknown',
                    role: 'receiver',
                });
                reportBytes(totalBytes);
            },
            onWaiting: () => setStatus('File received. Waiting for next file'),
            onError: (msg, failure) => {
                // Latched: this is the protocol's own account of what went
                // wrong, and the close that follows must not talk over it.
                // That latch also silences the peer error handler, which is
                // where a receiver's transfer-failed event normally comes
                // from, so report it here instead of losing it.
                wireReasonRef.current = true;
                // The message first: this may run with the tab short of
                // memory, and nothing below may cost the person the only
                // explanation they get. It can be the sender's own words
                // (a stop with a reason), so it goes through peerBanner:
                // it must never be the Link Invalid card's value.
                setError(peerBanner(msg, 'The sender stopped the transfer.'));
                setStatus('Transfer failed');
                setReceiveEnded(true);
                if (failure && !failure.senderSentVersion) {
                    // The receiver told the sender why, but a browser sender
                    // reads nothing while it sends a file, so it would push the
                    // rest of the file into a receiver that drops it and then
                    // report success. Give the frame time to leave, then close.
                    // Not for a Go sender: it stops on the frame itself, and a
                    // close that lands while it waits on backpressure would
                    // replace the reason with "connection closed".
                    setTimeout(() => {
                        closedByUsRef.current = peer;
                        peer.destroy();
                    }, CONTROL_FLUSH_MS);
                }
                try {
                    track('transfer-failed', { reason: failure?.code ?? 'peer-reason', role: 'receiver' });
                    if (failure) {
                        // One report per transfer: the receiver has already
                        // stopped, so nothing after this frame can throw again.
                        // Sizes only; the file name is the peer's and stays out.
                        Sentry.withScope((scope) => {
                            scope.setContext('receive', {
                                receivedBytes: failure.received,
                                expectedBytes: failure.expected,
                                filesReceived: receivedFilesRef.current.length,
                                connectionType: connectionTypeRef.current ?? 'unknown',
                                // Chromium only, rounded and capped at 8 by the browser.
                                deviceMemoryGiB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
                            });
                            if (failure.code === 'out-of-memory') {
                                // The documented ceiling of a browser receiver,
                                // not a bug: one warning-level issue that counts
                                // how often people reach it.
                                scope.setFingerprint(['receiver-out-of-memory']);
                                Sentry.captureMessage('Receiver ran out of memory', 'warning');
                            } else {
                                // Fixed words, the error's class and its
                                // stack frames. Never the thrown value: its
                                // message is the engine's, written while it
                                // handled the other device's frames.
                                Sentry.captureException(reportableCause(failure.cause));
                            }
                        });
                    }
                } catch {
                    // Telemetry is best effort; the person has their message.
                }
            },
        });
        peer.on('data', rx.handleMessage);
        // A connection that dies mid-file must not leave the partial file
        // held for the life of the tab.
        peer.on('close', rx.dispose);
        peerRef.current = peer;
    };

    useEffect(() => {
        let cancelled = false;
        // The cleanup below sets it; a second mount (Strict Mode's double run,
        // were it ever on) must not leave every later receiver rebuild a
        // no-op (rejoinAsReceiver).
        unmountedRef.current = false;
        const roomFromUrl = getRoomFromUrl(window.location.hash, window.location.search);

        if (roomFromUrl) {
            if (!isValidRoomId(roomFromUrl)) {
                // A hand-edited or truncated fragment can carry a non-UUID room id.
                // The server would reject the join with an 'error' event we do not
                // listen for, leaving the receiver waiting forever; surface the same
                // "Link Invalid" card the room-full path uses instead of joining.
                // Fragment-derived state is set post-mount (SSR has no fragment),
                // the same one-shot sync as the setIsSender effect above.
                // eslint-disable-next-line react-hooks/set-state-in-effect
                setError(LINK_INVALID);
                setStatus('Access Denied');
                return;
            }
            // The credentials fetch is a round trip, and unmounting during it
            // used to leave the .then to build a SimplePeer, register
            // onRoomFull, emit join-room and assign peerRef, with no cleanup
            // left to tear any of it down. useSignaling already does exactly
            // this one file away.
            iceList.read().then(() => {
                if (cancelled) return;
                joinRoomAsReceiver(roomFromUrl);
            });
        } else {
            void iceList.read();
        }

        return () => {
            cancelled = true;
            unmountedRef.current = true;
            senderSessionRef.current += 1;
            stopConnectionTypePolling();
            releaseWakeLock();
            closedByUsRef.current = peerRef.current;
            peerRef.current?.destroy();
            receivedFilesRef.current.forEach((f) => URL.revokeObjectURL(f.downloadUrl));
            // Three timers that outlived the component: the link-ack fallback
            // would setGeneratedLink post-unmount, the ICE probe would getStats
            // a destroyed peer, and the copy reset would setCopied on nothing.
            if (linkAckFallbackRef.current) clearTimeout(linkAckFallbackRef.current);
            if (iceProbeRef.current) clearTimeout(iceProbeRef.current);
            if (copyResetRef.current) clearTimeout(copyResetRef.current);
            if (rejoinTimerRef.current) clearTimeout(rejoinTimerRef.current);
        };
        // joinRoomAsReceiver is intentionally excluded: this effect must run once on mount only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The room id lives in the URL fragment (#room=<id>). Swapping only the
    // fragment is a same-document navigation, so opening a new room link in an
    // existing tab (e.g. scanning a second QR code on a phone that already has
    // Floe open) changes the hash without reloading, so the mount effect above
    // never re-runs and the tab stays stuck on the previous transfer. Detect
    // that here and reload so the receiver joins the new room from a clean slate.
    useEffect(() => {
        const onHashChange = () => {
            const room = getRoomFromUrl(window.location.hash, window.location.search);
            if (room && room !== joinedRoomRef.current) {
                window.location.reload();
            }
        };
        window.addEventListener('hashchange', onHashChange);
        return () => window.removeEventListener('hashchange', onHashChange);
    }, []);

    useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible' && isConnected) {
                requestWakeLock();
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () =>
            document.removeEventListener(
                'visibilitychange',
                handleVisibilityChange
            );
    }, [isConnected, requestWakeLock]);

    useEffect(() => {
        const status =
            connectionType === 'direct' ? 'direct' :
                connectionType === 'relay' ? 'relay' :
                    isConnected ? 'connected' :
                        'offline';
        window.dispatchEvent(new CustomEvent('floe-connection-status', { detail: status }));
    }, [isConnected, connectionType]);

    const handleCreateLink = () => {
        setLinkPending(true);
        const newRoomId = uuidv4();
        // A unique per-link nonce in the query string (not the fragment) makes
        // every transfer link a distinct document. Without it, two links differ
        // only in the fragment, which browsers treat as the same page, so a phone
        // that already has Floe open can reuse a stale tab when a new QR is
        // scanned instead of joining the new room. The secret room id stays in
        // the fragment (never sent to the server); the nonce carries no info.
        const nonce = uuidv4().slice(0, 8);
        const link = buildShareLink(window.location.origin, newRoomId, nonce);
        createdRoomRef.current = newRoomId;
        // Render the link only after the server confirms the join. The link is
        // an invitation into this room, so the sender must hold the room's
        // sender slot before the link is shareable: a receiver that follows
        // the link into a room the server has not created yet is handed the
        // sender role itself, and a CLI receiver then exits with "expected
        // receiver role" (the dominant CI flake; the ack round-trip is one
        // RTT, imperceptible next to it). A reconnect re-join re-fires this
        // handler with the same link, a no-op re-render. If the ack never
        // arrives (lossy path, misbehaving proxy), show the link after 3s
        // anyway rather than leaving the user stuck; pre-ack render was the
        // status quo of every release until now.
        if (linkAckFallbackRef.current) clearTimeout(linkAckFallbackRef.current);
        linkAckFallbackRef.current = setTimeout(() => setGeneratedLink(link), 3000);
        onRoomJoined(() => {
            if (linkAckFallbackRef.current) clearTimeout(linkAckFallbackRef.current);
            setGeneratedLink(link);
            // Seated, so nothing may join again: a retry still pending would
            // move this page out of its seat (lib/rejoinRetry.ts).
            clearRejoin();
            rejoinAttemptRef.current = 0;
            setStatus(statusOnceSeated);
        });
        // The server refused this page's own room. That only follows a
        // re-join after a reconnect: the socket that died may still hold its
        // seat for up to about 45 s, and a receiver that arrived meanwhile
        // makes the room full. Nothing listened for the answer, so the page
        // kept showing a link into a room it was not in, and the receiver
        // waited for an offer nobody would make. Try again until the dead
        // socket is gone, then say so if the room is still closed to us.
        const mayRejoin = () =>
            rejoinAllowed({
                peerConnected: peerRef.current?.connected === true,
                transferComplete: transferCompleteRef.current,
            });
        onRoomFull(() => {
            if (rejoinTimerRef.current) return;
            // Not once the peer is up or the files are sent: see rejoinAllowed.
            if (!mayRejoin()) return;
            const delay = rejoinDelay(rejoinAttemptRef.current);
            if (delay === null) {
                setError('This link stopped working. Reload the page, add the files again, and share the new link.');
                setStatus(REJOIN_FAILED_STATUS);
                setDeadEnd(true);
                return;
            }
            rejoinAttemptRef.current += 1;
            setStatus(REJOINING_STATUS);
            rejoinTimerRef.current = setTimeout(() => {
                rejoinTimerRef.current = null;
                if (!mayRejoin()) return;
                joinRoom(newRoomId);
            }, delay);
        });
        joinRoom(newRoomId);
        setStatus('Waiting for peer');

        onUserConnected(async (userId: string) => {
            // This session, so the wait for the relay list below can tell
            // whether a newer receiver, or unmount, replaced it meanwhile.
            const session = ++senderSessionRef.current;
            if (peerRef.current && !peerRef.current.destroyed) {
                closedByUsRef.current = peerRef.current;
                peerRef.current.destroy();
            }
            // The destroyed peer's ICE probe goes with it. simple-peer nulls
            // _pc on destroy, so the orphan cannot reach getStats(); what it
            // does instead is record a false "ICE resolved: direct" breadcrumb
            // against a dead peer. Clear at the event that invalidates the
            // probe, not when the next peer connects: a replacement that never
            // connects would otherwise leave the stale one armed.
            if (iceProbeRef.current) clearTimeout(iceProbeRef.current);
            // Clear the previous verdict. A blocked transfer tears its peer down,
            // so the next receiver to join arrives here; without this the amber
            // "capped at 2 GB" banner would still be up during a transfer that
            // is under the cap.
            setRelayBlocked(false);
            // The only place a sender session begins, so the only place these
            // may be cleared: both are per peer, and the wire-reason latch has
            // to be down before the next peer can set it.
            wireReasonRef.current = false;
            // So are these two, and they were never cleared. Once one send
            // had finished, every later one was read through it: a second
            // recipient who stopped mid-file and then left the room turned
            // the status to a green "Transfer complete", where a first
            // recipient doing the same leaves "Peer disconnected. Waiting for
            // reconnection". The handlers that read them (the two disconnect
            // callbacks above, onReconnect, the room-full retry, and this
            // peer's close and error handlers) now see the send in hand.
            transferCompleteRef.current = false;
            progressRef.current = 0;
            setAllVerified(false);
            // A new recipient is a new send. Without this the rows kept the
            // last send's marks, and its last row spun at 100% for the two
            // seconds before the first file starts.
            setSendEnd('open');
            setDeadEnd(false);
            setCurrentFileIndex(0);
            setProgress(0);
            // So do its speed and its banner. A banner about the send that is
            // over must not sit over the one that is starting (the receiver's
            // own restart clears its banner for the same reason), and the
            // close handler keeps a banner that is already up, so an old one
            // also hid the next failure's own message.
            setTransferSpeed('');
            setEstimatedTime('');
            setError('');
            setStatus('Peer joined. Starting transfer');
            requestWakeLock();

            // A page left open past the list's hour, or one whose read at load
            // failed, reads it again before it offers (lib/iceList.ts).
            await freshenWithin(iceList);
            if (session !== senderSessionRef.current) return;

            const iceConfig = filterIceServers(iceList.current(), relayEnabled);

            const peer = new SimplePeer({
                initiator: true,
                trickle: true,
                // readableObjectMode keeps the SCTP text/binary bit intact.
                // simple-peer pushes frames into a readable-stream Duplex, and
                // without it every text frame is Buffer.from()ed before Floe sees
                // it, so the receiver could only guess a frame from its bytes and
                // would eat a small file whose whole content was control-shaped
                // JSON (#316). Binary frames still arrive as a Buffer; text frames
                // now arrive as a string. simple-peer passes its options straight
                // to super(opts) and never sets objectMode itself.
                readableObjectMode: true,
                config: {
                    iceServers: iceConfig,
                },
            });

            peer.on('signal', (signal) =>
                sendSignal({ target: userId, signal })
            );
            peer.on('connect', () => {
                setIsConnected(true);
                startConnectionTypePolling(peer);
                // A join this page's room refused may still be on its retry
                // schedule. The connection came up without it, so it ends
                // here, and its status gives way to the transfer's own.
                clearRejoin();
                rejoinAttemptRef.current = 0;
                setStatus((s) => (s === REJOINING_STATUS || s === REJOIN_FAILED_STATUS ? 'Peer joined. Starting transfer' : s));
                // A link that stopped working reached its recipient after all.
                setDeadEnd(false);

                Sentry.addBreadcrumb({
                    category: 'webrtc',
                    message: 'Sender peer connected',
                    level: 'info',
                    data: { relayEnabled, filesCount: files.length, totalBytes },
                });

                iceProbeRef.current = setTimeout(async () => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const pc = (peer as any)._pc as RTCPeerConnection | undefined;
                    let isRelay = false;
                    if (pc) {
                        try {
                            isRelay = probeIsRelay(await pc.getStats());
                        } catch { }
                    }

                    Sentry.addBreadcrumb({
                        category: 'webrtc',
                        message: `ICE resolved: ${isRelay ? 'relay' : 'direct'}`,
                        level: 'info',
                        data: { isRelay, totalBytes },
                    });

                    const totalSize = files.reduce((s, f) => s + f.file.size, 0);
                    const verdict = evaluateRelayGate({ isRelay, relayEnabled, totalSize });

                    if (verdict.action === 'block-relay-disabled') {
                        // The checkbox is gone once a link exists. A reload
                        // brings it back, checked, when files are added again.
                        setError('Connection failed. This link was made with Network relay fallback off. Reload the page, add the files again, leave it on, and share the new link.');
                        setStatus('Connection failed');
                        if (peerRef.current === peer) setDeadEnd(true);
                        Sentry.addBreadcrumb({
                            category: 'transfer',
                            message: 'Transfer blocked: relay detected but relay fallback disabled by user',
                            level: 'warning',
                            data: { isRelay, relayEnabled },
                        });
                        // Tell the receiver why, as the over-limit branch
                        // below does. A bare close read on the other side as
                        // "the sender ended the transfer, ask them to start it
                        // again", and a restart fails the same way.
                        await sendAbortReason(
                            (d) => peer.send(d),
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            (peer as any)._channel as RTCDataChannel | undefined,
                            RELAY_OFF_REASON
                        );
                        peer.destroy();
                        return;
                    }

                    if (verdict.action === 'block-over-limit') {
                        setStatus('Transfer blocked. Relay limit exceeded.');
                        setRelayBlocked(true);
                        // Its notice says to reload: no prompt on the way.
                        if (peerRef.current === peer) setDeadEnd(true);
                        Sentry.addBreadcrumb({
                            category: 'transfer',
                            message: 'Transfer blocked: relay size limit exceeded',
                            level: 'warning',
                            data: { totalSize: verdict.totalSize, limitBytes: RELAY_SIZE_LIMIT },
                        });
                        // Tell the receiver, or all it gets is the close, and
                        // its own reading of that used to be "enable Network
                        // Relay" even when relay was already on and the cap was
                        // the whole problem. Sent as TEXT, because on the
                        // sender-to-receiver path a binary frame is file data
                        // by definition, and it waits for the wire so the
                        // destroy below does not take it along.
                        await sendAbortReason(
                            (d) => peer.send(d),
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            (peer as any)._channel as RTCDataChannel | undefined,
                            'Transfer blocked: relay connections are capped at 2 GB. ' +
                                'Ask the sender to send 2 GB or less, or to try a network that allows a direct connection.'
                        );
                        // Without this the connection stayed open and the person
                        // on the other end waited forever with nothing on screen.
                        // The sibling branch above has always done this.
                        peer.destroy();
                        return;
                    }

                    // Nothing awaits the send (this is a timer callback), so
                    // a throw inside it was an unhandled rejection and nothing
                    // else: the page stayed on its last status line for good.
                    // The throw goes on after the words are up, so Sentry
                    // reports it exactly as it did before.
                    sendAllFiles(peer, files).catch((cause: unknown) => {
                        // A session this page has moved on from, and a send
                        // whose files had all left, keep what they show.
                        if (peerRef.current === peer && !transferCompleteRef.current) {
                            // Latched like a stop the peer reported: this is
                            // the account of what went wrong, and the close or
                            // error that follows when the other device gives
                            // up must not replace it with "Connection lost".
                            wireReasonRef.current = true;
                            setError((prev) => prev || SEND_INTERNAL_ERROR);
                            setStatus('Transfer failed');
                            setSendEnd((end) => (end === 'open' ? 'failed' : end));
                            void tellAndClose(peer, SELF_STOP_REASONS.internal);
                        }
                        throw cause;
                    });
                }, 2000);
            });
            peer.on('close', () => {
                releaseWakeLock();
                resetConnectionType();
                stopConnectionTypePolling();
                Sentry.addBreadcrumb({
                    category: 'webrtc',
                    message: 'Sender peer connection closed',
                    level: 'info',
                    data: { progress: progressRef.current, transferComplete: transferCompleteRef.current },
                });
                // A receiver that stops mid-file (it ran out of memory, or its
                // tab closed) closes the connection, and the send engine then
                // stops without a word: the screen stayed on "Sending: <name>".
                // Same status the error handler uses mid-transfer; the words
                // stay neutral because a failed network ends up here too.
                if (
                    senderCloseInterrupted({
                        transferComplete: transferCompleteRef.current,
                        progress: progressRef.current,
                        closedByUs: closedByUsRef.current === peer,
                        wireReason: wireReasonRef.current,
                    })
                ) {
                    setError((prev) => prev || 'The connection closed before the transfer finished.');
                    setStatus('Connection interrupted');
                    // The file that was moving stops spinning.
                    if (peerRef.current === peer) setSendEnd((end) => (end === 'open' ? 'failed' : end));
                }
            });
            peer.on('error', (err) => {
                // The peer already told us why (onStopped). Overwriting a named
                // refusal with "Connection interrupted" is the wrong-cause
                // problem the receiver's own guard above already fixes.
                if (wireReasonRef.current) return;
                if (transferCompleteRef.current || progressRef.current > 0) {
                    setStatus('Connection interrupted');
                    // A send that was still open stops here. One that was
                    // delivered stays delivered: every file had left this
                    // browser before the connection went.
                    if (peerRef.current === peer) setSendEnd((end) => (end === 'open' ? 'failed' : end));
                    return;
                }

                const { isExpected, reason } = classifyPeerError(err.message, { relayEnabled, code: peerErrorCodeOf(err) });

                if (isExpected) {
                    Sentry.addBreadcrumb({
                        category: 'webrtc',
                        message: 'Sender: expected connection error',
                        level: 'warning',
                        data: { relayEnabled, reason, errorCode: peerErrorCodeOf(err) },
                    });
                    // The relay sentence only when the relay could be the
                    // cause: see senderErrorBlamesRelay. It says to reload, so
                    // that reload asks nothing.
                    const blamesRelay = senderErrorBlamesRelay(err.message, relayEnabled, peerErrorCodeOf(err));
                    setError(
                        blamesRelay
                            ? 'Connection failed. This link was made with Network relay fallback off. Reload the page, add the files again, leave it on, and share the new link.'
                            : 'Connection lost. The other device may have closed the tab.'
                    );
                    if (blamesRelay && peerRef.current === peer) setDeadEnd(true);
                } else {
                    // By its code, never the error object or its message
                    // (the receiver's handler above says why).
                    setError(peerErrorBanner('sender'));
                    const report = peerErrorReport('sender', err);
                    Sentry.withScope((scope) => {
                        scope.setContext('webrtc', {
                            role: 'sender',
                            relayEnabled,
                            connectionType,
                            filesCount: files.length,
                            totalBytes,
                            progressPercent: progressRef.current,
                            errorCode: report.code,
                        });
                        scope.setTags(report.tags);
                        scope.setFingerprint(report.fingerprint);
                        Sentry.captureMessage(report.message, 'error');
                    });
                }
                track('transfer-failed', {
                    reason,
                    role: 'sender',
                    files: files.length,
                    bytes: totalBytes,
                });
                setStatus('Connection failed');
            });

            peerRef.current = peer;
        });
    };

    // Tells the receiver why this side stopped, waits for the frame to reach
    // the wire, then closes. A send that stopped here used to leave the
    // connection open with nothing said, so the receiving page sat on its
    // last status line for as long as this tab stayed open.
    const tellAndClose = async (peer: PeerInstance, reason: string) => {
        if (peer.destroyed) return;
        await sendAbortReason(
            (d) => peer.send(d),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (peer as any)._channel as RTCDataChannel | undefined,
            reason
        );
        closedByUsRef.current = peer;
        peer.destroy();
    };

    const sendAllFiles = async (peer: PeerInstance, fileList: FileWithId[]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const channel = (peer as any)._channel as RTCDataChannel | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pc = (peer as any)._pc as RTCPeerConnection | undefined;

        if (!channel) return;

        // Written by onFailed: a stop on this side that the receiver has not
        // been told about. A holder, so the read after the await is not
        // narrowed to the initial null.
        const failed: { stop: SelfStop | null } = { stop: null };

        await sendFilesEngine(
            {
                send: (d) => peer.send(d),
                onData: (handler) => {
                    peer.on('data', handler);
                    return () => peer.off('data', handler);
                },
                channel,
                sctpMaxMessageSize: pc?.sctp?.maxMessageSize,
            },
            fileList.map((f) => ({ id: f.id, file: f.file })),
            {
                isDestroyed: () => peer.destroyed,
                onFileStart: (i, _total, name) => {
                    setCurrentFileIndex(i);
                    setStatus(`Sending: ${name}`);
                    setProgress(0);
                },
                onProgress: (pct) => {
                    setProgress(pct);
                    progressRef.current = pct;
                },
                onSpeed: (bps, eta) => {
                    setTransferSpeed(formatSpeed(bps));
                    setEstimatedTime(formatETA(eta));
                },
                onSpeedReset: () => {
                    setTransferSpeed('');
                    setEstimatedTime('');
                },
                // Also how a refusal that arrives after the last byte is
                // reported (onStopped follows it in the same tick), so this
                // is where a delivered send becomes a failed one.
                onError: (msg) => {
                    // A session that was replaced while it waited for an
                    // answer still reports its end, and that report is about a
                    // connection this page has moved on from.
                    if (peerRef.current !== peer) return;
                    // The receiver's own words when it stopped with a
                    // reason: never the Link Invalid card's value.
                    setError(peerBanner(msg, 'The other side rejected the transfer.'));
                    setStatus('Transfer failed');
                    setSendEnd('failed');
                },
                // An unreadable file or the ack wait: the engine has stopped
                // and said so on this page only. A closed channel has no one
                // left to tell (selfStopOf).
                onFailed: ({ kind }) => {
                    failed.stop = selfStopOf(kind);
                },
                onAllSent: () => {
                    setStatus('All Files Sent!');
                    setProgress(100);
                    if (peerRef.current === peer) setSendEnd('delivered');
                    transferCompleteRef.current = true;
                    releaseWakeLock();
                    track('transfer-complete', {
                        files: fileList.length,
                        bytes: fileList.reduce((s, f) => s + f.file.size, 0),
                        connection: connectionTypeRef.current ?? 'unknown',
                        role: 'sender',
                    });
                },
                // Reduced to a boolean here, before anything a render can read:
                // the receiver's count is a claim, and no number goes on screen.
                onDelivered: ({ allVerified: ok }) => setAllVerified(ok),
                onStopped: (stop) => {
                    // Latched for the same reason the receiver's onError is:
                    // this is the protocol's own account, and the close and
                    // error events that follow must not talk over it. For
                    // every stop the peer reports, not only the one with a
                    // sentence of its own below: a refusal with any other
                    // code after the last byte left "Transfer failed" under
                    // its banner, and the next socket drop or the peer's
                    // leaving wrote "Transfer complete" over it.
                    wireReasonRef.current = true;
                    // Counted here, once, for every stop the peer reports. The
                    // error handler that used to count a refusal other than a
                    // hash mismatch now returns at the latch, so without this
                    // such a send failed without being counted at all.
                    track('transfer-failed', {
                        reason: 'peer-reason',
                        role: 'sender',
                        files: fileList.length,
                        bytes: fileList.reduce((s, f) => s + f.file.size, 0),
                    });
                    const sentence = describeSenderStop({ ...stop, files: fileList.length });
                    if (!sentence) return;
                    // onStopped runs after onError inside reportStop, so this
                    // overwrites the generic wording in the same tick; every
                    // other code keeps that wording.
                    setError(sentence);
                    setStatus('Transfer failed');
                    setAllVerified(false);
                },
            }
        );

        if (failed.stop) {
            // Latched like the internal-error path: this page's banner is the
            // account, and a later disconnect notice must not overwrite it.
            if (peerRef.current === peer) wireReasonRef.current = true;
            await tellAndClose(peer, SELF_STOP_REASONS[failed.stop]);
        }
    };

    if (isSender === null) {
        return (
            <main className="w-full flex justify-center z-10 relative">
                <Card className="w-full max-w-md gap-5 overflow-visible border-white/10 bg-zinc-900/60 shadow-2xl backdrop-blur-xl sm:max-w-lg">
                    <CardHeader className="flex items-center justify-between border-b border-white/[0.06] !pb-4">
                        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                            Transfer
                        </span>
                    </CardHeader>
                    <CardContent className="flex items-center justify-center py-14">
                        <Loader2 className="w-8 h-8 animate-spin text-zinc-500" />
                    </CardContent>
                </Card>
            </main>
        );
    }

    return (
        <main className="w-full flex justify-center z-10 relative">
            <Card className="w-full max-w-md gap-5 overflow-visible border-white/10 bg-zinc-900/60 shadow-2xl backdrop-blur-xl sm:max-w-lg">
                <CardHeader className="flex items-center justify-between border-b border-white/[0.06] !pb-4">
                    <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                        {isSender ? 'Send' : 'Receive'}
                    </span>
                    <ConnectionStatusBadge
                        isSender={isSender}
                        isConnected={isConnected}
                        ping={ping}
                        connectionType={connectionType}
                    />
                </CardHeader>

                <CardContent className="space-y-4">
                    {isLinkInvalid(error) ? (
                        <div className="flex flex-col items-center justify-center py-8 text-center space-y-4">
                            <div className="h-16 w-16 rounded-full bg-red-500/10 flex items-center justify-center mb-2">
                                <Link2Off className="h-8 w-8 text-red-500" />
                            </div>
                            <div className="space-y-1">
                                <h3 className="text-xl font-semibold text-white">
                                    Link Invalid
                                </h3>
                                <p className="text-sm text-zinc-500 max-w-[260px] mx-auto">
                                    This link is incomplete, already in use, or
                                    locked to the networks that first used it.
                                </p>
                            </div>
                            <Button
                                variant="outline"
                                onClick={() => (window.location.href = '/')}
                                className="mt-4 border-zinc-700 bg-transparent hover:bg-zinc-800 text-zinc-300"
                            >
                                Back to Home
                            </Button>
                        </div>
                    ) : (
                        <>
                            {error && !isLinkInvalid(error) && (
                                <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 flex items-start gap-3">
                                    <AlertCircle className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5" />
                                    <div className="flex-1 text-sm text-red-300">{error}</div>
                                    <button
                                        onClick={() => setError('')}
                                        className="relative before:absolute before:-inset-3.5 text-red-400 hover:text-red-300"
                                    >
                                        <X className="h-4 w-4" />
                                    </button>
                                </div>
                            )}
                            {isSender && showRelayLimitNotice && (
                                <div className="mt-2 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 flex items-start gap-3">
                                    <AlertTriangle className="h-4 w-4 text-amber-400 flex-shrink-0 mt-0.5" />
                                    <div className="flex-1 text-xs text-amber-300 leading-relaxed">
                                        Transfer limit exceeded. Relay connections are capped at 2 GB. Reload the page to send 2 GB or less, or to send from a network that supports a direct connection.{' '}
                                        <a href="/how-it-works#size-limit" target="_blank" rel="noreferrer" className="underline underline-offset-2 text-amber-400 hover:text-white transition-colors">
                                            Learn more
                                        </a>
                                    </div>
                                </div>
                            )}

                            {progress > 0 && (
                                <hr className="border-white/5 my-2" />
                            )}

                            {progress > 0 && (
                                <TransferProgressBar
                                    isSender={isSender}
                                    status={status}
                                    sendEnd={sendEnd}
                                    currentFileIndex={currentFileIndex}
                                    filesCount={files.length}
                                    transferSpeed={transferSpeed}
                                    estimatedTime={estimatedTime}
                                    progress={progress}
                                />
                            )}

                            {isSender && !filesLocked && files.length === 0 && (
                                <div
                                    onDragOver={handleDragOver}
                                    onDragLeave={handleDragLeave}
                                    onDrop={handleDrop}
                                    // text-center, not just items-center: items-center
                                    // centres each <p> as a box, but its text still sets
                                    // to the start edge, so the moment the hint wraps the
                                    // second line hangs left under a centred first one.
                                    // It wraps below about 430px, which is most phones.
                                    className={`group relative mt-2 flex flex-col items-center justify-center rounded-xl border border-dashed p-10 text-center transition-all sm:p-14 ${isDragging
                                        ? 'border-ice bg-ice/[0.04]'
                                        : 'border-white/15 hover:border-white/35 hover:bg-white/[0.02]'
                                        }`}
                                >
                                    <div className={`mb-4 flex h-12 w-12 items-center justify-center rounded-full border transition ${isDragging
                                        ? 'border-ice/60 bg-ice/10'
                                        : 'border-white/10 bg-white/[0.03] group-hover:border-white/25'
                                        }`}>
                                        <UploadCloud className={`h-5 w-5 transition ${isDragging ? 'text-ice' : 'text-zinc-400 group-hover:text-zinc-200'
                                            }`} />
                                    </div>
                                    <p className="mb-1.5 text-sm font-medium text-zinc-200">
                                        {isDragging ? 'Release to add files' : 'Drop files or click to browse'}
                                    </p>
                                    {/* One line, always. A second wording for a
                                        relayed connection used to sit here and
                                        could never show: this area is on screen
                                        only before a link exists, and the route
                                        is known only after a peer has joined. */}
                                    <p className="font-mono text-[11px] text-zinc-500">
                                        No size limit from Floe over direct connections
                                    </p>
                                    <Input
                                        type="file"
                                        multiple
                                        // The visible prompt is a sibling <p>, so without this
                                        // the product's primary control is an unnamed input.
                                        aria-label="Choose files to send"
                                        onChange={handleFileSelection}
                                        className="absolute inset-0 h-full w-full opacity-0 cursor-pointer"
                                    />
                                </div>
                            )}

                            {isSender && !filesLocked && files.length > 0 && (
                                <div
                                    onDragOver={handleDragOver}
                                    onDragLeave={handleDragLeave}
                                    onDrop={handleDrop}
                                    className={`group relative mt-2 flex items-center justify-center gap-2 rounded-lg border border-dashed py-3 transition-all ${isDragging
                                        ? 'border-ice bg-ice/[0.04]'
                                        : 'border-white/15 hover:border-white/35 hover:bg-white/[0.02]'
                                        }`}
                                >
                                    <Plus className={`h-3.5 w-3.5 transition ${isDragging ? 'text-ice' : 'text-zinc-500 group-hover:text-zinc-300'}`} />
                                    <span className="text-xs font-medium text-zinc-400 transition group-hover:text-zinc-200">
                                        {isDragging ? 'Release to add files' : 'Add more files'}
                                    </span>
                                    <Input
                                        type="file"
                                        multiple
                                        aria-label="Add more files to send"
                                        onChange={handleFileSelection}
                                        className="absolute inset-0 h-full w-full opacity-0 cursor-pointer"
                                    />
                                </div>
                            )}

                            {isSender && !filesLocked && dropNotice && (
                                <p role="status" className="text-center text-xs leading-relaxed text-amber-300">
                                    {dropNotice}
                                </p>
                            )}

                            {isSender &&
                                (files.length > 0 || generatedLink) && (
                                    <div className="mt-4">
                                        {generatedLink && (
                                            <ShareLinkPanel
                                                generatedLink={generatedLink}
                                                copied={copied}
                                                onCopy={handleCopy}
                                                onShare={handleShare}
                                                showQr={showQr}
                                                onToggleQr={() => setShowQr((v) => !v)}
                                                status={status}
                                                verifiedLine={allVerified ? VERIFIED_LINE : null}
                                                sendEnd={sendEnd}
                                            />
                                        )}

                                        {/* flex-wrap on the count row: the relay-mode string can
                                            outgrow a 320px card; wrapping drops it whole under the label */}
                                        {files.length > 0 && (
                                            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-2 px-0.5">
                                                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">
                                                    Files
                                                </span>
                                                <span className={`text-right font-mono text-[10px] uppercase tracking-[0.2em] ${showRelayLimitNotice ? 'text-amber-500' : 'text-zinc-600'
                                                    }`}>
                                                    {files.length} · {formatBytes(totalBytes)}{connectionType === 'relay' || relayBlocked ? ` / ${formatBytes(RELAY_SIZE_LIMIT)}` : ''}
                                                </span>
                                            </div>
                                        )}

                                        <SelectedFilesList
                                            files={files}
                                            currentFileIndex={currentFileIndex}
                                            progress={progress}
                                            filesLocked={filesLocked}
                                            sendEnd={sendEnd}
                                            onDeleteFile={handleDeleteFile}
                                            listRef={fileListRef}
                                        />

                                        {files.length > 0 && !filesLocked && (
                                            <div className="mt-4 space-y-4">
                                                <RelayFallbackToggle relayEnabled={relayEnabled} onChange={setRelayEnabled} />

                                                <Button
                                                    onClick={handleCreateLink}
                                                    className="w-full bg-white text-black hover:bg-zinc-200 font-bold text-xs sm:text-sm"
                                                >
                                                    Create secure link ({files.length} {files.length === 1 ? 'file' : 'files'})
                                                    <ArrowRight className="w-3.5 h-3.5 sm:w-4 sm:h-4 ml-1.5 sm:ml-2 shrink-0" />
                                                </Button>
                                            </div>
                                        )}

                                        {files.length > 0 && filesLocked && !generatedLink && (
                                            <div className="mt-4 flex w-full items-center justify-center gap-2 py-2.5 text-xs text-zinc-400">
                                                <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                                                <span>Creating secure link...</span>
                                            </div>
                                        )}

                                        {status.includes('Sending') && (
                                            <div className="flex w-full items-center justify-center gap-2 text-xs text-zinc-400 animate-pulse pt-2">
                                                <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                                                <span className="truncate max-w-[280px]">
                                                    Sending file {currentFileIndex + 1} of {files.length}...
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                )}

                            {!isSender && (
                                <ReceiverPanel
                                    receivedFiles={receivedFiles}
                                    status={status}
                                    isConnected={isConnected}
                                    senderAbsent={senderAbsent}
                                    ended={receiveEnded}
                                    reportStatsEnabled={reportStatsEnabled}
                                    onReportStatsChange={setReportStatsEnabled}
                                    isZipping={isZipping}
                                    isDownloading={isDownloading}
                                    downloadProgress={downloadProgress}
                                    onDownloadAll={handleDownloadAll}
                                    onDownloadZip={handleDownloadZip}
                                    onSaved={markSaved}
                                    listRef={fileListRef}
                                    verifiedLine={verifiedLine(receivedFiles, expectedFiles)}
                                    summary={receiveSummary({
                                        received: receivedFiles.length,
                                        expected: expectedFiles,
                                        ended: receiveEnded,
                                    })}
                                />
                            )}
                        </>
                    )}
                </CardContent>

                <CardFooter className="justify-center border-t border-white/[0.06] !pt-4">
                    {/* The keep-open line is for a tab that something depends
                        on. Under the Link Invalid card, while nobody is on the
                        sending side and nothing is unsaved, after an attempt
                        that ended with nothing, and once every file arrived and
                        was saved, nothing does: it told a person the card had
                        just told to leave that closing the tab would interrupt
                        a download. The receiver's half is receiverTabMatters,
                        which holds exactly while the leave prompt does. */}
                    {(isSender && !generatedLink) || (!isSender && !receiverTabHeld) ? (
                        <p className="text-balance text-[10px] uppercase tracking-wide text-zinc-500 text-center leading-relaxed">
                            End-to-end encrypted. Files are never stored on a server.
                        </p>
                    ) : (
                        <p className="text-balance text-[10px] uppercase tracking-wide text-amber-300/80 text-center leading-relaxed">
                            Keep this tab open. Closing it{' '}
                            {isSender ? 'cancels the transfer' : 'interrupts the download'}.
                        </p>
                    )}
                </CardFooter>
            </Card>
        </main>
    );
}
