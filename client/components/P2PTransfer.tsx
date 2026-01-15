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
    const [isSender, setIsSender] = useState(false);
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
    const [error, setError] = useState('');

    const peerRef = useRef<PeerInstance | null>(null);
    const wakeLockRef = useRef<WakeLockSentinel | null>(null);
    const partialDownloads = useRef<
        Map<string, { chunks: ArrayBuffer[]; received: number }>
    >(new Map());
    const fileListRef = useRef<HTMLDivElement>(null);
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
                console.log('ICE servers fetched from metered.ca');
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

    const handleDownloadAll = () => {
        receivedFiles.forEach((file, index) => {
            setTimeout(() => {
                const link = document.createElement('a');
                link.href = file.downloadUrl;
                link.download = file.fileName;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            }, index * 500);
        });
    };

    const handleDownloadZip = async () => {
        if (receivedFiles.length === 0) return;
        setIsZipping(true);
        try {
            const filesToZip: Zippable = {};
            const usedNames = new Set<string>();

            await Promise.all(
                receivedFiles.map(async (file) => {
                    const response = await fetch(file.downloadUrl);
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
                })
            );

            zip(filesToZip, (err, data) => {
                if (err) {
                    console.error('Zip error', err);
                    setIsZipping(false);
                    return;
                }
                const blob = new Blob([data], { type: 'application/zip' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `floe_transfer_${new Date().getTime()}.zip`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);
                setIsZipping(false);
            });
        } catch (error) {
            console.error('Error preparing zip:', error);
            setIsZipping(false);
        }
    };

    const handleCopy = () => {
        navigator.clipboard.writeText(generatedLink);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    useEffect(() => {
        fetchIceServers();

        if (socket.connected) setIsConnected(true);
        socket.on('connect', () => setIsConnected(true));
        socket.on('disconnect', () => {
            setIsConnected(false);
            setPing(0);
        });

        const pingInterval = setInterval(() => {
            const start = performance.now();
            socket.emit('ping', () => {
                const duration = performance.now() - start;
                setPing(Number(duration.toFixed(2)));
            });
        }, 2000);

        const params = new URLSearchParams(window.location.search);
        const roomFromUrl = params.get('room');

        if (roomFromUrl) {
            setIsSender(false);
            joinRoomAsReceiver(roomFromUrl);
        } else {
            setIsSender(true);
        }

        socket.on('signal', (data: any) => {
            if (peerRef.current && !peerRef.current.destroyed) {
                peerRef.current.signal(data.signal);
            }
        });

        socket.on('peer-disconnected', () => {
            setStatus('Peer disconnected. Waiting for reconnection...');
            setIsConnected(false);
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
                trickle: false,
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
                setIsConnected(false);
                releaseWakeLock();
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
            const CHUNK_SIZE = 160 * 1024;
            const BUFFER_LIMIT = 1 * 1024 * 1024;
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

            console.log(`Resuming ${file.name} from: ${startOffset}`);

            let offset = startOffset;
            while (offset < file.size) {
                const channel = peer._channel;
                if (channel && channel.bufferedAmount > BUFFER_LIMIT) {
                    await new Promise<void>((r) => {
                        const wait = () => {
                            if (
                                !channel ||
                                channel.bufferedAmount < CHUNK_SIZE
                            ) {
                                r();
                            } else {
                                setTimeout(wait, 5);
                            }
                        };
                        wait();
                    });
                }

                const chunkBlob = file.slice(offset, offset + CHUNK_SIZE);
                const chunkBuffer = await chunkBlob.arrayBuffer();
                if (peer.destroyed) break;

                try {
                    peer.send(chunkBuffer);
                    offset += CHUNK_SIZE;
                    if (
                        offset % (CHUNK_SIZE * 10) === 0 ||
                        offset >= file.size
                    ) {
                        setProgress(Math.round((offset / file.size) * 100));
                    }
                } catch (error) {
                    await new Promise((r) => setTimeout(r, 100));
                    continue;
                }
            }
            try {
                peer.send(JSON.stringify({ type: 'end' }));
            } catch (err) { }
            resolve();
        });
    };

    const joinRoomAsReceiver = (roomId: string) => {
        setStatus('Connecting...');
        socket.emit('join-room', roomId);

        socket.on('room-full', () => {
            setError('Link Expired or Busy');
            setStatus('Access Denied');
            socket.disconnect();
        });

        const peer = new SimplePeer({
            initiator: false,
            trickle: false,
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
            setIsConnected(false);
            releaseWakeLock();
        });

        let currentMetadata: any = {};

        peer.on('data', (data) => {
            const isFileChunk = data.byteLength > 1000;

            if (!isFileChunk) {
                try {
                    const text = new TextDecoder().decode(data);
                    if (text.startsWith('{')) {
                        const msg = JSON.parse(text);

                        if (msg.type === 'metadata') {
                            currentMetadata = msg;
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
                                setReceivedFiles((prev) => [
                                    ...prev,
                                    {
                                        id: uuidv4(),
                                        fileName: currentMetadata.fileName,
                                        fileSize: currentMetadata.fileSize,
                                        downloadUrl: url,
                                    },
                                ]);
                                partialDownloads.current.delete(
                                    currentMetadata.id
                                );
                            }
                            setStatus('File Received. Waiting for next...');
                            setProgress(0);
                        }
                        return;
                    }
                } catch (e) { }
            }

            const fileData = partialDownloads.current.get(currentMetadata.id);
            if (fileData) {
                fileData.chunks.push(data);
                fileData.received += data.byteLength;

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
                    {error ? (
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
                                                    ? `Upload Complete (${files.length} Files)`
                                                    : files.length > 1
                                                        ? `Sending File ${currentFileIndex + 1} of ${files.length}...`
                                                        : 'Transferring 1 File...'
                                                : status.includes('Receiving')
                                                    ? status
                                                    : 'Receiving...'}
                                        </span>
                                        <span>{progress}%</span>
                                    </div>
                                    <Progress
                                        value={progress}
                                        className="h-1 bg-zinc-800 [&>div]:bg-zinc-200"
                                    />
                                </div>
                            )}

                            {isSender && !generatedLink && (
                                <div className="group relative mt-2 flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-700 bg-zinc-900/50 p-10 transition-all hover:border-white/50 hover:bg-zinc-800">
                                    <div className="mb-4 rounded-full bg-zinc-800 p-4 transition group-hover:bg-zinc-700">
                                        <UploadCloud className="h-8 w-8 text-zinc-400 group-hover:text-white" />
                                    </div>
                                    <p className="mb-2 text-sm font-medium text-zinc-200">
                                        Click or Drag files here
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
                                            className="space-y-3 max-h-[300px] overflow-y-auto pr-1 custom-scrollbar"
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
                                                    <div className="flex flex-col min-w-0 relative group">
                                                        <span
                                                            className={`text-sm font-medium truncate cursor-help transition-colors ${i === currentFileIndex && progress > 0 && progress < 100 ? 'text-white' : 'text-zinc-400'}`}
                                                        >
                                                            {item.file.name}
                                                        </span>
                                                        <div className="absolute bottom-full left-0 mb-2 hidden group-hover:block z-50 w-max max-w-[240px] px-3 py-2 text-xs font-medium text-white bg-zinc-950 rounded-lg border border-zinc-800 shadow-2xl break-all">
                                                            {item.file.name}
                                                            <div className="absolute top-full left-4 -mt-1 h-2 w-2 rotate-45 border-r border-b border-zinc-800 bg-zinc-950"></div>
                                                        </div>
                                                        <span className="text-xs text-zinc-500 font-mono">
                                                            {formatBytes(
                                                                item.file.size
                                                            )}
                                                        </span>
                                                    </div>
                                                    <div className="ml-auto">
                                                        {!generatedLink ? (
                                                            <div className="h-2 w-2 rounded-full bg-zinc-600"></div>
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

                                    {receivedFiles.length > 1 &&
                                        !status.includes('Receiving') && (
                                            <div className="grid grid-cols-2 gap-2 mb-3 animate-in fade-in slide-in-from-top-2 duration-300">
                                                <Button
                                                    onClick={handleDownloadAll}
                                                    className="w-full bg-white text-black hover:bg-zinc-200 font-medium transition-colors border-none"
                                                >
                                                    <Download className="w-4 h-4 mr-2" />{' '}
                                                    Download All
                                                </Button>
                                                <Button
                                                    onClick={handleDownloadZip}
                                                    disabled={isZipping}
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
                                                    <div className="flex flex-col min-w-0 relative group">
                                                        <span className="text-sm font-medium text-white truncate max-w-[250px] cursor-help">
                                                            {file.fileName}
                                                        </span>
                                                        <div className="absolute bottom-full left-0 mb-2 hidden group-hover:block z-50 w-max max-w-[240px] px-3 py-2 text-xs font-medium text-white bg-zinc-950 rounded-lg border border-zinc-800 shadow-xl break-all">
                                                            {file.fileName}
                                                            <div className="absolute top-full left-4 -mt-1 h-2 w-2 rotate-45 border-r border-b border-zinc-800 bg-zinc-950"></div>
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
