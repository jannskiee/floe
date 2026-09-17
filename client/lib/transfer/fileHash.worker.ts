// Worker that hashes File or Blob requests one at a time, so a large file never
// blocks the page. Bytes in, a digest out: nothing here parses what it reads.
// The slab size arrives with each request rather than as an import of
// READ_SLAB, which keeps protocol.ts and everything it imports out of this
// chunk, so the chunk is the hasher only.
import { createHashHandler, type HashReply, type HashRequest } from './sha256Slices';

// The DOM lib types `self` as a Window, whose postMessage needs a target origin;
// a dedicated worker's does not.
const scope = self as unknown as {
    onmessage: ((event: MessageEvent<HashRequest>) => void) | null;
    postMessage(message: HashReply): void;
};

const handle = createHashHandler((reply) => scope.postMessage(reply));
scope.onmessage = (event) => handle(event.data);
