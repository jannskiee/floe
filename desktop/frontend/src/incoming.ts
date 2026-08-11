// Pure helpers for the incoming-transfer preview. They live outside App.tsx so
// they can be tested without a DOM or the Wails runtime bindings, which do not
// exist outside the WebView.

// IncomingPreview mirrors the engine's IncomingInfo payload on the
// "recv:incoming" event: what the sender announced in its first metadata,
// before any byte lands on disk.
export interface IncomingPreview {
    files: number;
    totalBytes: number;
    firstName: string;
}

// fmtBytes renders a byte count the way the rest of the app does (also used by
// the progress label and history rows in App.tsx).
export function fmtBytes(n: number): string {
    if (!n || n < 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

// formatIncoming renders the pre-transfer preview line, mirroring the CLI's
// Incoming box: a single file shows its name and size, a batch shows the count
// and total. Sizes are omitted when a legacy sender did not announce one.
export function formatIncoming(p: IncomingPreview): string {
    if (p.files === 1) {
        // The engine falls back to the file's own size for single-file legacy
        // senders, so a zero here is a genuine 0-byte file: show it, matching
        // the CLI's Incoming box.
        const name = p.firstName || 'file';
        return `Incoming: ${name} · ${fmtBytes(p.totalBytes)}`;
    }
    return p.totalBytes > 0
        ? `Incoming: ${p.files} files · ${fmtBytes(p.totalBytes)}`
        : `Incoming: ${p.files} files`;
}
