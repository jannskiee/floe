import { useEffect, useRef, useState } from 'react';
import { buildZipEntries, sanitizeFileName } from '@/lib/download';
import { holdObjectUrl, type HeldObjectUrl } from '@/lib/heldObjectUrl';
import { writeZip } from '@/lib/zipWriter';

/** How long a finished archive's object URL is kept after its click. */
const ZIP_URL_HOLD_MS = 60_000;

export interface ReceivedFile {
    id: string;
    /**
     * Exactly what the peer called the file, unvalidated. Never use it to name
     * something on disk or as an object key: run it through `sanitizeFileName`
     * or `sanitizeZipEntryName` in lib/download.ts first.
     */
    fileName: string;
    fileSize: number;
    /** The file itself; Download ZIP reads it a slice at a time. */
    blob: Blob;
    /** An object URL of `blob`, for the file's own download link. */
    downloadUrl: string;
    /**
     * True only when the sender sent a SHA-256 for this file and it matched the
     * bytes that arrived. A local compare result, never a peer value.
     */
    verified: boolean;
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
 *
 * `onSaved` hears the ids of the files each button has handed to the browser
 * to save, so the page's leave prompt can let go once nothing is left unsaved
 * (lib/pageGuards.ts). Handed over is all the page can know: a cancelled Save
 * As dialog or a blocked second download reports nothing back.
 */
export function useDownloadManager(
    receivedFiles: ReceivedFile[],
    setError: (message: string) => void,
    onSaved?: (ids: readonly string[]) => void
) {
    const [isZipping, setIsZipping] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState({ current: 0, total: 0, label: '' });
    const [isDownloading, setIsDownloading] = useState(false);
    // The newest archive's object URL, let go a minute after the click, when
    // the next archive replaces it, or when the page goes; never right after
    // the click (lib/heldObjectUrl.ts says why). A minute is ample to open a
    // download that started on a click; FileSaver.js has waited 40 s for years.
    const zipUrlRef = useRef<HeldObjectUrl | null>(null);
    const unmountedRef = useRef(false);

    useEffect(() => {
        return () => {
            unmountedRef.current = true;
            zipUrlRef.current?.release();
        };
    }, []);

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
            onSaved?.([file.id]);

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
            const files = receivedFiles.slice();
            // Sanitizing and de-duplicating happen together in buildZipEntries,
            // in that order, one entry per file. See lib/download.ts.
            const entries = buildZipEntries(files.map((file) => ({ fileName: file.fileName, blob: file.blob })));

            // Refused before a byte is read when the archive would pass what
            // a ZIP without ZIP64 can say (lib/zipWriter.ts, planZip): the
            // throw lands in the catch below.
            const { archive, skipped } = await writeZip(entries, {
                onEntry: (index, count, name) =>
                    setDownloadProgress({ current: index, total: count, label: `Processing: ${sanitizeFileName(name)}` }),
                onFinish: () =>
                    setDownloadProgress({ current: entries.length, total: entries.length, label: 'Creating ZIP archive...' }),
            });

            // The ids of the files in the archive: every file but one that
            // could not be read, which writeZip leaves out whole.
            const left = new Set(skipped);
            const zipped = files.filter((_, i) => !left.has(i)).map((file) => file.id);
            const failedCount = skipped.length;

            if (zipped.length === 0) {
                setError('Could not prepare files for ZIP. Try "Download All" instead.');
                setIsZipping(false);
                setDownloadProgress({ current: 0, total: 0, label: '' });
                return;
            }
            if (unmountedRef.current) return;

            zipUrlRef.current ??= holdObjectUrl(ZIP_URL_HOLD_MS);
            const url = zipUrlRef.current.hold(archive);
            const link = document.createElement('a');
            link.href = url;
            link.download = `floe_transfer_${new Date().getTime()}.zip`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            onSaved?.(zipped);
            setIsZipping(false);
            setDownloadProgress({ current: 0, total: 0, label: '' });
            if (failedCount > 0) {
                setError(`${failedCount} file(s) could not be included in ZIP.`);
            }
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
