/**
 * Browser entry for the loopback bundle: exposes the real sender engine to a
 * page.evaluate in loopback-host.spec.ts. Bundled by ./bundle.ts at global
 * setup; never imported by the app.
 */

import { sendFiles } from '../../lib/transfer/sender';

(globalThis as typeof globalThis & { floeLoopback?: { sendFiles: typeof sendFiles } }).floeLoopback = {
    sendFiles,
};
