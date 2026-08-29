// WSL sender adapter for the transfer-audit skill: the linux_amd64 CLI
// inside Ubuntu-22.04 sends to a Windows receiver, which is the one
// non-loopback direct path a single machine can offer. Everything runs
// through wsl.exe with an explicit -d (the default distro here is
// docker-desktop). Nothing is passed through a Windows shell, but wsl.exe
// hands whatever follows `--` to the distro's LOGIN shell, so every
// passthrough is either a single pre-quoted command string (the leg) or a
// metacharacter-free path (the side-load, which checks). WSL reaches the
// Windows host at its default-route IP; Windows `localhost` does not work
// from inside WSL, so a LOOPBACK server or web URL is rewritten to
// http://<hostIp>:3001. Production URLs need no rewriting, and the host IP
// is then never resolved at all.
//
// preflight() never starts WSL: `wsl.exe -l -v` lists distros without
// booting one, and a stopped Ubuntu-22.04 is reported as `wsl-stopped` for the
// operator to start. hostIp() and sideload() do run commands inside the
// distro; the run calls sideload() once before the WSL cells and hostIp()
// lazily, so neither is gated on preflight.
//
// The leg itself is a CliLeg in disguise: lib/cli.mjs is imported lazily and
// its buildArgs, buildEnv, parsers and lifecycle are reused unchanged; only
// the binary (wsl.exe), the argv prefix and the path/URL translation differ.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Leg, PhaseError } from './surfaces.mjs';
import { REPO } from './versions.mjs';

export const DISTRO = 'Ubuntu-22.04';
export const WSL_EXE = 'wsl.exe';
/** Linux-side root for side-loaded binaries: <WSL_ROOT>/<tag>/floe. */
// /var/tmp, not /tmp: the distro runs systemd, whose tmpfiles rule
// 'D /tmp 1777 root root -' empties /tmp on every boot, and WSL stops an
// idle distro about 8 s after its last process exits, so a binary put under
// /tmp between two cells was gone by the third (measured 2026-08-29).
export const WSL_ROOT = '/var/tmp/floe-lta';
export const CLI_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

// ------------------------------------------------------------- exec seam

/**
 * Default exec: never throws on a non-zero exit; ENOENT and timeouts come
 * back as { code: null, error }. stdout/stderr are Buffers so that wsl.exe's
 * UTF-16 listing can be decoded by the caller.
 */
export function defaultExec(
    file,
    args,
    { timeout = 60_000, cwd, verbatim = false } = {}
) {
    return new Promise((resolve) => {
        execFile(
            file,
            args,
            {
                encoding: 'buffer',
                windowsHide: true,
                timeout,
                cwd,
                maxBuffer: 16 * 1024 * 1024,
                // wsl.exe hands its command line to the distro's login
                // shell, so a pre-quoted single argument must reach it
                // unmangled by the Windows quoting rules.
                windowsVerbatimArguments: Boolean(verbatim),
            },
            (err, stdout, stderr) => {
                resolve({
                    code: err
                        ? typeof err.code === 'number'
                            ? err.code
                            : null
                        : 0,
                    error: err ? err.message : null,
                    stdout: stdout ?? Buffer.alloc(0),
                    stderr: stderr ?? Buffer.alloc(0),
                });
            }
        );
    });
}

// --------------------------------------------------------- pure parsers

/** wsl.exe prints UTF-16LE; detect it by the NUL bytes and decode. */
export function decodeWslOutput(data) {
    if (data == null) return '';
    if (typeof data === 'string')
        return data.replace(/\u0000/g, '').replace(/^\uFEFF/, '');
    const buf = Buffer.from(data);
    let text;
    if (buf.length >= 2 && buf.includes(0)) text = buf.toString('utf16le');
    else text = buf.toString('utf8');
    return text.replace(/^\uFEFF/, '').replace(/\u0000/g, '');
}

/** `wsl -l -v` -> [{ name, state, version, default }] (header dropped). */
export function parseWslList(text) {
    const rows = [];
    for (const raw of decodeWslOutput(text).split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (!line.trim()) continue;
        if (/^\s*\*?\s*NAME\b/i.test(line)) continue;
        const m = /^\s*(\*)?\s*(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(line);
        if (!m) continue;
        rows.push({
            name: m[2],
            state: m[3],
            version: Number(m[4]),
            default: m[1] === '*',
        });
    }
    return rows;
}

/** { present, state, version, default } for one distro name. */
export function distroStatus(rows, distro = DISTRO) {
    const row = rows.find((r) => r.name.toLowerCase() === distro.toLowerCase());
    if (!row)
        return { present: false, state: null, version: null, default: false };
    return {
        present: true,
        state: row.state,
        version: row.version,
        default: row.default,
    };
}

/**
 * The host IP from `ip route show default` (`default via <ip> dev eth0 ...`),
 * or a line that is only an IP. The command is passed to wsl.exe verbatim
 * (HOST_IP_ARGS): wsl.exe hands the raw command line to the distro's login
 * shell, so a `$` in a passthrough command is expanded by that shell before
 * `sh -c` sees it (`awk '{print $3}'` became `awk '{print }'` on 2026-08-29
 * and echoed the whole route line).
 */
export const HOST_IP_ARGS = Object.freeze(['ip', 'route', 'show', 'default']);
export function parseHostIp(text) {
    for (const line of decodeWslOutput(text).split(/\r?\n/)) {
        const via = /^\s*default\s+via\s+((?:\d{1,3}\.){3}\d{1,3})\b/.exec(
            line
        );
        if (via) return via[1];
        const m = /^\s*((?:\d{1,3}\.){3}\d{1,3})\s*$/.exec(line);
        if (m) return m[1];
    }
    return null;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * The server URL as seen from WSL: a loopback host becomes the Windows
 * host's IP (same scheme and port); anything else is returned unchanged
 * minus a trailing slash. Never yields localhost.
 */
export function serverUrlFor(server, hostIp) {
    const text = String(server || '')
        .trim()
        .replace(/\/+$/, '');
    if (!text) throw new PhaseError('start', 'wsl: infra.server is empty');
    let url;
    try {
        url = new URL(text);
    } catch {
        throw new PhaseError(
            'start',
            `wsl: infra.server is not a URL: ${text}`
        );
    }
    if (!LOOPBACK.has(url.hostname.toLowerCase())) return text;
    if (!hostIp)
        throw new PhaseError(
            'start',
            `wsl: ${text} is loopback and no host IP is known`
        );
    url.hostname = hostIp;
    return url.toString().replace(/\/+$/, '');
}

/**
 * True when a leg's infra needs the Windows host IP: only a loopback server
 * or web URL does. On the shipped profile (production URLs) it is false, so
 * the host-IP probe is never run and can never fail the cell.
 */
export function needsHostIp(infra = {}) {
    for (const u of [infra && infra.server, infra && infra.web]) {
        if (!u) continue;
        let host;
        try {
            host = new URL(String(u).trim()).hostname.toLowerCase();
        } catch {
            continue;
        }
        if (LOOPBACK.has(host)) return true;
    }
    return false;
}

/** C:\a\b -> /mnt/c/a/b. UNC and relative paths are refused. */
export function toWslPath(winPath) {
    const p = String(winPath || '');
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
    if (!m)
        throw new PhaseError('start', `wsl: not an absolute drive path: ${p}`);
    const rest = m[2]
        .split(/[\\/]+/)
        .filter(Boolean)
        .join('/');
    return `/mnt/${m[1].toLowerCase()}/${rest}`;
}

/** { version, asset, checksums } for a CLI tag (GoReleaser names). */
export function assetNames(tag) {
    const m = CLI_TAG.exec(tag || '');
    if (!m) throw new PhaseError('start', `wsl: not a CLI tag: ${tag}`);
    const version = `${m[1]}.${m[2]}.${m[3]}`;
    return {
        version,
        asset: `floe_${version}_linux_amd64.tar.gz`,
        checksums: 'checksums.txt',
    };
}

/** Linux-side locations for a tag. */
export function linuxPaths(tag, root = WSL_ROOT) {
    return { dir: `${root}/${tag}`, bin: `${root}/${tag}/floe` };
}

/** POSIX single-quoting for the distro's login shell. */
export function shellQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
const sq = shellQuote;

/**
 * The sh script that verifies and extracts inside WSL. Single-quoted paths
 * only, so the Windows command line never needs escaping; written to a
 * file under the download dir and run as `sh <file>` to keep quoting out
 * of the picture entirely. sha256sum -c --ignore-missing checks only the
 * assets present in the dir, which is exactly the downloaded tarball.
 */
export function sideloadScript({ tag, wslDir, root = WSL_ROOT }) {
    const { asset, checksums } = assetNames(tag);
    const lx = linuxPaths(tag, root);
    return [
        'set -eu',
        `cd ${sq(wslDir)}`,
        `sha256sum -c --ignore-missing ${sq(checksums)}`,
        `rm -rf ${sq(lx.dir)}`,
        `mkdir -p ${sq(lx.dir)}`,
        `tar -xzf ${sq(asset)} -C ${sq(lx.dir)}`,
        `test -f ${sq(lx.bin)}`,
        `chmod +x ${sq(lx.bin)}`,
        `FLOE_NO_UPDATE_CHECK=1 ${sq(lx.bin)} --version`,
        '',
    ].join('\n');
}

/** { ok, line } from sha256sum -c output for one asset. */
export function parseChecksumVerify(text, asset) {
    const lines = decodeWslOutput(text).split(/\r?\n/);
    const line = lines.find((l) => l.startsWith(`${asset}: `)) ?? null;
    return { ok: Boolean(line && /:\s*OK\s*$/.test(line)), line };
}

export function parseFloeVersion(text) {
    const m = /^floe (\S+)\s*$/m.exec(decodeWslOutput(text));
    return m ? m[1] : null;
}

/** WSLENV keeps the Windows-side names WSL should forward. */
export function mergeWslEnv(existing, names) {
    const parts = String(existing || '')
        .split(':')
        .filter(Boolean);
    for (const name of names) {
        if (!parts.some((p) => p.split('/')[0] === name)) parts.push(name);
    }
    return parts.join(':');
}

/**
 * The wsl.exe invocation for a sender leg, built from lib/cli.mjs's own
 * buildArgs and buildEnv. argv is the logical `-d <distro> -- <linuxBin>
 * send <files as /mnt/c/...> --server <url as seen from WSL> [--web ...]
 * [--no-relay]`; spawnArgs is what actually runs: the same words after
 * `--` joined into ONE single-quoted command string, passed verbatim,
 * because wsl.exe hands the raw command line to the distro's login shell
 * (an unquoted backslash or `$` never survives it; measured 2026-08-29).
 */
export function buildWslInvocation(
    opts,
    {
        hostIp,
        linuxBin,
        distro = DISTRO,
        buildArgs,
        buildEnv,
        baseEnv = process.env,
    }
) {
    if (opts.role !== 'sender')
        throw new PhaseError('start', 'wsl: sender only (CAPABILITIES.wsl)');
    if (!linuxBin)
        throw new PhaseError(
            'start',
            'wsl: linux binary path is required (opts.wslBin or build.wslBin, set by the side-load)'
        );
    const infra = opts.infra || {};
    const server = serverUrlFor(infra.server, hostIp);
    const web = infra.web ? serverUrlFor(infra.web, hostIp) : undefined;
    const files = (opts.files || []).map(toWslPath);
    const cliOpts = {
        ...opts,
        files,
        infra: { ...infra, server, web },
        bin: WSL_EXE,
        label: opts.label ?? 'wsl-sender',
    };
    const words = [linuxBin, ...buildArgs(cliOpts)];
    const argv = ['-d', distro, '--', ...words];
    const command = words.map(sq).join(' ');
    const spawnArgs = ['-d', distro, '--', command];
    const env = { ...buildEnv(cliOpts, baseEnv) };
    env.WSLENV = mergeWslEnv(baseEnv.WSLENV, [
        'FLOE_NO_UPDATE_CHECK',
        'PION_LOG_TRACE',
    ]);
    return {
        cliOpts,
        argv,
        spawnArgs,
        command,
        verbatim: true,
        env,
        server,
        files,
    };
}

// ---------------------------------------------------------- operations

/**
 * { ok, reason, detail } from `wsl.exe -l -v` only. Reasons: windows-only,
 * wsl-missing, distro-missing, wsl-stopped. Never boots a distro.
 */
export async function preflight(opts = {}) {
    const exec = opts.exec ?? defaultExec;
    const distro = opts.distro ?? DISTRO;
    const detail = { distro };
    if (process.platform !== 'win32' && !opts.exec)
        return { ok: false, reason: 'windows-only', detail };
    const r = await exec(WSL_EXE, ['-l', '-v'], { timeout: 15_000 });
    if (r.code === null && r.error)
        return {
            ok: false,
            reason: 'wsl-missing',
            detail: { ...detail, error: r.error },
        };
    const rows = parseWslList(r.stdout);
    if (!rows.length && r.error)
        return {
            ok: false,
            reason: 'wsl-missing',
            detail: { ...detail, error: r.error },
        };
    detail.distros = rows;
    const st = distroStatus(rows, distro);
    detail.state = st.state;
    if (!st.present) return { ok: false, reason: 'distro-missing', detail };
    if (!/^running$/i.test(st.state || ''))
        return { ok: false, reason: 'wsl-stopped', detail };
    return { ok: true, reason: null, detail };
}

/** The Windows host as WSL sees it (runs inside the distro). */
export async function hostIp(opts = {}) {
    const exec = opts.exec ?? defaultExec;
    const distro = opts.distro ?? DISTRO;
    const r = await exec(WSL_EXE, ['-d', distro, '--', ...HOST_IP_ARGS], {
        timeout: 30_000,
    });
    const ip = parseHostIp(r.stdout);
    if (!ip)
        throw new PhaseError(
            'start',
            `wsl: no default route IP from ${distro} (code ${r.code}): stdout ${JSON.stringify(decodeWslOutput(r.stdout).trim().slice(0, 160))} stderr ${JSON.stringify(decodeWslOutput(r.stderr).trim().slice(0, 160))}`
        );
    return ip;
}

/**
 * Download floe_<ver>_linux_amd64.tar.gz and checksums.txt with gh into
 * dir (skipping files already there), verify with sha256sum -c inside WSL
 * over /mnt/c, extract to <WSL_ROOT>/<tag>, and read the binary's version.
 * Returns { tag, version, asset, dir, wslDir, linuxBin, verified, floeVersion, script }.
 */
export async function sideload({
    tag,
    dir,
    exec = defaultExec,
    distro = DISTRO,
    // Pinned like every other download in the run: without it `gh release
    // download` picks the repo from the process working directory, and the
    // checksum cannot catch a wrong one (checksums.txt ships in the same
    // release).
    repo = REPO,
    root = WSL_ROOT,
}) {
    const names = assetNames(tag);
    if (!dir || !path.isAbsolute(dir))
        throw new PhaseError('start', 'wsl sideload: dir must be absolute');
    mkdirSync(dir, { recursive: true });
    const assetPath = path.join(dir, names.asset);
    const sumsPath = path.join(dir, names.checksums);
    let downloaded = false;
    if (!existsSync(assetPath) || !existsSync(sumsPath)) {
        const args = [
            'release',
            'download',
            tag,
            '--pattern',
            names.asset,
            '--pattern',
            names.checksums,
            '--dir',
            dir,
            '--skip-existing',
        ];
        args.push('--repo', repo);
        const r = await exec('gh', args, { timeout: 300_000 });
        if (r.code !== 0) {
            throw new PhaseError(
                'start',
                `wsl sideload: gh release download failed (code ${r.code}): ${decodeWslOutput(r.stderr).trim() || r.error}`
            );
        }
        downloaded = true;
    }
    const wslDir = toWslPath(dir);
    const script = sideloadScript({ tag, wslDir, root });
    const scriptPath = path.join(dir, `sideload-${tag}.sh`);
    writeFileSync(scriptPath, script.replace(/\r\n/g, '\n'));
    // Same transport as the leg: one pre-quoted command string passed
    // verbatim, so a download dir with a space, a quote or a $ survives the
    // distro's login shell instead of turning every WSL cell into a SKIP.
    const wslScript = toWslPath(scriptPath);
    const r = await exec(
        WSL_EXE,
        ['-d', distro, '--', `sh ${shellQuote(wslScript)}`],
        { timeout: 300_000, verbatim: true }
    );
    const out = decodeWslOutput(r.stdout) + '\n' + decodeWslOutput(r.stderr);
    const verify = parseChecksumVerify(out, names.asset);
    if (r.code !== 0 || !verify.ok) {
        throw new PhaseError(
            'start',
            `wsl sideload: verify or extract failed (code ${r.code}); sha256sum said: ${verify.line ?? '(no line)'}`,
            {
                output: out.trim(),
            }
        );
    }
    const lx = linuxPaths(tag, root);
    return {
        tag,
        version: names.version,
        asset: names.asset,
        dir,
        wslDir,
        linuxBin: lx.bin,
        verified: true,
        downloaded,
        floeVersion: parseFloeVersion(out),
        script: scriptPath,
        checksumLine: verify.line,
    };
}

// ---------------------------------------------------------------- leg

/**
 * WslLeg: a sender-only Leg that delegates to a lib/cli.mjs CliLeg running
 * `wsl.exe -d Ubuntu-22.04 -- <linuxBin> send ...`. The CliLeg's markers,
 * transcript, refusal classes and killTree (which sees a wsl.exe image it
 * started) all apply unchanged.
 */
export class WslLeg extends Leg {
    constructor(opts) {
        super(opts);
        this.surface = 'wsl';
        this.distro = opts.distro ?? DISTRO;
        // The Linux path the run side-loaded (build.wslBin); a Windows exe
        // path can never run inside the distro, so build.path is not a
        // fallback (the 2026-08-29 deep run tried exactly that).
        this.linuxBin =
            opts.wslBin ?? (opts.build && opts.build.wslBin) ?? null;
        this.ip = opts.hostIp ?? null;
        this.inner = null;
        this.invocation = null;
    }

    async start() {
        const cli = await import('./cli.mjs');
        // Only a loopback URL needs the host IP (head profile). Resolving it
        // unconditionally made a probe that the shipped profile never uses a
        // failure point for all three L2 cells (2026-08-29).
        if (!this.ip && needsHostIp(this.opts.infra))
            this.ip = await hostIp({
                distro: this.distro,
                exec: this.opts.exec,
            });
        this.invocation = buildWslInvocation(this.opts, {
            hostIp: this.ip,
            linuxBin: this.linuxBin,
            distro: this.distro,
            buildArgs: cli.buildArgs,
            buildEnv: cli.buildEnv,
            baseEnv: this.opts.baseEnv ?? process.env,
        });
        const inner = new cli.CliLeg(this.invocation.cliOpts);
        inner.bin = WSL_EXE;
        inner.argv = this.invocation.spawnArgs;
        inner.verbatim = true;
        inner.env = this.invocation.env;
        this.inner = inner;
        await inner.start();
        this.notes.push(
            `wsl sender via ${this.distro}: ${this.linuxBin} -> ${this.invocation.server}`
        );
        return this;
    }

    async code() {
        return this.inner ? this.inner.code() : null;
    }

    async link() {
        if (!this.inner) throw new PhaseError('link', 'wsl: not started');
        return this.inner.link();
    }

    async awaitConnected(timeoutMs) {
        if (!this.inner) throw new PhaseError('connect', 'wsl: not started');
        return this.inner.awaitConnected(timeoutMs);
    }

    route() {
        try {
            return this.inner ? this.inner.route() : null;
        } catch {
            return null;
        }
    }

    async awaitDone(timeoutMs) {
        if (!this.inner) throw new PhaseError('done', 'wsl: not started');
        return this.inner.awaitDone(timeoutMs);
    }

    async outputs() {
        return [];
    }

    async stop(reason) {
        await super.stop(reason);
        if (this.inner) await this.inner.stop(reason);
    }

    evidence() {
        const base = this.inner
            ? this.inner.evidence()
            : { statsProof: null, notes: [] };
        return {
            ...base,
            surface: 'wsl',
            distro: this.distro,
            hostIp: this.ip,
            linuxBin: this.linuxBin,
            server: this.invocation ? this.invocation.server : null,
            files: this.invocation ? this.invocation.files : null,
            statsProof: null,
            notes: [...(base.notes || []), ...this.notes],
        };
    }
}

export function createLeg(opts) {
    return new WslLeg(opts);
}
