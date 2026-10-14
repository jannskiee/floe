// The self-hosted client image's entry point (CMD in client/Dockerfile): the
// standalone Next server, unchanged, then one warm-up of its own image cache
// (docker/warm-images.mjs says why). The server is imported into this same
// process, so it keeps the signal handling it has under `node server.js`.
//
// The warm-up can neither delay nor fail the start: it runs after the server
// module has loaded, nothing waits for it, and every failure, a missing module
// included, ends in the one fixed line below. It prints nothing when it works.

await import('./server.js');

const WARM_FAILED_LINE =
    'Floe: the image warm-up did not finish; pictures are resized on first request instead.';

void (async () => {
    let ok = false;
    try {
        const { warmImageCache } = await import('./warm-images.mjs');
        ok = await warmImageCache({ origin: `http://127.0.0.1:${process.env.PORT || '3000'}` });
    } catch {
        ok = false;
    }
    if (!ok) console.warn(WARM_FAILED_LINE);
})();
