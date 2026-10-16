'use strict';

// How the seven MAX_* settings are read: MAX_CONNECTIONS_PER_IP,
// MAX_SOCKETS_PER_IP, MAX_CODE_REQUESTS_PER_IP, MAX_FAILED_CODE_RESOLVES and
// MAX_ACTIVE_CODES in server.js, MAX_TURN_REQUESTS_PER_IP in turn.js and
// MAX_REPORT_BYTES in stats.js. A module of its own for the reason ratekey.js
// is one: turn.js and stats.js need it, and server.js requires both.
//
// Every check these values feed has the form `count >= max` (the report cap
// is `bytes <= max`), so a value below 1 would refuse everything the limit
// guards. A setting is therefore used only when it is a whole number of at
// least 1 written in digits. Anything else gets the default and one line that
// names the variable and the default.
//
// Digits, not parseInt: parseInt reads "1e3" and "1,000" as 1, which is the
// same refusal under another spelling, and "12.5" as 12, which nobody asked
// for. Unset, empty and blank all mean "use the default" and log nothing:
// Compose passes an empty string for a variable its .env leaves out.
//
// The line never carries the value. An operator can paste a secret into the
// wrong field, and a log is read by more people than a settings page.
//
// docs-check.mjs (serverEnv) reads each default out of the call sites to
// compare it with the documented one. It matches the call on one line, with
// the name as a quoted literal and the default as plain arithmetic; a call
// written any other way fails that check, so change the two together.

function envLimit(name, fallback, { env = process.env, warn = console.warn } = {}) {
    const raw = env[name];
    const text = raw === undefined ? '' : String(raw).trim();
    if (text === '') return fallback;
    if (/^\d+$/.test(text) && Number(text) >= 1) return Number(text);
    warn(`${name} is not a whole number of at least 1. Using the default, ${fallback}.`);
    return fallback;
}

module.exports = { envLimit };
