/**
 * Browser entry for the loopback bundle: exposes the real sender engine to a
 * page.evaluate in loopback-host.spec.ts, and the two frame builders a scripted
 * sender needs in partial-receive.spec.ts. Bundled by ./bundle.ts at global
 * setup; never imported by the app.
 */

import { sendFiles } from '../../lib/transfer/sender';
import { endMessage, metadataMessage } from '../../lib/transfer/protocol';

(globalThis as typeof globalThis & {
    floeLoopback?: {
        sendFiles: typeof sendFiles;
        metadataMessage: typeof metadataMessage;
        endMessage: typeof endMessage;
    };
}).floeLoopback = {
    sendFiles,
    metadataMessage,
    endMessage,
};
