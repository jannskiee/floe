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
import { RELAY_SIZE_LIMIT, filterIceServers, evaluateRelayGate } from '@/lib/relay';
import { classifyPeerError } from '@/lib/peerErrors';

import { QRCodeSVG } from 'qrcode.react';

import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
    AlertCircle,
    AlertTriangle,
    ArrowRight,
    Check,
    CheckCircle2,
    Copy,
    Download,
    Infinity,
    Loader2,
    QrCode,
    Radio,
    Share2,
    ShieldCheck,
    UploadCloud,
    FileArchive,
    X,
} from 'lucide-react';
import { formatBytes } from '@/lib/utils';
import { FileIcon } from '@/components/FileIcon';
import { ConnectionStatusBadge } from '@/components/ConnectionStatusBadge';
import { RelayFallbackToggle } from '@/components/RelayFallbackToggle';
import { StatsContributionToggle } from '@/components/StatsContributionToggle';

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
        const link = `${window.location.protocol}//${window.location.host}/#room=${newRoomId}`;
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
                                    if ((lc && lc.candidateType === 'relay') || (rc && rc.candidateType === 'relay')) {
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
                <Card className="w-full max-w-md border-zinc-800 bg-zinc-900/50 shadow-2xl backdrop-blur-xl ring-1 ring-white/5 overflow-visible">
                    <CardContent className="flex items-center justify-center py-16">
                        <Loader2 className="w-8 h-8 animate-spin text-zinc-500" />
                    </CardContent>
                </Card>
            </main>
        );
    }

    return (
        <main className="w-full flex justify-center z-10 relative">
            <Card className="w-full max-w-md border-zinc-800 bg-zinc-900/50 shadow-2xl backdrop-blur-xl ring-1 ring-white/5 overflow-visible">
                <CardHeader className="text-center pb-0">
                    <CardTitle className="text-xl font-semibold text-white flex items-center justify-center gap-2">
                        {isSender ? (
                            <>
                                {' '}
                                <Radio className="w-5 h-5 text-white" /> Start
                                Sharing{' '}
                            </>
                        ) : (
                            <>
                                {' '}
                                <Download className="w-5 h-5 text-white" />{' '}
                                Receive Files{' '}
                            </>
                        )}
                    </CardTitle>
                    <CardDescription className="text-zinc-500">
                        {isSender
                            ? 'Send files to anyone, anywhere, securely.'
                            : 'Secure, direct connection established.'}
                    </CardDescription>
                </CardHeader>

                <CardContent className="space-y-4 pt-0">
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
                            <ConnectionStatusBadge
                                isSender={isSender}
                                isConnected={isConnected}
                                ping={ping}
                                connectionType={connectionType}
                                progress={progress}
                            />

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
                                <div className="space-y-2">
                                    <div className="flex justify-between text-xs text-zinc-400 font-mono">
                                        <span>
                                            {isSender
                                                ? status === 'All Files Sent!'
                                                    ? `Upload Complete (${files.length} ${files.length === 1 ? 'File' : 'Files'})`
                                                    : `Sending File ${currentFileIndex + 1} of ${files.length}...`
                                                : status.includes('Receiving')
                                                    ? status
                                                    : 'Receiving...'}
                                        </span>
                                        <span className="flex items-center gap-2">
                                            {transferSpeed && estimatedTime && progress < 100 && (
                                                <span className="text-zinc-500">
                                                    {transferSpeed} • {estimatedTime}
                                                </span>
                                            )}
                                            <span>{progress}%</span>
                                        </span>
                                    </div>
                                    <Progress
                                        value={progress}
                                        className="h-1 bg-zinc-800 [&>div]:bg-zinc-200"
                                    />
                                </div>
                            )}

                            {isSender && !generatedLink && (
                                <div
                                    onDragOver={handleDragOver}
                                    onDragLeave={handleDragLeave}
                                    onDrop={handleDrop}
                                    className={`group relative mt-2 flex flex-col items-center justify-center rounded-xl border-2 border-dashed bg-zinc-900/50 p-10 transition-all ${isDragging
                                        ? 'border-white bg-zinc-800/80'
                                        : 'border-zinc-700 hover:border-white/50 hover:bg-zinc-800'
                                        }`}
                                >
                                    <div className={`mb-4 rounded-full p-4 transition ${isDragging ? 'bg-white/20' : 'bg-zinc-800 group-hover:bg-zinc-700'
                                        }`}>
                                        <UploadCloud className={`h-8 w-8 transition ${isDragging ? 'text-white' : 'text-zinc-400 group-hover:text-white'
                                            }`} />
                                    </div>
                                    <p className="mb-2 text-sm font-medium text-zinc-200">
                                        {isDragging ? 'Drop files here!' : 'Click or Drag files here'}
                                    </p>
                                    <p className="flex items-center gap-1 text-xs text-zinc-500">
                                        {connectionType === 'relay'
                                            ? 'Max size: 2 GB (relay)'
                                            : <>Max size: Unlimited{' '}<Infinity className="w-3 h-3" strokeWidth={1.5} /></>
                                        }
                                    </p>
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
                                        {files.length > 0 && !generatedLink && (
                                            <>
                                                <RelayFallbackToggle relayEnabled={relayEnabled} onChange={setRelayEnabled} />

                                                <Button
                                                    onClick={handleCreateLink}
                                                    className="w-full mb-4 bg-white text-black hover:bg-zinc-200 font-bold text-xs sm:text-sm"
                                                >
                                                    Create Secure Link &amp; Share ({files.length} {files.length === 1 ? 'File' : 'Files'})
                                                    <ArrowRight className="w-3.5 h-3.5 sm:w-4 sm:h-4 ml-1.5 sm:ml-2 shrink-0" />
                                                </Button>
                                            </>
                                        )}


                                        {generatedLink && (
                                            <div className="rounded-lg bg-black/40 p-4 border border-zinc-800 mb-4">
                                                <div className="group">
                                                    <p className="text-[10px] uppercase text-zinc-500 mb-1 font-bold tracking-wider">
                                                        Share Link
                                                    </p>
                                                    <div>
                                                        <code className="block break-all rounded bg-zinc-950 p-3 text-xs text-zinc-300 font-mono border border-zinc-800 group-hover:border-zinc-600 transition leading-relaxed">
                                                            {generatedLink}
                                                        </code>
                                                        <div className="flex items-center justify-center gap-2 mt-2.5">
                                                            <button
                                                                onClick={handleCopy}
                                                                className="w-20 inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-zinc-800/80 hover:bg-zinc-700 border border-zinc-700 text-zinc-400 hover:text-white text-xs font-medium transition-all"
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
                                                                onClick={() => setShowQr((v) => !v)}
                                                                className={`w-24 inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md border text-xs font-medium transition-all ${showQr
                                                                        ? 'bg-zinc-700 border-zinc-600 text-white'
                                                                        : 'bg-zinc-800/80 hover:bg-zinc-700 border-zinc-700 text-zinc-400 hover:text-white'
                                                                    }`}
                                                                aria-label="Toggle QR code"
                                                            >
                                                                <QrCode className="h-3.5 w-3.5" />
                                                                {showQr ? 'Hide QR' : 'Show QR'}
                                                            </button>
                                                            {typeof navigator !== 'undefined' && !!navigator.share && (
                                                                <button
                                                                    onClick={handleShare}
                                                                    className="w-20 inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-zinc-800/80 hover:bg-zinc-700 border border-zinc-700 text-zinc-400 hover:text-white text-xs font-medium transition-all"
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
                                                        <p className="text-[10px] uppercase tracking-widest text-zinc-600 font-bold">Scan to receive files</p>
                                                    </div>
                                                )}

                                                <div className="mt-3 flex w-full items-center justify-center gap-2 text-xs transition-colors duration-300">
                                                    {status === 'All Files Sent!' || status.includes('Transfer complete') ? (
                                                        <CheckCircle2 className="h-3 w-3 shrink-0 text-green-400" />
                                                    ) : (
                                                        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-zinc-500" />
                                                    )}
                                                    <span
                                                        className={`truncate max-w-[200px] sm:max-w-[280px] ${status === 'All Files Sent!' || status.includes('Transfer complete') ? 'text-green-400 font-medium' : 'text-zinc-500'}`}
                                                    >
                                                        {status}
                                                    </span>
                                                </div>
                                            </div>
                                        )}

                                        <div
                                            ref={fileListRef}
                                            className="space-y-3 max-h-[300px] overflow-y-auto pr-1 pb-12 custom-scrollbar"
                                        >
                                            {files.map((item, i) => (
                                                <div
                                                    key={i}
                                                    className="flex items-center gap-3 bg-zinc-900/30 p-2 rounded-lg border border-white/5"
                                                >
                                                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-800/50 ring-1 ring-inset ring-white/10">
                                                        <FileIcon
                                                            fileName={
                                                                item.file.name
                                                            }
                                                        />
                                                    </div>
                                                    <div className="flex flex-col min-w-0 relative">
                                                        <span
                                                            className={`peer text-sm font-medium truncate cursor-help transition-colors ${i === currentFileIndex && progress > 0 && progress < 100 ? 'text-white' : 'text-zinc-400'}`}
                                                        >
                                                            {item.file.name}
                                                        </span>
                                                        <div className="absolute top-full left-0 mt-1 opacity-0 peer-hover:opacity-100 z-[9999] w-max max-w-[240px] px-3 py-2 text-xs font-medium text-white bg-zinc-950 rounded-lg border border-zinc-800 shadow-2xl break-all pointer-events-none">
                                                            {item.file.name}
                                                            <div className="absolute bottom-full left-4 h-0 w-0 border-l-[7px] border-r-[7px] border-b-[7px] border-l-transparent border-r-transparent border-b-zinc-800"></div>
                                                            <div className="absolute bottom-full left-[17px] mt-[1px] h-0 w-0 border-l-[6px] border-r-[6px] border-b-[6px] border-l-transparent border-r-transparent border-b-zinc-950"></div>
                                                        </div>
                                                        <span className="text-xs text-zinc-500 font-mono">
                                                            {formatBytes(
                                                                item.file.size
                                                            )}
                                                        </span>
                                                    </div>
                                                    <div className="ml-auto flex items-center gap-2">
                                                        {!generatedLink ? (
                                                            <button
                                                                onClick={() => handleDeleteFile(item.id)}
                                                                className="p-1.5 rounded-md hover:bg-red-500/20 text-zinc-500 hover:text-red-400 transition-all"
                                                            >
                                                                <X className="h-4 w-4" strokeWidth={3} />
                                                            </button>
                                                        ) : i <
                                                            currentFileIndex ||
                                                            status ===
                                                            'All Files Sent!' ? (
                                                            <CheckCircle2 className="h-4 w-4 text-green-500" />
                                                        ) : i ===
                                                            currentFileIndex &&
                                                            progress > 0 ? (
                                                            <Loader2 className="h-4 w-4 animate-spin text-white" />
                                                        ) : null}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>

                                        {/* Total file size indicator */}
                                        {files.length > 0 && (
                                            <div className="pt-1 pb-0.5 px-0.5">
                                                <span className={`text-[10px] uppercase font-bold tracking-widest font-mono ${isRelayOverLimit ? 'text-amber-500' : 'text-zinc-600'
                                                    }`}>
                                                    {files.length} {files.length === 1 ? 'file' : 'files'} ({formatBytes(totalBytes)}{connectionType === 'relay' ? ' / 2.0 GB' : ''})
                                                </span>
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
                                    {/* Contribute to global stats toggle — visible while waiting, before any file arrives */}
                                    {receivedFiles.length === 0 && (
                                        <StatsContributionToggle enabled={reportStatsEnabled} onChange={setReportStatsEnabled} />
                                    )}

                                    {receivedFiles.length === 0 &&
                                        !status.includes('Receiving') && (
                                            <div className="text-center text-sm text-zinc-500 py-8">
                                                Waiting for sender...
                                            </div>
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
                                    <div
                                        ref={fileListRef}
                                        className="space-y-3 max-h-[300px] overflow-y-auto pr-1 custom-scrollbar"
                                    >
                                        {receivedFiles.map((file) => (
                                            <div
                                                key={file.id}
                                                className="relative group/fname flex items-center justify-between rounded-lg bg-zinc-900 p-3 border border-zinc-800"
                                            >
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-500/10 text-green-500">
                                                        <CheckCircle2 className="h-5 w-5" />
                                                    </div>
                                                    <div className="flex flex-col min-w-0 relative">
                                                        <span className="text-sm font-medium text-white truncate max-w-[140px] sm:max-w-[250px] cursor-help">
                                                            {file.fileName}
                                                        </span>
                                                        <div className="absolute top-full left-0 mt-1 opacity-0 group-hover/fname:opacity-100 z-[9999] w-max max-w-[240px] px-3 py-2 text-xs font-medium text-white bg-zinc-950 rounded-lg border border-zinc-800 shadow-2xl break-all pointer-events-none">
                                                            {file.fileName}
                                                            <div className="absolute bottom-full left-4 h-0 w-0 border-l-[7px] border-r-[7px] border-b-[7px] border-l-transparent border-r-transparent border-b-zinc-800"></div>
                                                            <div className="absolute bottom-full left-[17px] mt-[1px] h-0 w-0 border-l-[6px] border-r-[6px] border-b-[6px] border-l-transparent border-r-transparent border-b-zinc-950"></div>
                                                        </div>
                                                        <span className="text-xs text-zinc-500">
                                                            {formatBytes(
                                                                file.fileSize
                                                            )}
                                                        </span>
                                                    </div>
                                                </div>
                                                <Button
                                                    asChild
                                                    size="sm"
                                                    className="bg-white text-black hover:bg-zinc-200 shrink-0"
                                                >
                                                    <a
                                                        href={file.downloadUrl}
                                                        download={file.fileName}
                                                    >
                                                        <Download className="h-4 w-4" />
                                                    </a>
                                                </Button>
                                            </div>
                                        ))}
                                    </div>

                                    {receivedFiles.length > 0 && (
                                        <div className="pt-1 pb-0.5 px-0.5">
                                            <span className="text-[10px] uppercase font-bold tracking-widest font-mono text-zinc-600">
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

                <CardFooter className="flex-col justify-center border-t border-white/5 py-4 gap-2">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-wide text-center leading-relaxed">
                        {isSender
                            ? 'Do not close this tab. Closing it will cancel the transfer.'
                            : 'Do not close this tab. Closing it will interrupt the download.'}
                    </p>
                </CardFooter>
            </Card>
        </main>
    );
}
