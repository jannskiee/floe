'use client';

import 'buffer';

/* eslint-disable @typescript-eslint/no-explicit-any */
if (typeof window !== 'undefined') {
    if (!(window as any).global) (window as any).global = window;
    if (!(window as any).process) (window as any).process = { env: {} };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

import { useEffect, useRef, useState } from 'react';
import SimplePeer, { Instance as PeerInstance } from 'simple-peer';
import { v4 as uuidv4 } from 'uuid';
import * as Sentry from '@sentry/nextjs';
import { formatSpeed, formatETA } from '@/lib/transferUtils';
import { createReceiver } from '@/lib/transfer/receiver';
import { sendFiles as sendFilesEngine } from '@/lib/transfer/sender';
import { useWakeLock } from '@/hooks/useWakeLock';
import { useFileManagement, type FileWithId } from '@/hooks/useFileManagement';
import { useDownloadManager, type ReceivedFile } from '@/hooks/useDownloadManager';
import { useSignaling } from '@/hooks/useSignaling';
import { useConnectionType } from '@/hooks/useConnectionType';
import { useTransferAnalytics } from '@/hooks/useTransferAnalytics';
import { useRelayConfiguration } from '@/hooks/useRelayConfiguration';
import { RELAY_SIZE_LIMIT, filterIceServers, evaluateRelayGate, isRelayPair } from '@/lib/relay';
import { classifyPeerError } from '@/lib/peerErrors';

import {
    Card,
    CardContent,
    CardFooter,
    CardHeader,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    AlertCircle,
    AlertTriangle,
    ArrowRight,
    CheckCircle2,
    Circle,
    Download,
    Loader2,
    Plus,
    ShieldCheck,
    UploadCloud,
    FileArchive,
    X,
} from 'lucide-react';
import { formatBytes } from '@/lib/utils';
import { ConnectionStatusBadge } from '@/components/ConnectionStatusBadge';
import { RelayFallbackToggle } from '@/components/RelayFallbackToggle';
import { StatsContributionToggle } from '@/components/StatsContributionToggle';
import { ShareLinkPanel } from '@/components/ShareLinkPanel';
import { TransferProgressBar } from '@/components/TransferProgressBar';
import { SelectedFilesList } from '@/components/SelectedFilesList';
import { ReceivedFilesList } from '@/components/ReceivedFilesList';

// The room id is the transfer's only secret: anyone holding it can join as the
// receiver. It lives in the URL fragment (#room=<id>) so it never leaves the
// browser. Fragments are not sent to the server, are stripped from the Referer
// header, and are ignored by pageview analytics. Older links used the
// ?room=<id> query param (which leaked into those places); we still read them
// for backward compatibility.
function getRoomFromUrl(): string | null {
    if (typeof window === 'undefined') return null;
    const fromHash = new URLSearchParams(
        window.location.hash.replace(/^#/, '')
    ).get('room');
    if (fromHash) return fromHash;
    return new URLSearchParams(window.location.search).get('room');
}

export function P2PTransfer() {
    const [isSender, setIsSender] = useState<boolean | null>(null);
    const [status, setStatus] = useState('Idle');
    const [generatedLink, setGeneratedLink] = useState('');
    const [currentFileIndex, setCurrentFileIndex] = useState(0);
    const [progress, setProgress] = useState(0);
    const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState('');
    const [transferSpeed, setTransferSpeed] = useState('');
    const [estimatedTime, setEstimatedTime] = useState('');
    const [showQr, setShowQr] = useState(false);

    const {
        files,
        isDragging,
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
    } = useDownloadManager(receivedFiles, setError);

    const {
        connectionType,
        startPolling: startConnectionTypePolling,
        stopPolling: stopConnectionTypePolling,
        reset: resetConnectionType,
    } = useConnectionType();

    const { reportStatsEnabled, setReportStatsEnabled, track, reportBytes } = useTransferAnalytics();

    const { relayEnabled, setRelayEnabled } = useRelayConfiguration();

    const isRelayOverLimit = connectionType === 'relay' && totalBytes > RELAY_SIZE_LIMIT;

    const peerRef = useRef<PeerInstance | null>(null);
    const hasJoinedRef = useRef(false);
    // The room this page instance is handling as a receiver. Used to detect a
    // fragment-only navigation (scanning a second QR code into the same tab).
    const joinedRoomRef = useRef<string | null>(null);
    const receivedFilesRef = useRef<ReceivedFile[]>([]);
    const transferCompleteRef = useRef(false);
    const progressRef = useRef(0);
    const fileListRef = useRef<HTMLDivElement>(null);

    const iceServersRef = useRef<RTCIceServer[]>([
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ]);

    const { requestWakeLock, releaseWakeLock } = useWakeLock();

    const {
        isConnected,
        setIsConnected,
        ping,
        joinRoom,
        sendSignal,
        onUserConnected,
        onRoomFull,
    } = useSignaling({
        onSignal: (data) => {
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
                    message: `Ignored signal in state ${pc?.signalingState}: ${(err as Error).message}`,
                });
            }
        },
        onPeerDisconnected: () => {
            if (receivedFilesRef.current.length > 0 || transferCompleteRef.current) {
                setStatus('Transfer complete');
            } else {
                setStatus('Peer disconnected. Waiting for reconnection');
            }
            if (peerRef.current) peerRef.current.destroy();
            releaseWakeLock();
        },
        onDisconnect: () => {
            if (receivedFilesRef.current.length > 0 || transferCompleteRef.current) {
                setStatus('Transfer complete');
            }
        },
        onConnectError: (err) => {
            if (err.message === 'Rate limit exceeded') {
                setError('Too many refreshes. Reconnecting');
            }
        },
        onReconnect: () => setError(''),
    });

    const fetchIceServers = async () => {
        try {
            const response = await fetch(
                `${process.env.NEXT_PUBLIC_SOCKET_URL}/api/turn-credentials`
            );
            const iceServers = await response.json();
            if (Array.isArray(iceServers) && iceServers.length > 0) {
                iceServersRef.current = iceServers;
            }
        } catch {

        }
    };

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setIsSender(!getRoomFromUrl());
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

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(generatedLink);
        } catch {
            const textarea = document.createElement('textarea');
            textarea.value = generatedLink;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
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

        setStatus('Connecting');

        onRoomFull(() => {
            if (receivedFilesRef.current.length > 0 || transferCompleteRef.current) {
                setStatus('Transfer complete');
                return;
            }
            setError('Link Expired or Busy');
            setStatus('Access Denied');
        });

        joinRoom(roomId);

        const peer = new SimplePeer({
            initiator: false,
            trickle: true,
            config: {
                iceServers: iceServersRef.current,
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
            Sentry.addBreadcrumb({
                category: 'webrtc',
                message: 'Receiver peer connection closed',
                level: 'info',
                data: { filesReceived: receivedFilesRef.current.length, transferComplete: transferCompleteRef.current },
            });
        });
        peer.on('error', (err) => {
            if (receivedFilesRef.current.length > 0 || transferCompleteRef.current) {
                setStatus('Connection interrupted');
                return;
            }

            // Known expected outcomes — not application bugs:
            // "Ice connection failed." / "Connection failed." — relay likely disabled on sender
            // "User-Initiated Abort" — sender closed the tab or peer was destroyed
            // Log a breadcrumb but do NOT send to Sentry.
            const { isExpected, reason } = classifyPeerError(err.message);

            if (isExpected) {
                Sentry.addBreadcrumb({
                    category: 'webrtc',
                    message: `Receiver: expected connection error — ${err.message}`,
                    level: 'warning',
                    data: { errorMessage: err.message },
                });
                setError('Could not connect. Ask the sender to enable "Network Relay" and try again.');
            } else {
                // Unexpected error — capture for investigation.
                Sentry.withScope((scope) => {
                    scope.setContext('webrtc', {
                        role: 'receiver',
                        connectionType,
                        filesReceived: receivedFilesRef.current.length,
                        progressPercent: progressRef.current,
                    });
                    Sentry.captureException(err);
                });
                setError(`Connection error: ${err.message}`);
            }
            // Track failed connection attempt
            track('transfer-failed', { reason, role: 'receiver' });
            setStatus('Connection failed');
        });

        const rx = createReceiver({
            send: (d) => peer.send(d),
            onFileStart: (index, total) => {
                setTransferSpeed('');
                setEstimatedTime('');
                setStatus(`Receiving file ${index} of ${total}`);
            },
            onProgress: (pct) => setProgress(pct),
            onSpeed: (bps, eta) => {
                setTransferSpeed(formatSpeed(bps));
                setEstimatedTime(formatETA(eta));
            },
            onSpeedReset: () => {
                setTransferSpeed('');
                setEstimatedTime('');
            },
            onFileComplete: (file) => {
                const url = URL.createObjectURL(file.blob);
                const newFile = {
                    id: uuidv4(),
                    fileName: file.fileName,
                    fileSize: file.fileSize,
                    downloadUrl: url,
                };
                setReceivedFiles((prev) => {
                    const updated = [...prev, newFile];
                    receivedFilesRef.current = updated;
                    return updated;
                });
                transferCompleteRef.current = true;
            },
            onAllComplete: (totalBytes, fileCount) => {
                track('transfer-received', {
                    files: fileCount,
                    bytes: totalBytes,
                    connection: connectionType ?? 'unknown',
                    role: 'receiver',
                });
                reportBytes(totalBytes);
            },
            onWaiting: () => setStatus('File received. Waiting for next file'),
            onError: (msg) => {
                setError(msg);
                setStatus('Transfer failed');
            },
        });
        peer.on('data', rx.handleMessage);
        peerRef.current = peer;
    };

    useEffect(() => {
        const roomFromUrl = getRoomFromUrl();

        if (roomFromUrl) {
            fetchIceServers().then(() => joinRoomAsReceiver(roomFromUrl));
        } else {
            fetchIceServers();
        }

        return () => {
            stopConnectionTypePolling();
            releaseWakeLock();
            peerRef.current?.destroy();
            receivedFilesRef.current.forEach((f) => URL.revokeObjectURL(f.downloadUrl));
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
            const room = getRoomFromUrl();
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
        const newRoomId = uuidv4();
        // A unique per-link nonce in the query string (not the fragment) makes
        // every transfer link a distinct document. Without it, two links differ
        // only in the fragment, which browsers treat as the same page, so a phone
        // that already has Floe open can reuse a stale tab when a new QR is
        // scanned instead of joining the new room. The secret room id stays in
        // the fragment (never sent to the server); the nonce carries no info.
        const nonce = uuidv4().slice(0, 8);
        const link = `${window.location.protocol}//${window.location.host}/?s=${nonce}#room=${newRoomId}`;
        setGeneratedLink(link);
        joinRoom(newRoomId);
        setStatus('Waiting for peer');

        onUserConnected((userId: string) => {
            if (peerRef.current && !peerRef.current.destroyed) {
                peerRef.current.destroy();
            }
            setStatus('Peer joined. Starting transfer');
            requestWakeLock();

            const iceConfig = filterIceServers(iceServersRef.current, relayEnabled);

            const peer = new SimplePeer({
                initiator: true,
                trickle: true,
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

                Sentry.addBreadcrumb({
                    category: 'webrtc',
                    message: 'Sender peer connected',
                    level: 'info',
                    data: { relayEnabled, filesCount: files.length, totalBytes },
                });

                setTimeout(async () => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const pc = (peer as any)._pc as RTCPeerConnection | undefined;
                    let isRelay = false;
                    if (pc) {
                        try {
                            const stats = await pc.getStats();
                            stats.forEach((report) => {
                                if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
                                    const lc = stats.get(report.localCandidateId);
                                    const rc = stats.get(report.remoteCandidateId);
                                    if (isRelayPair(lc?.candidateType, rc?.candidateType)) {
                                        isRelay = true;
                                    }
                                }
                            });
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
                        setError('Connection failed. Enable "Network Relay" to connect across restrictive networks.');
                        setStatus('Connection failed');
                        Sentry.addBreadcrumb({
                            category: 'transfer',
                            message: 'Transfer blocked: relay detected but relay fallback disabled by user',
                            level: 'warning',
                            data: { isRelay, relayEnabled },
                        });
                        peer.destroy();
                        return;
                    }

                    if (verdict.action === 'block-over-limit') {
                        setStatus('Transfer blocked. Relay limit exceeded.');
                        Sentry.addBreadcrumb({
                            category: 'transfer',
                            message: 'Transfer blocked: relay size limit exceeded',
                            level: 'warning',
                            data: { totalSize: verdict.totalSize, limitBytes: RELAY_SIZE_LIMIT },
                        });
                        return;
                    }

                    sendAllFiles(peer, files);
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
            });
            peer.on('error', (err) => {
                if (transferCompleteRef.current || progressRef.current > 0) {
                    setStatus('Connection interrupted');
                    return;
                }

                const { isExpected, reason } = classifyPeerError(err.message, { relayEnabled });

                if (isExpected) {
                    Sentry.addBreadcrumb({
                        category: 'webrtc',
                        message: `Sender: expected connection error — ${err.message}`,
                        level: 'warning',
                        data: { relayEnabled, errorMessage: err.message },
                    });
                    setError(
                        !relayEnabled
                            ? 'Connection failed. Enable "Network Relay" to connect across restrictive networks.'
                            : 'Connection lost. The other device may have closed the tab.'
                    );
                } else {
                    Sentry.withScope((scope) => {
                        scope.setContext('webrtc', {
                            role: 'sender',
                            relayEnabled,
                            connectionType,
                            filesCount: files.length,
                            totalBytes,
                            progressPercent: progressRef.current,
                        });
                        Sentry.captureException(err);
                    });
                    setError(`Connection error: ${err.message}`);
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

    const sendAllFiles = async (peer: PeerInstance, fileList: FileWithId[]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const channel = (peer as any)._channel as RTCDataChannel | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pc = (peer as any)._pc as RTCPeerConnection | undefined;

        if (!channel) return;

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
                onError: (msg) => {
                    setError(msg);
                    setStatus('Transfer failed');
                },
                onAllSent: () => {
                    setStatus('All Files Sent!');
                    setProgress(100);
                    transferCompleteRef.current = true;
                    releaseWakeLock();
                    track('transfer-complete', {
                        files: fileList.length,
                        bytes: fileList.reduce((s, f) => s + f.file.size, 0),
                        connection: connectionType ?? 'unknown',
                        role: 'sender',
                    });
                },
            }
        );
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
                    {error && error.includes('Link Expired') ? (
                        <div className="flex flex-col items-center justify-center py-8 text-center space-y-4">
                            <div className="h-16 w-16 rounded-full bg-red-500/10 flex items-center justify-center mb-2">
                                <ShieldCheck className="h-8 w-8 text-red-500" />
                            </div>
                            <div className="space-y-1">
                                <h3 className="text-xl font-semibold text-white">
                                    Link Invalid
                                </h3>
                                <p className="text-sm text-zinc-500 max-w-[260px] mx-auto">
                                    This link is either expired, already in use,
                                    or does not exist.
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
                            {error && !error.includes('Link Expired') && (
                                <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 flex items-start gap-3">
                                    <AlertCircle className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5" />
                                    <div className="flex-1 text-sm text-red-300">{error}</div>
                                    <button
                                        onClick={() => setError('')}
                                        className="text-red-400 hover:text-red-300"
                                    >
                                        <X className="h-4 w-4" />
                                    </button>
                                </div>
                            )}
                            {isSender && isRelayOverLimit && (
                                <div className="mt-2 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 flex items-start gap-3">
                                    <AlertTriangle className="h-4 w-4 text-amber-400 flex-shrink-0 mt-0.5" />
                                    <div className="flex-1 text-xs text-amber-300 leading-relaxed">
                                        Transfer limit exceeded. Relay connections are capped at 2 GB. Remove files to proceed, or switch to a network that supports a direct connection.{' '}
                                        <a href="/how-it-works" target="_blank" rel="noreferrer" className="underline underline-offset-2 text-amber-400 hover:text-white transition-colors">
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
                                    currentFileIndex={currentFileIndex}
                                    filesCount={files.length}
                                    transferSpeed={transferSpeed}
                                    estimatedTime={estimatedTime}
                                    progress={progress}
                                />
                            )}

                            {isSender && !generatedLink && files.length === 0 && (
                                <div
                                    onDragOver={handleDragOver}
                                    onDragLeave={handleDragLeave}
                                    onDrop={handleDrop}
                                    className={`group relative mt-2 flex flex-col items-center justify-center rounded-xl border border-dashed p-10 transition-all sm:p-14 ${isDragging
                                        ? 'border-ice bg-ice/[0.04]'
                                        : 'border-white/15 hover:border-ice/40 hover:bg-white/[0.02]'
                                        }`}
                                >
                                    <div className={`mb-4 flex h-12 w-12 items-center justify-center rounded-full border transition ${isDragging
                                        ? 'border-ice/60 bg-ice/10'
                                        : 'border-white/10 bg-white/[0.03] group-hover:border-ice/30'
                                        }`}>
                                        <UploadCloud className={`h-5 w-5 transition ${isDragging ? 'text-ice' : 'text-zinc-400 group-hover:text-zinc-200'
                                            }`} />
                                    </div>
                                    <p className="mb-1.5 text-sm font-medium text-zinc-200">
                                        {isDragging ? 'Release to add files' : 'Drop files or click to browse'}
                                    </p>
                                    <p className="font-mono text-[11px] text-zinc-500">
                                        {connectionType === 'relay'
                                            ? '2 GB limit over relay'
                                            : 'No size limit over direct connections'}
                                    </p>
                                    <Input
                                        type="file"
                                        multiple
                                        onChange={handleFileSelection}
                                        className="absolute inset-0 h-full w-full opacity-0 cursor-pointer"
                                    />
                                </div>
                            )}

                            {isSender && !generatedLink && files.length > 0 && (
                                <div
                                    onDragOver={handleDragOver}
                                    onDragLeave={handleDragLeave}
                                    onDrop={handleDrop}
                                    className={`group relative mt-2 flex items-center justify-center gap-2 rounded-lg border border-dashed py-3 transition-all ${isDragging
                                        ? 'border-ice bg-ice/[0.04]'
                                        : 'border-white/15 hover:border-ice/40 hover:bg-white/[0.02]'
                                        }`}
                                >
                                    <Plus className={`h-3.5 w-3.5 transition ${isDragging ? 'text-ice' : 'text-zinc-500 group-hover:text-zinc-300'}`} />
                                    <span className="text-xs font-medium text-zinc-400 transition group-hover:text-zinc-200">
                                        {isDragging ? 'Release to add files' : 'Add more files'}
                                    </span>
                                    <Input
                                        type="file"
                                        multiple
                                        onChange={handleFileSelection}
                                        className="absolute inset-0 h-full w-full opacity-0 cursor-pointer"
                                    />
                                </div>
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
                                            />
                                        )}

                                        {files.length > 0 && (
                                            <div className="mb-2 flex items-baseline justify-between px-0.5">
                                                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">
                                                    Files
                                                </span>
                                                <span className={`font-mono text-[10px] uppercase tracking-[0.2em] ${isRelayOverLimit ? 'text-amber-500' : 'text-zinc-600'
                                                    }`}>
                                                    {files.length} · {formatBytes(totalBytes)}{connectionType === 'relay' ? ' / 2.0 GB' : ''}
                                                </span>
                                            </div>
                                        )}

                                        <SelectedFilesList
                                            files={files}
                                            currentFileIndex={currentFileIndex}
                                            progress={progress}
                                            generatedLink={generatedLink}
                                            status={status}
                                            onDeleteFile={handleDeleteFile}
                                            listRef={fileListRef}
                                        />

                                        {files.length > 0 && !generatedLink && (
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
                                <div className="space-y-3 pt-2">
                                    {/* Handshake pipeline — shows what has happened and what comes next */}
                                    {receivedFiles.length === 0 &&
                                        !status.includes('Receiving') && (
                                            <div className="space-y-3 px-1 py-3">
                                                <div className={`flex items-center gap-2.5 text-sm ${isConnected ? 'text-zinc-400' : 'text-zinc-200'}`}>
                                                    {isConnected ? (
                                                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />
                                                    ) : (
                                                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-400" />
                                                    )}
                                                    Secure room joined
                                                </div>
                                                <div className={`flex items-center gap-2.5 text-sm ${isConnected ? 'text-zinc-200' : 'text-zinc-600'}`}>
                                                    {isConnected ? (
                                                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-400" />
                                                    ) : (
                                                        <Circle className="h-3.5 w-3.5 shrink-0 text-zinc-700" />
                                                    )}
                                                    Waiting for the sender to start
                                                </div>
                                                <div className="flex items-center gap-2.5 text-sm text-zinc-600">
                                                    <Circle className="h-3.5 w-3.5 shrink-0 text-zinc-700" />
                                                    Files stream in below
                                                </div>
                                            </div>
                                        )}

                                    {/* Contribute to global stats toggle — visible while waiting, before any file arrives */}
                                    {receivedFiles.length === 0 && (
                                        <StatsContributionToggle enabled={reportStatsEnabled} onChange={setReportStatsEnabled} />
                                    )}


                                    {receivedFiles.length > 1 &&
                                        !status.includes('Receiving') && (
                                            <div className="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-2 gap-2 mb-3 animate-in fade-in slide-in-from-top-2 duration-300">
                                                <Button
                                                    onClick={handleDownloadAll}
                                                    disabled={isDownloading || isZipping}
                                                    className="w-full bg-white text-black hover:bg-zinc-200 font-medium transition-colors border-none"
                                                >
                                                    {isDownloading ? (
                                                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                                    ) : (
                                                        <Download className="w-4 h-4 mr-2" />
                                                    )}
                                                    {isDownloading ? 'Downloading...' : 'Download All'}
                                                </Button>
                                                <Button
                                                    onClick={handleDownloadZip}
                                                    disabled={isZipping || isDownloading}
                                                    className="w-full bg-zinc-800 text-white hover:bg-zinc-700 font-medium transition-colors border border-zinc-700"
                                                >
                                                    {isZipping ? (
                                                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                                    ) : (
                                                        <FileArchive className="w-4 h-4 mr-2" />
                                                    )}
                                                    {isZipping
                                                        ? 'Zipping...'
                                                        : 'Download ZIP'}
                                                </Button>
                                            </div>
                                        )}

                                    {(isZipping || isDownloading) && downloadProgress.total > 0 && (
                                        <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700 space-y-2">
                                            <div className="flex items-center justify-between text-xs">
                                                <span className="text-zinc-400 truncate max-w-[120px] sm:max-w-[180px]">
                                                    {downloadProgress.label}
                                                </span>
                                                <span className="text-white font-mono">
                                                    {downloadProgress.current}/{downloadProgress.total}
                                                </span>
                                            </div>
                                            <div className="bg-white/20 relative h-2 w-full overflow-hidden rounded-full">
                                                <div
                                                    className="bg-white h-full transition-all"
                                                    style={{ width: `${(downloadProgress.current / downloadProgress.total) * 100}%` }}
                                                />
                                            </div>
                                            <div className="text-xs text-zinc-500 text-center">
                                                {Math.round((downloadProgress.current / downloadProgress.total) * 100)}% complete
                                            </div>
                                        </div>
                                    )}
                                    <ReceivedFilesList receivedFiles={receivedFiles} listRef={fileListRef} />

                                    {receivedFiles.length > 0 && (
                                        <div className="pt-1 pb-0.5 px-0.5">
                                            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">
                                                {receivedFiles.length} {receivedFiles.length === 1 ? 'file' : 'files'} ({formatBytes(receivedFiles.reduce((s, f) => s + f.fileSize, 0))})
                                            </span>
                                        </div>
                                    )}

                                    {typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent) && receivedFiles.length > 0 && (
                                        <p className="text-[10px] text-zinc-600 text-center mt-1">Tip: Use &quot;Download ZIP&quot; for the best experience on iOS.</p>
                                    )}

                                    {status.includes('Receiving') ? (
                                        <div className="flex w-full items-center justify-center gap-2 text-xs text-zinc-400 animate-pulse pt-2">
                                            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                                            <span className="truncate max-w-[200px] sm:max-w-[280px]">
                                                {status}
                                            </span>
                                        </div>
                                    ) : receivedFiles.length > 0 && (
                                        <div className="flex w-full items-center justify-center gap-2 text-xs text-zinc-400 pt-2">
                                            <CheckCircle2 className="h-3 w-3 shrink-0 text-green-500" />
                                            <span>
                                                {receivedFiles.length} {receivedFiles.length === 1 ? 'file' : 'files'} received
                                            </span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    )}
                </CardContent>

                <CardFooter className="justify-center border-t border-white/[0.06] !pt-4">
                    {isSender && !generatedLink ? (
                        <p className="text-[10px] uppercase tracking-wide text-zinc-500 text-center leading-relaxed">
                            End-to-end encrypted. Files are never stored on a server.
                        </p>
                    ) : (
                        <p className="text-[10px] uppercase tracking-wide text-amber-300/80 text-center leading-relaxed">
                            Keep this tab open. Closing it{' '}
                            {isSender ? 'cancels the transfer' : 'interrupts the download'}.
                        </p>
                    )}
                </CardFooter>
            </Card>
        </main>
    );
}
