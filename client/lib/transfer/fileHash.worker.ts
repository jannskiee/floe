// Module Worker that hashes one File or Blob per request, so a large file never
// blocks the page. Bytes in, a digest out: nothing here parses what it reads.
// The slab size arrives with each request rather than as an import of READ_SLAB:
// protocol.ts imports download.ts, which has no business in this bundle.
import { digestSlices } from './sha256Slices';

// The DOM lib types `self` as a Window, whose postMessage needs a target origin;
// a dedicated worker's does not.
const scope = self as unknown as {
    onmessage: ((event: MessageEvent<{ id: number; blob: Blob; slab: number }>) => void) | null;
    postMessage(message: { id: number; hex: string | null }): void;
};

scope.onmessage = (event) => {
    const { id, blob, slab } = event.data;
    digestSlices((start, end) => blob.slice(start, end).arrayBuffer(), blob.size, slab).then(
        (hex) => scope.postMessage({ id, hex }),
        () => scope.postMessage({ id, hex: null }),
    );
};
