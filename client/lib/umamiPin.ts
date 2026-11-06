// The one copy of the Umami tracker floe.one runs: a reviewed, byte-identical
// copy of https://cloud.umami.is/script.js, served from this site and checked by
// the browser against UMAMI_INTEGRITY. These two values and the file's name move
// together: components/UmamiScript.tsx says how, and umamiPin.test.ts fails on
// any byte that moved without them.
//
// Reviewed 2026-11-01: 8,575 bytes, sha256 prefix 8104cfafda3cc828.

/** Where the pinned copy is served from (client/public/vendor). */
export const UMAMI_SRC = '/vendor/umami-8104cfaf.js';

/** The file's sha384, as the script element's integrity attribute wants it. */
export const UMAMI_INTEGRITY = 'sha384-qBMkW5XuEvF7vjEQbT+t3su7NJKb8XQJqscZjtnOQ8P4959GgenEpURFw2Uzb8mU';
