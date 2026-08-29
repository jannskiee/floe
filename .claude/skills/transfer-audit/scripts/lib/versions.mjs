// Version currency: what is installed or deployed on each surface against
// the latest release, plus wire-protocol parity between the Go engine and
// the browser. Pure helpers are exported for versions.test.mjs; the
// collectors take injected `gh`, `exec` and `fetchImpl` so nothing here
// needs a network in tests.
//
// Rules that matter for safety: the CLI is asked `floe --version` only
// (never `floe version`, which writes %APPDATA%\floe\update-check.json) and
// always with FLOE_NO_UPDATE_CHECK=1; the Store package is read with
// Get-AppxPackage; nothing is installed or updated from here.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { getJson } from './http.mjs';

export const REPO = 'jannskiee/floe';
export const STORE_PACKAGE = 'JanCarloParedes.FloeDesktop';
export const CLI_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
export const DESKTOP_TAG_RE = /^desktop-v(\d+)\.(\d+)\.(\d+)$/;
export const STATUSES = Object.freeze([
    'CURRENT',
    'STALE',
    'UNKNOWN',
    'NOT_INSTALLED',
    'PARITY',
    'DRIFT',
    'INFO',
]);
export const DRIFT_STATUSES = new Set(['STALE', 'DRIFT', 'UNKNOWN']);

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/** 'floe 3.4.5\n' -> '3.4.5'; 'floe dev' -> 'dev'; else null. */
export function parseFloeVersion(stdout) {
    const m = /^floe\s+(\S+)/m.exec(String(stdout || ''));
    return m ? m[1] : null;
}

// Copied from .claude/skills/store-submit/scripts/msix-preflight.mjs:121-134.
export function parseTag(tag) {
    const m = DESKTOP_TAG_RE.exec(tag || '');
    if (!m) return null;
    const [major, minor, patch] = m.slice(1).map(Number);
    return { tag, version: `${major}.${minor}.${patch}`, major, minor, patch };
}

// pack.ps1's rule: (major+1).minor.patch.0 (3.4.5 -> 4.4.5.0).
export function identityVersion(tag) {
    const t = parseTag(tag);
    return t ? `${t.major + 1}.${t.minor}.${t.patch}.0` : null;
}

/** '4.4.5.0' -> '3.4.5'; null when the shape or first octet refuses. */
export function inverseIdentity(identity) {
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(identity || ''));
    if (!m) return null;
    const first = Number(m[1]);
    if (first < 1) return null;
    return `${first - 1}.${m[2]}.${m[3]}`;
}

export const productFromIdentity = inverseIdentity;

/** Numeric triple of 'v3.4.5', 'desktop-v3.4.5', '3.4.5'; null otherwise. */
export function versionTriple(v) {
    const m = /^(?:desktop-v|v)?(\d+)\.(\d+)\.(\d+)$/.exec(
        String(v || '').trim()
    );
    return m ? m.slice(1).map(Number) : null;
}

/** -1, 0, 1 or null when either side is not X.Y.Z. */
export function compareVersions(a, b) {
    const x = versionTriple(a);
    const y = versionTriple(b);
    if (!x || !y) return null;
    for (let i = 0; i < 3; i++) {
        if (x[i] < y[i]) return -1;
        if (x[i] > y[i]) return 1;
    }
    return 0;
}

/** NOT_INSTALLED / UNKNOWN / STALE / CURRENT. */
export function versionStatus(installed, latest) {
    if (installed === null || installed === undefined || installed === '')
        return 'NOT_INSTALLED';
    const c = compareVersions(installed, latest);
    if (c === null) return 'UNKNOWN';
    return c < 0 ? 'STALE' : 'CURRENT';
}

/**
 * Newest desktop-v tag among release records (GitHub API shape
 * { tag_name, draft } or gh release list shape { tagName, isDraft }),
 * drafts excluded, ordered by version not by date.
 */
export function pickLatestDesktop(releases) {
    let best = null;
    for (const r of releases || []) {
        const tag = r.tag_name ?? r.tagName;
        const draft = r.draft ?? r.isDraft ?? false;
        if (draft || !DESKTOP_TAG_RE.test(tag || '')) continue;
        if (!best || compareVersions(tag, best) > 0) best = tag;
    }
    return best;
}

/** Get-AppxPackage ... | ConvertTo-Json -> { name, version, installLocation, pfn } | null. */
/** Numeric compare of dotted versions of any length (missing parts are 0). */
export function compareQuad(a, b) {
    const parts = (v) =>
        String(v ?? '')
            .split('.')
            .map((p) => Number.parseInt(p, 10) || 0);
    const x = parts(a);
    const y = parts(b);
    const n = Math.max(x.length, y.length);
    for (let i = 0; i < n; i++) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d) return d < 0 ? -1 : 1;
    }
    return 0;
}

export function parseAppx(json) {
    if (json === null || json === undefined) return null;
    let data = json;
    if (typeof json === 'string') {
        const t = json.trim();
        if (!t) return null;
        try {
            data = JSON.parse(t);
        } catch {
            return null;
        }
    }
    // Get-AppxPackage answers with an array when several packages match
    // (two versions staged during an update); the highest Version is the
    // one that launches.
    if (Array.isArray(data))
        data = data
            .filter((d) => d && typeof d === 'object')
            .sort((a, b) =>
                compareQuad(b.Version ?? b.version, a.Version ?? a.version)
            )[0];
    if (!data || typeof data !== 'object') return null;
    return {
        name: data.Name ?? data.name ?? null,
        version: data.Version ?? data.version ?? null,
        installLocation: data.InstallLocation ?? data.installLocation ?? null,
        pfn: data.PackageFullName ?? data.packageFullName ?? null,
    };
}

/** HKCU Uninstall\Floe DisplayVersion from a PowerShell one-liner. */
export function parseDisplayVersion(text) {
    const t =
        String(text || '')
            .trim()
            .split(/\r?\n/)[0] || '';
    return /^\d+\.\d+\.\d+/.test(t) ? t : null;
}

export function protocolParity(goSrc, tsSrc, desktopReading = null) {
    const num = (src, re) => {
        const m = re.exec(String(src || ''));
        return m ? Number(m[1]) : null;
    };
    const go = {
        pv: num(goSrc, /\bProtocolVersion\s*=\s*(\d+)/),
        pvMin: num(goSrc, /\bMinProtocolVersion\s*=\s*(\d+)/),
    };
    const ts = {
        pv: num(tsSrc, /\bPROTOCOL_VERSION\s*=\s*(\d+)/),
        pvMin: num(tsSrc, /\bMIN_PROTOCOL_VERSION\s*=\s*(\d+)/),
    };
    let status;
    if ([go.pv, go.pvMin, ts.pv, ts.pvMin].some((v) => v === null))
        status = 'UNKNOWN';
    else if (go.pv === ts.pv && go.pvMin === ts.pvMin) status = 'PARITY';
    else status = 'DRIFT';
    let desktop = null;
    if (desktopReading !== null && desktopReading !== undefined) {
        const m = /(\d+)/.exec(String(desktopReading));
        desktop = m ? Number(m[1]) : null;
        if (status === 'PARITY' && desktop !== null && desktop !== go.pv)
            status = 'DRIFT';
    }
    return { go, ts, desktop, status };
}

/** "<hex>  <name>" or "<hex> *<name>" lines, CRLF tolerant. */
export function checksumFor(text, assetName) {
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.replace(/\r$/, '').trim();
        const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line);
        if (m && m[2].trim() === assetName) return m[1].toLowerCase();
    }
    throw new Error(`no checksum line for ${assetName}`);
}

/** Web or server currency from a deployed sha and a compare result. */
export function commitCurrency({ deployed, main, touched }) {
    if (!deployed) return 'UNKNOWN';
    if (
        main &&
        deployed.toLowerCase().startsWith(main.slice(0, 7).toLowerCase())
    )
        return 'CURRENT';
    if (
        main &&
        main.toLowerCase().startsWith(deployed.slice(0, 7).toLowerCase())
    )
        return 'CURRENT';
    if (touched === false) return 'CURRENT';
    if (touched === true) return 'STALE';
    return 'UNKNOWN';
}

export const compareWebSha = (deployed, main, touched) => ({
    current: commitCurrency({ deployed, main, touched }) === 'CURRENT',
    deployed,
    main,
});

/** The gating rows that carry a drift status. */
export function gatingDrift(rows) {
    return (rows || []).filter((r) => r.gate && DRIFT_STATUSES.has(r.status));
}

export function parseWebShaFile(text) {
    const j = typeof text === 'string' ? JSON.parse(text) : text;
    const sha = j?.githubCommitSha ?? j?.sha ?? j?.commit ?? null;
    return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.toLowerCase() : null;
}

export function short(sha) {
    return sha ? String(sha).slice(0, 7) : null;
}

/** Files of a compare payload under a directory prefix -> boolean. */
export function touchesDir(files, dir) {
    const prefix = dir.endsWith('/') ? dir : dir + '/';
    return (files || []).some((f) => String(f).startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Collectors (injected I/O)
// ---------------------------------------------------------------------------

/**
 * execFileSync with the audit's defaults, trimmed. `raw: true` returns the
 * output untrimmed, for callers that decode bytes themselves (a trimmed
 * UTF-16LE listing loses its leading byte and decodes to garbage).
 */
export function defaultExec(cmd, args, { raw = false, ...opts } = {}) {
    const out = execFileSync(cmd, args, {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: opts.timeout ?? 60_000,
        ...opts,
    });
    return raw ? out : out.trim();
}

export function makeGh(exec = defaultExec) {
    return (args, opts) => exec('gh', args, opts);
}

const PS_BASE = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
];

export function cliVersion(
    bin,
    { exec = defaultExec, env = process.env } = {}
) {
    const out = exec(bin, ['--version'], {
        env: { ...env, FLOE_NO_UPDATE_CHECK: '1' },
        timeout: 15_000,
    });
    return parseFloeVersion(out);
}

export function pathCli({ exec = defaultExec } = {}) {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    try {
        const first = exec(cmd, ['floe']).split(/\r?\n/).find(Boolean) || null;
        if (!first) return { path: null, version: null };
        return { path: first, version: cliVersion(first, { exec }) };
    } catch {
        return { path: null, version: null };
    }
}

export function latestCliTag({ gh }) {
    return gh([
        'release',
        'view',
        '--repo',
        REPO,
        '--json',
        'tagName',
        '--jq',
        '.tagName',
    ]);
}

export function latestDesktopTag({ gh }) {
    const json = gh(['api', `repos/${REPO}/releases?per_page=100`]);
    return pickLatestDesktop(JSON.parse(json));
}

export function installedStore({ exec = defaultExec } = {}) {
    if (process.platform !== 'win32') return null;
    const out = exec('powershell.exe', [
        ...PS_BASE,
        `Get-AppxPackage -Name ${STORE_PACKAGE} | Select-Object Name,Version,InstallLocation,PackageFullName | ConvertTo-Json -Compress`,
    ]);
    return parseAppx(out);
}

export function installedNsis({ exec = defaultExec } = {}) {
    if (process.platform !== 'win32') return null;
    const out = exec('powershell.exe', [
        ...PS_BASE,
        "(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Floe' -ErrorAction SilentlyContinue).DisplayVersion",
    ]);
    return parseDisplayVersion(out);
}

export function mainSha({ gh }) {
    return gh(['api', `repos/${REPO}/commits/main`, '--jq', '.sha']).trim();
}

/** true, false, or null on a 4xx compare (unknown sha, unrelated). */
export function compareTouches({ gh, base, head, dir }) {
    try {
        const json = gh([
            'api',
            `repos/${REPO}/compare/${base}...${head}`,
            '--jq',
            '[.files[].filename]',
        ]);
        return touchesDir(JSON.parse(json), dir);
    } catch {
        return null;
    }
}

export async function deployedWebSha({
    webSha,
    webShaFile,
    webUrl,
    fetchImpl,
    readFile = readFileSync,
}) {
    if (webSha) return { sha: webSha.toLowerCase(), oracle: '--web-sha' };
    if (webShaFile) {
        const sha = parseWebShaFile(readFile(webShaFile, 'utf8'));
        return { sha, oracle: `--web-sha-file ${path.basename(webShaFile)}` };
    }
    if (webUrl) {
        try {
            const res = await getJson(
                `${webUrl.replace(/\/+$/, '')}/api/config`,
                {
                    timeoutMs: 8000,
                    fetchImpl,
                }
            );
            const sha =
                res.json && typeof res.json.commit === 'string'
                    ? res.json.commit
                    : null;
            if (sha && /^[0-9a-f]{7,40}$/i.test(sha))
                return { sha: sha.toLowerCase(), oracle: '/api/config commit' };
            return { sha: null, oracle: '/api/config has no commit field yet' };
        } catch (e) {
            return {
                sha: null,
                oracle: `/api/config unreachable: ${e.message}`,
            };
        }
    }
    return { sha: null, oracle: 'not supplied' };
}

export function lastCommitTouching(root, dir, { exec = defaultExec } = {}) {
    try {
        const out = exec('git', ['log', '-1', '--format=%H %cI', '--', dir], {
            cwd: root,
        });
        const [sha, date] = out.split(' ');
        return sha ? { sha, date: date || null } : null;
    } catch {
        return null;
    }
}

export function localCommit(root, { exec = defaultExec } = {}) {
    try {
        const sha = exec('git', ['rev-parse', 'HEAD'], { cwd: root });
        const branch = exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: root,
        });
        return { sha, branch };
    } catch {
        return { sha: null, branch: null };
    }
}

/**
 * The oracle text of the CLI under test row, by how the binary was obtained:
 * a PATH install answers floe --version, a release download is checked
 * against checksums.txt, and a head build names the tree and sha it came
 * from ({ source, root, sha7, version } as resolveBuilds records them).
 */
export function cliUnderTestOracle(build) {
    if (!build) return null;
    if (build.source === 'path') return 'floe --version';
    if (build.source === 'go build') {
        const sha7 =
            build.sha7 ??
            (build.version ? String(build.version).replace(/^head-/, '') : '?');
        return `go build from ${build.root ?? '?'} (${sha7})`;
    }
    return 'checksums.txt sha256 match';
}

function row(surface, fields) {
    return {
        surface,
        installed: null,
        latest: null,
        oracle: null,
        status: 'UNKNOWN',
        gate: false,
        suggest: null,
        detail: {},
        ...fields,
    };
}

/**
 * collectVersions(opts) -> { rows, drift, latest, pathCli, mainSha, web,
 *   protocol, localCommit }
 * opts: { root, gh, exec, fetchImpl, webSha, webShaFile, serverSha, webUrl,
 *   serverUrl, cliUnderTest, desktopUnderTest, storeUsed, pin, profile,
 *   localSha7, webLocalSha7, log }
 * localSha7 is --root's HEAD; webLocalSha7 the HEAD of the checkout that
 * serves the web tree (--client-dir/..) on the head profile.
 */
export async function collectVersions(opts = {}) {
    const exec = opts.exec || defaultExec;
    const gh = opts.gh || makeGh(exec);
    const log = opts.log || (() => {});
    const rows = [];
    const safe = (fn, fallback = null) => {
        try {
            return fn();
        } catch (e) {
            log(`versions: ${e.message}`);
            return fallback;
        }
    };
    let ghOk = true;
    const latestCli = safe(() => latestCliTag({ gh }));
    if (!latestCli) ghOk = false;
    const latestDesktop = ghOk ? safe(() => latestDesktopTag({ gh })) : null;
    const main = ghOk ? safe(() => mainSha({ gh })) : null;
    const ghSuggest = ghOk ? null : 'gh auth login';

    // 1. CLI on PATH (INFO only).
    const onPath = safe(() => pathCli({ exec }), { path: null, version: null });
    const pathIsScoop = /scoop/i.test(onPath.path || '');
    rows.push(
        row('CLI on PATH', {
            installed: onPath.version
                ? `${onPath.version}${pathIsScoop ? ' (scoop)' : ''}`
                : null,
            latest: latestCli,
            oracle: 'floe --version; gh release view',
            status: (() => {
                const s = versionStatus(onPath.version, latestCli);
                return s === 'CURRENT' || s === 'STALE' ? s : s;
            })(),
            gate: false,
            suggest:
                versionStatus(onPath.version, latestCli) === 'STALE'
                    ? pathIsScoop
                        ? 'scoop bucket may lag; the audit side-loads the release'
                        : 'floe update'
                    : ghSuggest,
            detail: { path: onPath.path, version: onPath.version },
        })
    );

    // 2. CLI under test (gate).
    const cut = opts.cliUnderTest;
    if (cut) {
        const s =
            cut.version && cut.version.startsWith('head-')
                ? 'INFO'
                : versionStatus(cut.version, latestCli);
        rows.push(
            row('CLI under test', {
                installed: `${cut.version ?? '?'} (${cut.source ?? 'unknown'})`,
                latest:
                    opts.profile === 'head'
                        ? `local HEAD ${opts.localSha7 ?? ''}`.trim()
                        : latestCli,
                oracle: cut.oracle ?? cliUnderTestOracle(cut),
                status: opts.profile === 'head' ? 'INFO' : s,
                gate: opts.profile !== 'head',
                detail: { path: cut.path, sha256: cut.sha256 },
            })
        );
    } else {
        const usePath =
            !opts.pin &&
            onPath.version &&
            latestCli &&
            compareVersions(onPath.version, latestCli) === 0;
        rows.push(
            row('CLI under test', {
                installed: usePath
                    ? `${onPath.version} (path)`
                    : latestCli
                      ? `${latestCli.replace(/^v/, '')} (side-load planned)`
                      : null,
                latest: latestCli,
                oracle: usePath
                    ? 'floe --version'
                    : 'gh release download + checksums.txt',
                status: latestCli ? 'CURRENT' : 'UNKNOWN',
                gate: true,
                suggest: ghSuggest,
                detail: { usePath: Boolean(usePath), pin: Boolean(opts.pin) },
            })
        );
    }

    // 3. Desktop Store.
    const store = safe(() => installedStore({ exec }));
    const storeProduct = store ? inverseIdentity(store.version) : null;
    rows.push(
        row('Desktop Store', {
            installed: store
                ? `${storeProduct ?? '?'} (${store.version})`
                : null,
            latest: latestDesktop,
            oracle: 'Get-AppxPackage; releases API',
            status: versionStatus(storeProduct, latestDesktop),
            gate: Boolean(opts.storeUsed),
            suggest:
                versionStatus(storeProduct, latestDesktop) === 'STALE'
                    ? 'Microsoft Store > Library > Get updates'
                    : ghSuggest,
            detail: store,
        })
    );

    // 4. Desktop GitHub (NSIS).
    const nsis = safe(() => installedNsis({ exec }));
    rows.push(
        row('Desktop GitHub', {
            installed: nsis,
            latest: latestDesktop,
            oracle: 'HKCU Uninstall\\Floe',
            status: versionStatus(nsis, latestDesktop),
            gate: false,
            detail: { displayVersion: nsis },
        })
    );

    // 5. Desktop under test.
    const dut = opts.desktopUnderTest;
    if (dut) {
        const isHead = dut.version && String(dut.version).startsWith('head-');
        rows.push(
            row('Desktop under test', {
                installed: `${dut.kind ?? 'desktop'} ${dut.version ?? '?'}${dut.isPackaged === false ? ' (unpackaged)' : ''}`,
                latest:
                    opts.profile === 'head'
                        ? `local HEAD ${opts.localSha7 ?? ''}`.trim()
                        : latestDesktop,
                oracle:
                    dut.oracle ??
                    (dut.kind === 'store'
                        ? 'Get-AppxPackage'
                        : 'VerQueryValue; SHA256SUMS.txt'),
                status:
                    isHead || opts.profile === 'head'
                        ? 'INFO'
                        : versionStatus(dut.version, latestDesktop),
                gate: opts.profile !== 'head',
                detail: dut,
            })
        );
    } else {
        rows.push(
            row('Desktop under test', {
                installed: 'not used',
                latest: latestDesktop,
                oracle: '-',
                status: 'INFO',
                gate: false,
            })
        );
    }

    // 6. Web.
    const web = await deployedWebSha({
        webSha: opts.webSha,
        webShaFile: opts.webShaFile,
        webUrl: opts.profile === 'head' ? null : opts.webUrl,
        fetchImpl: opts.fetchImpl,
        readFile: opts.readFile,
    });
    let webTouched = null;
    if (
        web.sha &&
        main &&
        !main.startsWith(web.sha) &&
        !web.sha.startsWith(short(main))
    )
        webTouched = compareTouches({
            gh,
            base: web.sha,
            head: main,
            dir: 'client',
        });
    const webStatus =
        opts.profile === 'head'
            ? 'INFO'
            : commitCurrency({ deployed: web.sha, main, touched: webTouched });
    rows.push(
        row('Web floe.one', {
            installed:
                opts.profile === 'head'
                    ? `local HEAD ${opts.webLocalSha7 ?? opts.localSha7 ?? ''}`.trim()
                    : (short(web.sha) ?? 'unknown'),
            latest: main ? `main ${short(main)}` : null,
            oracle: `${web.oracle}; gh compare`,
            status: webStatus,
            gate: opts.profile !== 'head',
            suggest:
                webStatus === 'STALE'
                    ? 'redeploy is automatic on main; check the Vercel deployment list'
                    : webStatus === 'UNKNOWN'
                      ? 'pass --web-sha from the Vercel deployment'
                      : ghSuggest,
            detail: { deployed: web.sha, main, touched: webTouched },
        })
    );

    // 7. Server.
    const serverSha = opts.serverSha || null;
    let serverStatus = 'INFO';
    let serverInstalled = null;
    let serverSuggest = null;
    let serverDetail = {};
    if (serverSha) {
        const touched =
            main &&
            !main.startsWith(serverSha) &&
            !serverSha.startsWith(short(main))
                ? compareTouches({
                      gh,
                      base: serverSha,
                      head: main,
                      dir: 'server',
                  })
                : false;
        serverStatus = commitCurrency({ deployed: serverSha, main, touched });
        serverInstalled = short(serverSha);
        serverDetail = { sha: serverSha, main, touched };
        if (serverStatus === 'STALE')
            serverSuggest =
                'owner: ssh floe-azure, git pull && pm2 restart (printed, never executed)';
    } else if (opts.serverUrl && opts.profile !== 'head') {
        let uptime = null;
        try {
            const res = await getJson(
                `${opts.serverUrl.replace(/\/+$/, '')}/health`,
                {
                    timeoutMs: 8000,
                    fetchImpl: opts.fetchImpl,
                }
            );
            uptime = Number(res.json?.uptime);
            if (!Number.isFinite(uptime)) uptime = null;
        } catch (e) {
            log(`versions: /health ${e.message}`);
        }
        const last = opts.root
            ? lastCommitTouching(opts.root, 'server', { exec })
            : null;
        const startedAt =
            uptime !== null ? new Date(Date.now() - uptime * 1000) : null;
        const older =
            startedAt && last?.date
                ? startedAt.getTime() < Date.parse(last.date)
                : null;
        serverInstalled =
            uptime !== null
                ? `unknown (up ${(uptime / 86400).toFixed(1)} d)`
                : 'unknown';
        serverSuggest = older
            ? `process older than last server/ commit ${short(last.sha)} ${last.date}`
            : last
              ? `server/ last changed ${short(last.sha)}`
              : null;
        serverDetail = {
            uptimeS: uptime,
            processStartedAt: startedAt?.toISOString() ?? null,
            lastServerCommit: last,
            olderThanLastCommit: older,
        };
    } else {
        serverInstalled =
            opts.profile === 'head'
                ? `local HEAD ${opts.localSha7 ?? ''}`.trim()
                : 'unknown';
    }
    rows.push(
        row('Server api.floe.one', {
            installed: serverInstalled,
            latest: main ? `main ${short(main)}` : null,
            oracle: serverSha
                ? '--server-sha; gh compare'
                : 'ssh rev-parse not supplied',
            status: serverStatus,
            gate: Boolean(serverSha),
            suggest: serverSuggest,
            detail: serverDetail,
        })
    );

    // 8. Protocol parity.
    let protocol = { go: {}, ts: {}, desktop: null, status: 'UNKNOWN' };
    if (opts.root) {
        const goPath = path.join(
            opts.root,
            'cli',
            'engine',
            'transfer',
            'protocol.go'
        );
        const tsPath = path.join(
            opts.root,
            'client',
            'lib',
            'transfer',
            'protocol.ts'
        );
        const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
        protocol = protocolParity(
            read(goPath),
            read(tsPath),
            opts.desktopProtocol ?? null
        );
    }
    rows.push(
        row('Protocol', {
            installed: `go ${protocol.go.pv ?? '?'}/${protocol.go.pvMin ?? '?'}, ts ${protocol.ts.pv ?? '?'}/${protocol.ts.pvMin ?? '?'}${protocol.desktop !== null && protocol.desktop !== undefined ? `, desktop ${protocol.desktop}` : ''}`,
            latest: '-',
            oracle:
                'source diff' +
                (protocol.desktop !== null && protocol.desktop !== undefined
                    ? ' + About row'
                    : ''),
            status: protocol.status,
            gate: true,
            suggest:
                protocol.status === 'DRIFT'
                    ? 'open an issue: protocol constants differ'
                    : null,
            detail: protocol,
        })
    );

    const local = opts.root
        ? localCommit(opts.root, { exec })
        : { sha: null, branch: null };
    return {
        rows,
        drift: gatingDrift(rows),
        latest: { cli: latestCli, desktop: latestDesktop },
        pathCli: onPath,
        mainSha: main,
        web,
        protocol,
        localCommit: local,
        ghOk,
    };
}
