import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const e2e = fileURLToPath(new URL('../e2e/', import.meta.url));
const read = (name: string) => readFileSync(join(e2e, name), 'utf8');
const specs = readdirSync(e2e).filter((name) => name.endsWith('.spec.ts')).sort();

describe('e2e fixture folders', () => {
    it('are never one fixed folder', () => {
        expect(specs.filter((name) => /=\s*join\(tmpdir\(\),\s*'[^']*'\)/.test(read(name)))).toEqual([]);
    });

    it('are named per worker process and removed with retries', () => {
        const helpers = read('helpers.ts');
        const body = (name: string) => {
            const at = helpers.indexOf(`export function ${name}(`);
            expect(at, name).toBeGreaterThan(-1);
            return helpers.slice(at, helpers.indexOf('\n}', at));
        };
        expect(body('fixtureDir')).toContain('process.pid');
        expect(body('removeFixtureDir')).toContain('maxRetries');
    });

    it('are removed by every spec that makes one', () => {
        for (const name of specs) {
            if (read(name).includes('fixtureDir(')) expect(read(name), name).toContain('removeFixtureDir(');
        }
    });
});
