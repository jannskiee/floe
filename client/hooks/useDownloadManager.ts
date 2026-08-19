import { useState } from 'react';
import { zip, Zippable } from 'fflate';
import { buildZipEntries, sanitizeFileName } from '@/lib/download';

export interface ReceivedFile {
    id: string;
    /**
     * Exactly what the peer called the file, unvalidated. Never use it to name
     * something on disk or as an object key: run it through `sanitizeFileName`
     * or `sanitizeZipEntryName` in lib/download.ts first.
     */
    fileName: string;
    fileSize: number;
    downloadUrl: string;
}

/**
 * Receiver-side download orchestration: saving each received file individually
 * ("Download All") or bundling them into a single archive ("Download ZIP"),
 * plus the shared progress state. Runs only after a transfer has completed, so
 * it has no dependency on the signaling or WebRTC layer.
 *
 * `receivedFiles` is read-only here (the receiver connection logic owns it) and
 * `setError` is shared with the component (it also reports connection errors),
 * so both are passed in rather than owned by this hook.
 */
export function useDownloadManager(
    receivedFiles: ReceivedFile[],
    setError: (message: string) => void
) {
    const [isZipping, setIsZipping] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState({ current: 0, total: 0, label: '' });
    const [isDownloading, setIsDownloading] = useState(false);

    const handleDownloadAll = async () => {
        setIsDownloading(true);
        setDownloadProgress({ current: 0, total: receivedFiles.length, label: 'Starting download...' });

        for (let i = 0; i < receivedFiles.length; i++) {
            const file = receivedFiles[i];
            setDownloadProgress({
                current: i + 1,
                total: receivedFiles.length,
                label: `Downloading: ${sanitizeFileName(file.fileName)}`
            });

            const link = document.createElement('a');
            link.href = file.downloadUrl;
            link.download = sanitizeFileName(file.fileName);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            await new Promise(resolve => setTimeout(resolve, 300));
        }

        setIsDownloading(false);
        setDownloadProgress({ current: 0, total: 0, label: '' });
    };

    const handleDownloadZip = async () => {
        if (receivedFiles.length === 0) return;

        setIsZipping(true);
        setError('');
        setDownloadProgress({ current: 0, total: receivedFiles.length, label: 'Preparing files...' });

        try {
            const collected: { fileName: string; bytes: Uint8Array }[] = [];
            let failedCount = 0;

            for (let i = 0; i < receivedFiles.length; i++) {
                const file = receivedFiles[i];
                setDownloadProgress({
                    current: i + 1,
                    total: receivedFiles.length,
                    label: `Processing: ${sanitizeFileName(file.fileName)}`
                });

                try {
                    const response = await fetch(file.downloadUrl);
                    if (!response.ok) throw new Error('Fetch failed');
                    const blob = await response.blob();
                    const arrayBuffer = await blob.arrayBuffer();

                    collected.push({ fileName: file.fileName, bytes: new Uint8Array(arrayBuffer) });
                } catch {
                    failedCount++;
                }
            }

            // Sanitizing and de-duplicating happen together in buildZipEntries,
            // in that order, on a null-prototype object. See lib/download.ts.
            const filesToZip = buildZipEntries(collected) as Zippable;

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
        } catch {
            setError('ZIP creation failed. Try "Download All" instead.');
            setIsZipping(false);
            setDownloadProgress({ current: 0, total: 0, label: '' });
        }
    };

    return {
        isZipping,
        isDownloading,
        downloadProgress,
        handleDownloadAll,
        handleDownloadZip,
    };
}
