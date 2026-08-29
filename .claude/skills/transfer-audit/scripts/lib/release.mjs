// Release side-load and HEAD builds. The shipped profile tests the latest
// release bits: `gh release download <tag>` by an explicitly resolved tag
// (never "latest", which can move between two calls), the asset verified
// against checksums.txt (CLI, written by GoReleaser) or SHA256SUMS.txt
// (desktop, LF with CR stripped just in case), then extracted with the
// zip reader in lib/fixtures.mjs. The CLI path must never contain
// scoop|winget|homebrew|cellar: cli/internal/selfupdate refuses to update
// a managed install by looking at those substrings, and a side-loaded
// binary under such a path would misreport itself.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    extractZipEntry,
    readCentralDirectory,
    readZipEntry,
    sha256OfFile,
} from './fixtures.mjs';
import {
    CLI_TAG_RE,
    DESKTOP_TAG_RE,
    REPO,
    checksumFor,
    defaultExec,
    makeGh,
} from './versions.mjs';

export const MANAGED_PATH_RE = /scoop|winget|homebrew|cellar/i;
const WIN = process.platform === 'win32';

export function cliZipName(version) {
    return `floe_${version}_windows_amd64.zip`;
}
export function cliTarName(version) {
    return `floe_${version}_linux_amd64.tar.gz`;
}
export function desktopZipName(version) {
    return `floe-desktop-${version}-windows-amd64.zip`;
}

export function versionOfTag(tag) {
    const m = CLI_TAG_RE.exec(tag) || DESKTOP_TAG_RE.exec(tag);
    return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

export function assertSafeCliPath(p) {
    if (MANAGED_PATH_RE.test(String(p)))
        throw new Error(
            `refusing CLI path ${p}: it contains scoop|winget|homebrew|cellar (selfupdate treats it as a managed install)`
        );
    return p;
}

/**
 * selectCli({ pathVersion, latestTag, pin }) -> { source, reason }
 * Prefer the floe on PATH when its version equals the latest tag (a real
 * install, already past the firewall consent), else side-load.
 */
export function selectCli({ pathVersion, latestTag, pin = false }) {
    const want = versionOfTag(latestTag);
    if (pin) return { source: 'sideload', reason: '--pin' };
    if (!pathVersion) return { source: 'sideload', reason: 'no floe on PATH' };
    if (!want)
        return {
            source: 'sideload',
            reason: `latest tag ${latestTag} is not vX.Y.Z`,
        };
    if (pathVersion === want)
        return { source: 'path', reason: `PATH floe is ${want}` };
    return {
        source: 'sideload',
        reason: `PATH floe is ${pathVersion}, latest is ${want}`,
    };
}

export function sha256Sync(file) {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** gh release download <tag> --repo REPO --dir dir --pattern ... */
export function downloadRelease({ tag, dir, patterns, gh }) {
    mkdirSync(dir, { recursive: true });
    const args = [
        'release',
        'download',
        tag,
        '--repo',
        REPO,
        '--dir',
        dir,
        '--clobber',
    ];
    for (const p of patterns) args.push('--pattern', p);
    gh(args);
    return dir;
}

/** Verify <dir>/<assetName> against <dir>/<checksumFile>; returns the sha. */
export function verifyAsset({ dir, assetName, checksumFile }) {
    const asset = path.join(dir, assetName);
    if (!existsSync(asset))
        throw new Error(`asset missing after download: ${asset}`);
    const sums = readFileSync(path.join(dir, checksumFile), 'utf8');
    const want = checksumFor(sums, assetName);
    const got = sha256Sync(asset);
    if (got !== want)
        throw new Error(
            `checksum mismatch for ${assetName}: ${checksumFile} says ${want}, file is ${got}`
        );
    return got;
}

export function zipHas(buf, name) {
    return readCentralDirectory(buf).names.includes(name);
}

/**
 * sideloadCli({ tag, dest, gh }) ->
 *   { tag, version, path, sha256, zip, zipSha256 }
 * dest is a directory; the exe lands at <dest>/floe-<version>/floe.exe.
 */
export function sideloadCli({ tag, dest, gh = makeGh() }) {
    const version = versionOfTag(tag);
    if (!version || !CLI_TAG_RE.test(tag))
        throw new Error(`sideloadCli wants a vX.Y.Z tag, got ${tag}`);
    assertSafeCliPath(dest);
    const dir = path.join(dest, `floe-${version}`);
    const exe = path.join(dir, WIN ? 'floe.exe' : 'floe');
    const zipName = cliZipName(version);
    if (
        existsSync(exe) &&
        existsSync(path.join(dir, zipName)) &&
        existsSync(path.join(dir, 'checksums.txt'))
    ) {
        const zipSha256 = verifyAsset({
            dir,
            assetName: zipName,
            checksumFile: 'checksums.txt',
        });
        // The zip is what checksums.txt vouches for; the exe on disk is
        // only trusted while it is byte-identical to the zip's entry
        // (findStagedDesktop does the same for the desktop exe). A
        // tampered or truncated exe is re-extracted, never run.
        const buf = readFileSync(path.join(dir, zipName));
        const entry = WIN ? 'floe.exe' : 'floe';
        if (!zipHas(buf, entry))
            throw new Error(`${zipName} has no ${entry} entry`);
        const entrySha = createHash('sha256')
            .update(readZipEntry(buf, entry).data)
            .digest('hex');
        let sha256 = sha256Sync(exe);
        const reextracted = sha256 !== entrySha;
        if (reextracted) sha256 = extractZipEntry(buf, entry, exe).sha256;
        return {
            tag,
            version,
            path: exe,
            sha256,
            zip: path.join(dir, zipName),
            zipSha256,
            reused: !reextracted,
            reextracted,
        };
    }
    downloadRelease({ tag, dir, patterns: [zipName, 'checksums.txt'], gh });
    const zipSha256 = verifyAsset({
        dir,
        assetName: zipName,
        checksumFile: 'checksums.txt',
    });
    const buf = readFileSync(path.join(dir, zipName));
    const entry = WIN ? 'floe.exe' : 'floe';
    if (!zipHas(buf, entry))
        throw new Error(`${zipName} has no ${entry} entry`);
    const { sha256 } = extractZipEntry(buf, entry, exe);
    return {
        tag,
        version,
        path: exe,
        sha256,
        zip: path.join(dir, zipName),
        zipSha256,
        reused: false,
        reextracted: false,
    };
}

/**
 * sideloadDesktop({ tag, dest, gh }) ->
 *   { tag, version, path, sha256, zip, zipSha256, isPackaged: false }
 */
export function sideloadDesktop({ tag, dest, gh = makeGh() }) {
    const version = versionOfTag(tag);
    if (!version || !DESKTOP_TAG_RE.test(tag))
        throw new Error(
            `sideloadDesktop wants a desktop-vX.Y.Z tag, got ${tag}`
        );
    const dir = path.join(dest, `floe-desktop-${version}`);
    const exe = path.join(dir, 'floe-desktop.exe');
    const zipName = desktopZipName(version);
    if (
        !(
            existsSync(exe) &&
            existsSync(path.join(dir, zipName)) &&
            existsSync(path.join(dir, 'SHA256SUMS.txt'))
        )
    )
        downloadRelease({
            tag,
            dir,
            patterns: [zipName, 'SHA256SUMS.txt'],
            gh,
        });
    const zipSha256 = verifyAsset({
        dir,
        assetName: zipName,
        checksumFile: 'SHA256SUMS.txt',
    });
    let sha256;
    if (existsSync(exe)) sha256 = sha256Sync(exe);
    else {
        const buf = readFileSync(path.join(dir, zipName));
        if (!zipHas(buf, 'floe-desktop.exe'))
            throw new Error(`${zipName} has no floe-desktop.exe entry`);
        sha256 = extractZipEntry(buf, 'floe-desktop.exe', exe).sha256;
        if (zipHas(buf, 'LICENSE'))
            extractZipEntry(buf, 'LICENSE', path.join(dir, 'LICENSE'));
    }
    return {
        tag,
        version,
        path: exe,
        sha256,
        zip: path.join(dir, zipName),
        zipSha256,
        isPackaged: false,
    };
}

/**
 * findStagedDesktop(binDir, tag) -> { tag, version, path, sha256, zip,
 *   zipSha256, verified, layout, isPackaged: false } or null.
 * An already extracted portable exe under binDir, in either layout:
 * sideloadDesktop's <binDir>/floe-desktop-<ver>/floe-desktop.exe or a
 * by-hand <binDir>/<tag>/extracted/floe-desktop.exe next to the zip and
 * SHA256SUMS.txt. verified is true only when the zip matches SHA256SUMS.txt
 * and the exe on disk matches the zip's floe-desktop.exe entry; a checksum
 * mismatch throws, a missing zip or sums file leaves verified false.
 */
export function findStagedDesktop(binDir, tag) {
    const version = versionOfTag(tag);
    if (!binDir || !version || !DESKTOP_TAG_RE.test(tag)) return null;
    const zipName = desktopZipName(version);
    const layouts = [
        {
            layout: 'sideload',
            dir: path.join(binDir, `floe-desktop-${version}`),
            exe: path.join(
                binDir,
                `floe-desktop-${version}`,
                'floe-desktop.exe'
            ),
        },
        {
            layout: 'extracted',
            dir: path.join(binDir, tag),
            exe: path.join(binDir, tag, 'extracted', 'floe-desktop.exe'),
        },
    ];
    for (const l of layouts) {
        if (!existsSync(l.exe)) continue;
        const zip = path.join(l.dir, zipName);
        const hasZip = existsSync(zip);
        const hasSums = existsSync(path.join(l.dir, 'SHA256SUMS.txt'));
        const sha256 = sha256Sync(l.exe);
        let zipSha256 = null;
        let verified = false;
        if (hasZip && hasSums) {
            zipSha256 = verifyAsset({
                dir: l.dir,
                assetName: zipName,
                checksumFile: 'SHA256SUMS.txt',
            });
            const entry = readZipEntry(readFileSync(zip), 'floe-desktop.exe');
            const entrySha = createHash('sha256')
                .update(entry.data)
                .digest('hex');
            if (entrySha !== sha256)
                throw new Error(
                    `${l.exe} (${sha256.slice(0, 8)}) is not the floe-desktop.exe inside ${zipName} (${entrySha.slice(0, 8)})`
                );
            verified = true;
        }
        return {
            tag,
            version,
            path: l.exe,
            sha256,
            zip: hasZip ? zip : null,
            zipSha256,
            verified,
            layout: l.layout,
            isPackaged: false,
        };
    }
    return null;
}

/** Download the Linux tarball for the WSL cell (extraction happens in WSL). */
export function downloadLinuxCli({ tag, dest, gh = makeGh() }) {
    const version = versionOfTag(tag);
    const dir = path.join(dest, `floe-${version}-linux`);
    const tarName = cliTarName(version);
    downloadRelease({ tag, dir, patterns: [tarName, 'checksums.txt'], gh });
    const sha256 = verifyAsset({
        dir,
        assetName: tarName,
        checksumFile: 'checksums.txt',
    });
    return {
        tag,
        version,
        tar: path.join(dir, tarName),
        checksums: path.join(dir, 'checksums.txt'),
        sha256,
    };
}

export function gitSha7(root, { exec = defaultExec } = {}) {
    return exec('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root });
}

/**
 * buildHeadCli({ root, sha7, binDir, exec }) -> { path, version, sha256 }
 * go build -ldflags "-X main.version=head-<sha7>" -o <bin> ./cmd/floe in
 * <root>/cli. The ldflags value is one argv element, so no shell quoting.
 */
export async function buildHeadCli({ root, sha7, binDir, exec = defaultExec }) {
    const version = `head-${sha7}`;
    assertSafeCliPath(binDir);
    mkdirSync(binDir, { recursive: true });
    const out = path.join(
        binDir,
        WIN ? `floe-${version}.exe` : `floe-${version}`
    );
    exec(
        'go',
        [
            'build',
            '-ldflags',
            `-X main.version=${version}`,
            '-o',
            out,
            './cmd/floe',
        ],
        {
            cwd: path.join(root, 'cli'),
            timeout: 10 * 60_000,
        }
    );
    if (!existsSync(out)) throw new Error(`go build produced no ${out}`);
    return {
        path: out,
        version,
        sha256: await sha256OfFile(out),
        builtAt: statSync(out).mtime.toISOString(),
    };
}

export function wailsPath({ env = process.env, exec = defaultExec } = {}) {
    let gopath = env.GOPATH || '';
    if (!gopath) {
        try {
            gopath = exec('go', ['env', 'GOPATH']);
        } catch {
            gopath = path.join(os.homedir(), 'go');
        }
    }
    return path.join(gopath, 'bin', WIN ? 'wails.exe' : 'wails');
}

/**
 * The two command lines for a HEAD desktop build, for lib/desktop.mjs to
 * run: npm run build in desktop/frontend (required before any Go command
 * in desktop/), then wails build with the version stamped.
 */
export function headDesktopCommands({ root, sha7, wails = wailsPath() }) {
    const version = `head-${sha7}`;
    return {
        version,
        steps: [
            {
                cmd: WIN ? 'npm.cmd' : 'npm',
                args: ['run', 'build'],
                cwd: path.join(root, 'desktop', 'frontend'),
                shell: WIN,
                timeoutMs: 10 * 60_000,
            },
            {
                cmd: wails,
                args: ['build', '-s', '-ldflags', `-X main.version=${version}`],
                cwd: path.join(root, 'desktop'),
                shell: false,
                timeoutMs: 15 * 60_000,
            },
        ],
        exe: path.join(root, 'desktop', 'build', 'bin', 'floe-desktop.exe'),
        writes: [
            path.join(root, 'desktop', 'frontend', 'dist'),
            path.join(root, 'desktop', 'build', 'bin'),
        ],
    };
}

export function removeSideloads(binDir) {
    if (binDir && existsSync(binDir))
        rmSync(binDir, { recursive: true, force: true, maxRetries: 3 });
}
