import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Guards the checksum step of public/install.sh and public/install.ps1: a download
 * that cannot be checked is never installed.
 *
 * This lives in lib/ for the reason serviceWorker.test.ts does: vitest.config.ts
 * collects only lib/ and app/, and these are files served verbatim. No CI job runs
 * either script and floe.one serves them the moment a change merges, so they are
 * read as text here, which is all a Node test can do with them.
 *
 * What text cannot show is what GitHub answers, and that is how the PowerShell
 * script went wrong. GitHub serves checksums.txt as application/octet-stream, which
 * makes an Invoke-WebRequest response's .Content a byte array; splitting that into
 * lines finds no line for any archive (measured on Windows PowerShell 5.1 against
 * v1.11.7 and v1.11.1, 2026-11-01). The script then warned and installed unchecked,
 * and with a missing line now a refusal, reading it that way would stop every
 * install. A change to this step needs a real run: `irm https://floe.one/install.ps1
 * | iex` has to print "Checksum verified."
 */
function read(name: string): string {
    return readFileSync(fileURLToPath(new URL(`../public/${name}`, import.meta.url)), 'utf8').replace(
        /\r\n/g,
        '\n'
    );
}

// The script's code alone, so a comment that explains a removed mistake can name it.
function code(script: string): string {
    return script
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');
}

// One line of the script, then its exit 1 on the next line.
function refusal(line: string): RegExp {
    return new RegExp(`${line.replace(/[.*+?^$()[\]{}|\\]/g, '\\$&')}\\n\\s*exit 1\\n`);
}

describe('install.sh', () => {
    const sh = code(read('install.sh'));

    it('stops when the machine has no SHA-256 tool', () => {
        expect(sh).toMatch(
            refusal(
                'echo "Error: no SHA-256 tool found (sha256sum or shasum), so the download could not be verified. Install one and run this again." >&2'
            )
        );
    });

    it('stops when checksums.txt has no line for the archive', () => {
        expect(sh).toMatch(
            refusal(
                'echo "Error: checksums.txt has no line for ${ARCHIVE}, so the download could not be verified." >&2'
            )
        );
    });

    it('has no path that skips the check', () => {
        expect(sh).not.toMatch(/skipping/i);
        expect(sh).not.toContain('ACTUAL="${EXPECTED}"');
    });

    it('reads only the line for exactly this archive', () => {
        // grep " ${ARCHIVE}" also took a longer name that holds this one (a
        // .sbom.json beside it) and read each dot as any character, so a file
        // with no line for the archive could still "verify" it. install.ps1 and
        // floe update already compare the whole name.
        expect(sh).toContain(
            `EXPECTED="$(awk -v a="\${ARCHIVE}" '{ sub(/\\r$/, "") } $2 == a { print $1; exit }' "\${TMP_DIR}/checksums.txt")"`
        );
        expect(sh).not.toContain('grep " ${ARCHIVE}"');
    });
});

describe('install.ps1', () => {
    const ps1 = code(read('install.ps1'));

    it('stops when checksums.txt has no line for the archive', () => {
        expect(ps1).toMatch(
            refusal(
                'Write-Error "checksums.txt has no line for $Archive, so the download could not be verified."'
            )
        );
    });

    it('has no path that skips the check', () => {
        expect(ps1).not.toMatch(/skipping/i);
        expect(ps1).not.toContain('Write-Warning');
    });

    it('reads checksums.txt from a file, never from a response body', () => {
        expect(ps1).toContain('-OutFile $ChecksumsPath');
        expect(ps1).toContain('Get-Content -LiteralPath $ChecksumsPath');
        expect(ps1).not.toMatch(/\.Content\b/);
    });
});
