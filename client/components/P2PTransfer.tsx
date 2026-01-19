'use client';

import 'buffer';

if (typeof window !== 'undefined') {
    if (!(window as any).global) (window as any).global = window;
    if (!(window as any).process) (window as any).process = { env: {} };
}

import React, { useEffect, useRef, useState } from 'react';
import io, { Socket } from 'socket.io-client';
import SimplePeer, { Instance as PeerInstance } from 'simple-peer';
import { v4 as uuidv4 } from 'uuid';
import { zip, Zippable } from 'fflate';

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
    ArrowRight,
    Check,
    CheckCircle2,
    Copy,
    Download,
    Infinity,
    Loader2,
    Radio,
    ShieldCheck,
    UploadCloud,
    Wifi,
    FileArchive,
    X,
} from 'lucide-react';
import { formatBytes } from '@/lib/utils';
import { FileIcon } from '@/components/FileIcon';

const socket: Socket = io(
    process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:3001'
);

interface FileWithId {
    id: string;
    file: File;
}

interface ReceivedFile {
    id: string;
    fileName: string;
    fileSize: number;
    downloadUrl: string;
}



export function P2PTransfer() {
    const [isSender, setIsSender] = useState<boolean | null>(null);
    const [status, setStatus] = useState('Idle');
    const [isConnected, setIsConnected] = useState(false);
    const [ping, setPing] = useState(0);
    const [generatedLink, setGeneratedLink] = useState('');
    const [files, setFiles] = useState<FileWithId[]>([]);
    const [currentFileIndex, setCurrentFileIndex] = useState(0);
    const [progress, setProgress] = useState(0);
    const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
    const [copied, setCopied] = useState(false);
    const [isZipping, setIsZipping] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState({ current: 0, total: 0, label: '' });
    const [isDownloading, setIsDownloading] = useState(false);
    const [error, setErrorInternal] = useState('');

    // Debug wrapper to trace all setError calls
    const setError = (msg: string) => {
        if (msg) {
            console.log('[DEBUG] setError called with:', msg);
            console.log('[DEBUG] Stack trace:', new Error().stack);
        }
        setErrorInternal(msg);
    };
    const [transferSpeed, setTransferSpeed] = useState('');
    const [estimatedTime, setEstimatedTime] = useState('');
    const [isDragging, setIsDragging] = useState(false);

    const peerRef = useRef<PeerInstance | null>(null);
    const wakeLockRef = useRef<WakeLockSentinel | null>(null);
    const hasJoinedRef = useRef(false);
    const receivedFilesRef = useRef<ReceivedFile[]>([]);
    const transferCompleteRef = useRef(false);
    const progressRef = useRef(0);
    const partialDownloads = useRef<
        Map<string, { chunks: ArrayBuffer[]; received: number }>
    >(new Map());
    const fileListRef = useRef<HTMLDivElement>(null);
    const chunkSizeRef = useRef(160 * 1024);
    const iceServersRef = useRef<RTCIceServer[]>([
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ]);

    const fetchIceServers = async () => {
        try {
            const response = await fetch(
                `https://${process.env.NEXT_PUBLIC_METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${process.env.NEXT_PUBLIC_METERED_API_KEY}`
            );
            const iceServers = await response.json();
            if (Array.isArray(iceServers) && iceServers.length > 0) {
                iceServersRef.current = iceServers;
            }
        } catch (err) {
            console.warn('Failed to fetch TURN servers, using fallback STUN:', err);
        }
    };

    const requestWakeLock = async () => {
        if ('wakeLock' in navigator) {
            if (document.visibilityState === 'visible') {
                try {
                    wakeLockRef.current =
                        await navigator.wakeLock.request('screen');
                } catch (err) {
                    console.error('Wake Lock failed', err);
                }
            }
        }
    };

    const releaseWakeLock = () => {
        if (wakeLockRef.current) {
            wakeLockRef.current.release().catch(() => { });
            wakeLockRef.current = null;
        }
    };

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

    const handleDownloadAll = async () => {
        setIsDownloading(true);
        setDownloadProgress({ current: 0, total: receivedFiles.length, label: 'Starting download...' });

        for (let i = 0; i < receivedFiles.length; i++) {
            const file = receivedFiles[i];
            setDownloadProgress({
                current: i + 1,
                total: receivedFiles.length,
                label: `Downloading: ${file.fileName}`
            });

            const link = document.createElement('a');
            link.href = file.downloadUrl;
            link.download = file.fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            // Wait between downloads to avoid browser blocking
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        setIsDownloading(false);
        setDownloadProgress({ current: 0, total: 0, label: '' });
    };

    const handleDownloadZip = async () => {
        console.log('[DEBUG] ZIP download clicked', {
            receivedFilesCount: receivedFiles.length,
            receivedFilesRefCount: receivedFilesRef.current.length,
            transferComplete: transferCompleteRef.current,
            socketConnected: socket.connected,
            error: error
        });

        if (receivedFiles.length === 0) return;

        setIsZipping(true);
        setError('');
        setDownloadProgress({ current: 0, total: receivedFiles.length, label: 'Preparing files...' });

        try {
            const filesToZip: Zippable = {};
            const usedNames = new Set<string>();
            let failedCount = 0;

            for (let i = 0; i < receivedFiles.length; i++) {
                const file = receivedFiles[i];
                setDownloadProgress({
                    current: i + 1,
                    total: receivedFiles.length,
                    label: `Processing: ${file.fileName}`
                });

                try {
                    const response = await fetch(file.downloadUrl);
                    if (!response.ok) throw new Error('Fetch failed');
                    const blob = await response.blob();
                    const arrayBuffer = await blob.arrayBuffer();

                    let finalName = file.fileName;
                    let counter = 1;

                    while (usedNames.has(finalName)) {
                        const dotIndex = file.fileName.lastIndexOf('.');
                        if (dotIndex === -1) {
                            finalName = `${file.fileName} (${counter})`;
                        } else {
                            const base = file.fileName.substring(0, dotIndex);
                            const ext = file.fileName.substring(dotIndex);
                            finalName = `${base} (${counter})${ext}`;
                        }
                        counter++;
                    }

                    usedNames.add(finalName);
                    filesToZip[finalName] = new Uint8Array(arrayBuffer);
                } catch {
                    failedCount++;
                }
            }

            if (Object.keys(filesToZip).length === 0) {
                setError('Could not prepare files for ZIP. Try "Download All" instead.');
                setIsZipping(false);
                setDownloadProgress({ current: 0, total: 0, label: '' });
                return;
            }

            setDownloadProgress({ current: receivedFiles.length, total: receivedFiles.length, label: 'Creating ZIP archive...' });

            zip(filesToZip, (err, data) => {
                if (err) {
                    setError('ZIP creation failed. Try "Download All" instead.');
                    setIsZipping(false);
                    setDownloadProgress({ current: 0, total: 0, label: '' });
                    return;
                }
                const blob = new Blob([data as unknown as BlobPart], { type: 'application/zip' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `floe_transfer_${new Date().getTime()}.zip`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
                setIsZipping(false);
                setDownloadProgress({ current: 0, total: 0, label: '' });
                if (failedCount > 0) {
                    setError(`${failedCount} file(s) could not be included in ZIP.`);
                }
            });
        } catch (error) {
            setError('ZIP creation failed. Try "Download All" instead.');
            setIsZipping(false);
            setDownloadProgress({ current: 0, total: 0, label: '' });
        }
    };

    const handleCopy = () => {
        navigator.clipboard.writeText(generatedLink);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const joinRoomAsReceiver = (roomId: string) => {
        // Prevent duplicate joins
        if (hasJoinedRef.current) return;
        hasJoinedRef.current = true;

        setStatus('Connecting...');

        // Remove any existing room-full listener to prevent duplicates
        socket.off('room-full');

        socket.emit('join-room', roomId);

        socket.on('room-full', () => {
            console.log('[DEBUG] room-full event received', {
                receivedFilesCount: receivedFilesRef.current.length,
                transferComplete: transferCompleteRef.current,
                isSender: !new URLSearchParams(window.location.search).get('room')
            });
            // Use ref to check current value, not stale closure value
            if (receivedFilesRef.current.length > 0 || transferCompleteRef.current) {
                console.log('[DEBUG] room-full: Files exist, showing Transfer complete');
                setStatus('Transfer complete');
                return;
            }
            console.log('[DEBUG] room-full: Setting Link Expired error');
            setError('Link Expired or Busy');
            setStatus('Access Denied');
        });

        const peer = new SimplePeer({
            initiator: false,
            trickle: true,
            config: {
                iceServers: iceServersRef.current,
            },
        });

        peer.on('signal', (signal) =>
            socket.emit('signal', { target: null, roomId, signal })
        );
        peer.on('connect', () => {
            setIsConnected(true);
            requestWakeLock();
        });
        peer.on('close', () => {
            // Don't set isConnected false - that's for socket connection, not peer
            releaseWakeLock();
        });
        peer.on('error', (err) => {
            console.log('[DEBUG] Receiver peer error:', err.message, {
                receivedFilesCount: receivedFilesRef.current.length,
                transferComplete: transferCompleteRef.current
            });
            // Don't show Link Invalid if files have been received
            if (receivedFilesRef.current.length > 0 || transferCompleteRef.current) {
                console.log('[DEBUG] Receiver peer error: Files exist, showing interrupted');
                setStatus('Connection interrupted');
                return;
            }
            console.log('[DEBUG] Receiver peer error: Setting Connection error');
            setError(`Connection error: ${err.message}`);
            setStatus('Connection failed');
        });

        let currentMetadata: any = {};

        let receiveSpeedStart = performance.now();
        let receiveSpeedBytes = 0;
        let lastReceiveSpeedUpdate = 0;

        peer.on('data', (data) => {
            const isFileChunk = data.byteLength > 1000;

            if (!isFileChunk) {
                try {
                    const text = new TextDecoder().decode(data);
                    if (text.startsWith('{')) {
                        const msg = JSON.parse(text);

                        if (msg.type === 'metadata') {
                            currentMetadata = msg;
                            receiveSpeedStart = performance.now();
                            receiveSpeedBytes = 0;
                            lastReceiveSpeedUpdate = 0;
                            setTransferSpeed('');
                            setEstimatedTime('');
                            setStatus(
                                `Receiving file ${msg.index} of ${msg.total}...`
                            );

                            let offset = 0;
                            const existing = partialDownloads.current.get(
                                msg.id
                            );
                            if (existing) {
                                offset = existing.received;
                            } else {
                                partialDownloads.current.set(msg.id, {
                                    chunks: [],
                                    received: 0,
                                });
                            }
                            peer.send(
                                JSON.stringify({
                                    type: 'ack',
                                    id: msg.id,
                                    offset: offset,
                                })
                            );
                        } else if (msg.type === 'end') {
                            const fileData = partialDownloads.current.get(
                                currentMetadata.id
                            );
                            if (fileData) {
                                const blob = new Blob(fileData.chunks);
                                const url = URL.createObjectURL(blob);

                                const newFile = {
                                    id: uuidv4(),
                                    fileName: currentMetadata.fileName,
                                    fileSize: fileData.received,
                                    downloadUrl: url,
                                };

                                setReceivedFiles((prev) => {
                                    const updated = [...prev, newFile];
                                    receivedFilesRef.current = updated;
                                    return updated;
                                });
                                transferCompleteRef.current = true;
                                partialDownloads.current.delete(
                                    currentMetadata.id
                                );
                            }
                            setStatus('File Received. Waiting for next...');
                            setProgress(0);
                            setTransferSpeed('');
                            setEstimatedTime('');
                        }
                        return;
                    }
                } catch (e) { }
            }

            const fileData = partialDownloads.current.get(currentMetadata.id);
            if (fileData) {
                fileData.chunks.push(data);
                fileData.received += data.byteLength;
                receiveSpeedBytes += data.byteLength;

                const now = performance.now();
                if (now - lastReceiveSpeedUpdate > 1000) {
                    const elapsed = (now - receiveSpeedStart) / 1000;
                    if (elapsed > 0 && currentMetadata.fileSize) {
                        const bytesPerSec = receiveSpeedBytes / elapsed;
                        const remaining = currentMetadata.fileSize - fileData.received;
                        const etaSeconds = remaining / bytesPerSec;

                        const speedFormatted = bytesPerSec >= 1024 * 1024
                            ? `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`
                            : `${(bytesPerSec / 1024).toFixed(1)} KB/s`;

                        let etaFormatted = '';
                        if (etaSeconds < 60) {
                            etaFormatted = `${Math.ceil(etaSeconds)}s`;
                        } else if (etaSeconds < 3600) {
                            etaFormatted = `${Math.floor(etaSeconds / 60)}m ${Math.ceil(etaSeconds % 60)}s`;
                        } else {
                            etaFormatted = `${Math.floor(etaSeconds / 3600)}h ${Math.floor((etaSeconds % 3600) / 60)}m`;
                        }

                        setTransferSpeed(speedFormatted);
                        setEstimatedTime(etaFormatted);
                    }

                    receiveSpeedStart = now;
                    receiveSpeedBytes = 0;
                    lastReceiveSpeedUpdate = now;
                }

                if (
                    currentMetadata.fileSize &&
                    (fileData.received % (160 * 1024 * 10) === 0 ||
                        fileData.received === currentMetadata.fileSize)
                ) {
                    setProgress(
                        Math.round(
                            (fileData.received / currentMetadata.fileSize) * 100
                        )
                    );
                }
            }
        });
        peerRef.current = peer;
    };

    useEffect(() => {
        // Determine sender/receiver immediately (fast)
        const params = new URLSearchParams(window.location.search);
        const roomFromUrl = params.get('room');

        if (roomFromUrl) {
            setIsSender(false);
            // Fetch ICE servers then join room
            fetchIceServers().then(() => joinRoomAsReceiver(roomFromUrl));
        } else {
            setIsSender(true);
            // Fetch ICE servers in background for when sender creates link
            fetchIceServers();
        }

        if (socket.connected) queueMicrotask(() => setIsConnected(true));
        socket.on('connect', () => {
            console.log('[DEBUG] Socket connected');
            setIsConnected(true);
        });
        socket.on('disconnect', (reason) => {
            console.log('[DEBUG] Socket disconnected, reason:', reason, {
                receivedFilesCount: receivedFilesRef.current.length,
                transferComplete: transferCompleteRef.current
            });
            setIsConnected(false);
            setPing(0);
            // Use refs to check current value, not stale closure
            if (receivedFilesRef.current.length > 0 || transferCompleteRef.current) {
                setStatus('Transfer complete (disconnected)');
            }
        });

        const pingInterval = setInterval(() => {
            const start = performance.now();
            socket.emit('ping', () => {
                const duration = performance.now() - start;
                setPing(Number(duration.toFixed(2)));
            });
        }, 2000);

        socket.on('signal', (data: any) => {
            if (peerRef.current && !peerRef.current.destroyed) {
                peerRef.current.signal(data.signal);
            }
        });

        socket.on('peer-disconnected', () => {
            // Use refs to check current value, not stale closure
            if (receivedFilesRef.current.length > 0 || transferCompleteRef.current) {
                setStatus('Transfer complete');
            } else {
                setStatus('Peer disconnected. Waiting for reconnection...');
            }
            // Don't set isConnected false - that's for socket connection, not peer
            if (peerRef.current) peerRef.current.destroy();
            releaseWakeLock();
        });

        return () => {
            clearInterval(pingInterval);
            socket.off('signal');
            socket.off('user-connected');
            socket.off('connect');
            socket.off('disconnect');
            socket.off('room-full');
            socket.off('peer-disconnected');
            releaseWakeLock();
            peerRef.current?.destroy();
        };
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
    }, [isConnected]);

    const handleFileSelection = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            const newFilesRaw = Array.from(e.target.files);
            const newFiles = newFilesRaw.map((f) => ({
                id: uuidv4(),
                file: f,
            }));
            setFiles((prev) => [...prev, ...newFiles]);
            e.target.value = '';
        }
    };

    const handleDeleteFile = (fileId: string) => {
        setFiles((prev) => prev.filter((f) => f.id !== fileId));
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const droppedFiles = Array.from(e.dataTransfer.files).map((f) => ({
                id: uuidv4(),
                file: f,
            }));
            setFiles((prev) => [...prev, ...droppedFiles]);
        }
    };

    const handleCreateLink = () => {
        const newRoomId = uuidv4();
        const link = `${window.location.protocol}//${window.location.host}?room=${newRoomId}`;
        setGeneratedLink(link);
        socket.emit('join-room', newRoomId);
        setStatus('Waiting for peer...');

        socket.on('user-connected', (userId: string) => {
            setStatus('Peer joined! Starting...');
            requestWakeLock();

            const peer = new SimplePeer({
                initiator: true,
                trickle: true,
                config: {
                    iceServers: iceServersRef.current,
                },
            });

            peer.on('signal', (signal) =>
                socket.emit('signal', { target: userId, signal })
            );
            peer.on('connect', () => {
                setIsConnected(true);
                sendAllFiles(peer, files);
            });
            peer.on('close', () => {
                // Don't set isConnected false - that's for socket connection, not peer
                releaseWakeLock();
            });
            peer.on('error', (err) => {
                console.log('[DEBUG] Sender peer error:', err.message, {
                    transferComplete: transferCompleteRef.current,
                    progressRef: progressRef.current
                });
                // Don't show Link Invalid if transfer is in progress or completed
                if (transferCompleteRef.current || progressRef.current > 0) {
                    console.log('[DEBUG] Sender peer error: Transfer in progress, showing interrupted');
                    setStatus('Connection interrupted');
                    return;
                }
                console.log('[DEBUG] Sender peer error: Setting Connection error');
                setError(`Connection error: ${err.message}`);
                setStatus('Connection failed');
            });

            peerRef.current = peer;
        });
    };

    const sendAllFiles = async (peer: PeerInstance, fileList: FileWithId[]) => {
        for (let i = 0; i < fileList.length; i++) {
            if (peer.destroyed) break;

            setCurrentFileIndex(i);
            const fileItem = fileList[i];
            setStatus(`Sending: ${fileItem.file.name}`);
            setProgress(0);

            await sendSingleFile(peer, fileItem, i + 1, fileList.length);
        }
        if (!peer.destroyed) {
            setStatus('All Files Sent!');
            setProgress(100);
            transferCompleteRef.current = true; // Mark transfer complete for sender
            releaseWakeLock();
        }
    };

    const sendSingleFile = async (
        peer: PeerInstance,
        fileItem: FileWithId,
        index: number,
        total: number
    ) => {
        return new Promise<void>(async (resolve) => {
            const MIN_CHUNK = 64 * 1024;
            const MAX_CHUNK = 256 * 1024;
            const BUFFER_LIMIT = 1024 * 1024;
            const ADAPT_INTERVAL = 20;
            const { file, id } = fileItem;

            if (!peer || peer.destroyed) {
                resolve();
                return;
            }

            try {
                peer.send(
                    JSON.stringify({
                        id: id,
                        fileName: file.name,
                        fileSize: file.size,
                        type: 'metadata',
                        index: index,
                        total: total,
                    })
                );
            } catch (err) {
                resolve();
                return;
            }

            const startOffset = await new Promise<number>((resolveAck) => {
                const handleAck = (data: any) => {
                    if (data.byteLength < 1000) {
                        try {
                            const text = new TextDecoder().decode(data);
                            const msg = JSON.parse(text);
                            if (msg.type === 'ack' && msg.id === id) {
                                peer.off('data', handleAck);
                                resolveAck(msg.offset);
                            }
                        } catch (e) { }
                    }
                };
                peer.on('data', handleAck);
            });

            let offset = startOffset;
            let chunkCount = 0;
            let measureStart = performance.now();
            let measureBytes = 0;

            let speedMeasureStart = performance.now();
            let speedMeasureBytes = 0;
            let lastSpeedUpdate = 0;

            while (offset < file.size) {
                const CHUNK_SIZE = chunkSizeRef.current;
                const channel = (peer as any)._channel as RTCDataChannel | undefined;

                if (channel && channel.bufferedAmount > BUFFER_LIMIT) {
                    await new Promise<void>((r) => {
                        const lowThreshold = CHUNK_SIZE;
                        channel.bufferedAmountLowThreshold = lowThreshold;

                        const onBufferLow = () => {
                            channel.removeEventListener('bufferedamountlow', onBufferLow);
                            r();
                        };

                        if (channel.bufferedAmount < lowThreshold) {
                            r();
                        } else {
                            channel.addEventListener('bufferedamountlow', onBufferLow);
                        }
                    });
                }

                const chunkBlob = file.slice(offset, offset + CHUNK_SIZE);
                const chunkBuffer = await chunkBlob.arrayBuffer();
                if (peer.destroyed) break;

                try {
                    peer.send(chunkBuffer);
                    offset += chunkBuffer.byteLength;
                    measureBytes += chunkBuffer.byteLength;
                    speedMeasureBytes += chunkBuffer.byteLength;
                    chunkCount++;

                    const now = performance.now();
                    if (now - lastSpeedUpdate > 1000) {
                        const elapsed = (now - speedMeasureStart) / 1000;
                        if (elapsed > 0) {
                            const bytesPerSec = speedMeasureBytes / elapsed;
                            const remaining = file.size - offset;
                            const etaSeconds = remaining / bytesPerSec;

                            const speedFormatted = bytesPerSec >= 1024 * 1024
                                ? `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`
                                : `${(bytesPerSec / 1024).toFixed(1)} KB/s`;

                            let etaFormatted = '';
                            if (etaSeconds < 60) {
                                etaFormatted = `${Math.ceil(etaSeconds)}s`;
                            } else if (etaSeconds < 3600) {
                                etaFormatted = `${Math.floor(etaSeconds / 60)}m ${Math.ceil(etaSeconds % 60)}s`;
                            } else {
                                etaFormatted = `${Math.floor(etaSeconds / 3600)}h ${Math.floor((etaSeconds % 3600) / 60)}m`;
                            }

                            setTransferSpeed(speedFormatted);
                            setEstimatedTime(etaFormatted);
                        }

                        speedMeasureStart = now;
                        speedMeasureBytes = 0;
                        lastSpeedUpdate = now;
                    }

                    if (chunkCount % ADAPT_INTERVAL === 0) {
                        const elapsed = (performance.now() - measureStart) / 1000;
                        const bytesPerSec = measureBytes / elapsed;

                        let newChunkSize: number;
                        if (bytesPerSec > 2 * 1024 * 1024) {
                            newChunkSize = MAX_CHUNK;
                        } else if (bytesPerSec > 500 * 1024) {
                            newChunkSize = 128 * 1024;
                        } else {
                            newChunkSize = MIN_CHUNK;
                        }

                        if (newChunkSize !== chunkSizeRef.current) {
                            chunkSizeRef.current = newChunkSize;
                        }

                        measureStart = performance.now();
                        measureBytes = 0;
                    }

                    if (
                        chunkCount % 10 === 0 ||
                        offset >= file.size
                    ) {
                        const prog = Math.round((offset / file.size) * 100);
                        setProgress(prog);
                        progressRef.current = prog;
                    }
                } catch (error) {
                    await new Promise((r) => setTimeout(r, 100));
                    continue;
                }
            }

            setTransferSpeed('');
            setEstimatedTime('');

            try {
                peer.send(JSON.stringify({ type: 'end' }));
            } catch (err) { }
            resolve();
        });
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
                            {/* Show non-link errors as dismissable alert */}
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
                            {isSender && (
                                <div
                                    className={`flex justify-end items-center gap-3 text-[10px] uppercase font-bold tracking-widest text-zinc-500 mb-[-10px] pb-1.5 ${progress > 0 ? '' : 'pr-2'}`}
                                >
                                    <div className="flex items-center gap-1">
                                        <Wifi className="w-3 h-3" />
                                        <span className="font-mono">
                                            {isConnected
                                                ? `${ping < 1 ? ping : Math.round(ping)}ms`
                                                : '--'}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <span className="relative flex h-2 w-2">
                                            <span
                                                className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${isConnected ? 'bg-green-400' : 'bg-red-500'}`}
                                            ></span>
                                            <span
                                                className={`relative inline-flex rounded-full h-2 w-2 ${isConnected ? 'bg-green-500' : 'bg-red-600'}`}
                                            ></span>
                                        </span>
                                        <span>
                                            {isConnected
                                                ? 'Connected'
                                                : 'Offline'}
                                        </span>
                                    </div>
                                </div>
                            )}

                            {isSender && progress > 0 && (
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
                                        Max size: Unlimited{' '}
                                        <Infinity
                                            className="w-3 h-3"
                                            strokeWidth={1.5}
                                        />
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
                                            <Button
                                                onClick={handleCreateLink}
                                                className="w-full mb-4 bg-white text-black hover:bg-zinc-200 font-bold"
                                            >
                                                Create Secure Link & Share (
                                                {files.length} Files){' '}
                                                <ArrowRight className="w-4 h-4 ml-2" />
                                            </Button>
                                        )}

                                        {generatedLink && (
                                            <div className="rounded-lg bg-black/40 p-4 border border-zinc-800 mb-4">
                                                <div className="group">
                                                    <p className="text-[10px] uppercase text-zinc-500 mb-1 font-bold tracking-wider">
                                                        Share Link
                                                    </p>
                                                    <div className="relative">
                                                        <code className="block break-all rounded bg-zinc-950 p-3 pr-12 text-xs text-zinc-300 font-mono border border-zinc-800 group-hover:border-zinc-600 transition">
                                                            {generatedLink}
                                                        </code>
                                                        <div className="absolute top-2 right-2 flex flex-col items-center group/btn">
                                                            <button
                                                                onClick={
                                                                    handleCopy
                                                                }
                                                                className="p-1.5 rounded-md bg-zinc-900/50 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-white transition-all"
                                                            >
                                                                {copied ? (
                                                                    <Check className="h-3.5 w-3.5 text-green-500" />
                                                                ) : (
                                                                    <Copy className="h-3.5 w-3.5" />
                                                                )}
                                                            </button>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="mt-4 flex w-full items-center justify-center gap-2 text-xs transition-colors duration-300">
                                                    {status ===
                                                        'All Files Sent!' ? (
                                                        <CheckCircle2 className="h-3 w-3 shrink-0 text-green-400" />
                                                    ) : (
                                                        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-zinc-500" />
                                                    )}
                                                    <span
                                                        className={`truncate max-w-[280px] ${status === 'All Files Sent!' ? 'text-green-400 font-medium' : 'text-zinc-500'}`}
                                                    >
                                                        {status}
                                                    </span>
                                                </div>
                                            </div>
                                        )}

                                        <div
                                            ref={fileListRef}
                                            className="space-y-3 max-h-[300px] overflow-y-scroll pr-1 pb-12 custom-scrollbar"
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
                                    </div>
                                )}

                            {!isSender && (
                                <div className="space-y-3 pt-2">
                                    {receivedFiles.length === 0 &&
                                        !status.includes('Receiving') && (
                                            <div className="text-center text-sm text-zinc-500 py-8">
                                                Waiting for sender...
                                            </div>
                                        )}


                                    {receivedFiles.length > 0 && (
                                        <p className="text-sm text-zinc-400 mb-3">
                                            {receivedFiles.length} {receivedFiles.length === 1 ? 'file' : 'files'} received
                                        </p>
                                    )}

                                    {receivedFiles.length > 1 &&
                                        !status.includes('Receiving') && (
                                            <div className="grid grid-cols-2 gap-2 mb-3 animate-in fade-in slide-in-from-top-2 duration-300">
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

                                    {/* Download/ZIP Progress Indicator */}
                                    {(isZipping || isDownloading) && downloadProgress.total > 0 && (
                                        <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700 space-y-2">
                                            <div className="flex items-center justify-between text-xs">
                                                <span className="text-zinc-400 truncate max-w-[180px]">
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
                                                className="flex items-center justify-between rounded-lg bg-zinc-900 p-3 border border-zinc-800"
                                            >
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-500/10 text-green-500">
                                                        <CheckCircle2 className="h-5 w-5" />
                                                    </div>
                                                    <div className="flex flex-col min-w-0 relative">
                                                        <span className="peer text-sm font-medium text-white truncate max-w-[250px] cursor-help">
                                                            {file.fileName}
                                                        </span>
                                                        <div className="absolute top-full left-0 mt-1 opacity-0 peer-hover:opacity-100 z-[9999] w-max max-w-[240px] px-3 py-2 text-xs font-medium text-white bg-zinc-950 rounded-lg border border-zinc-800 shadow-2xl break-all pointer-events-none">
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

                                    {status.includes('Receiving') && (
                                        <div className="flex w-full items-center justify-center gap-2 text-xs text-zinc-400 animate-pulse pt-2">
                                            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                                            <span className="truncate max-w-[280px]">
                                                {status}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    )}
                </CardContent>

                <CardFooter className="flex-col justify-center border-t border-white/5 py-4 gap-2">
                    <p className="text-[10px] text-zinc-500 uppercase tracking-widest text-center">
                        {isSender
                            ? 'Do not close this tab. Closing it will cancel the transfer.'
                            : 'Do not close this tab. Closing it will interrupt the download.'}
                    </p>
                </CardFooter>
            </Card>
        </main>
    );
}
