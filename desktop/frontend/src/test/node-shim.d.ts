// The two Node facilities approvedCopy.test.ts reads the frozen copy table
// with. The frontend carries no @types/node (the app never runs in Node), so
// these are declared here, for tests only; delete this file if @types/node is
// ever added.
declare module 'node:fs' {
    export function existsSync(path: string): boolean;
    export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare const process: {env: Record<string, string | undefined>};
