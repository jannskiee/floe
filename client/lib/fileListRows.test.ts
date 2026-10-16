import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Both file lists render again on every progress tick, and a row that rendered
// each time made a transfer of N files cost N squared row renders (T13-F4).
// Measured on 2026-10-16 in jsdom with production React, one render of the
// list at 10,000 files: 514 ms before and 7.7 ms after on the sending page,
// 843 ms and 5.5 ms on the receiving page. The components are mounted by no
// unit test, so what keeps it that way is read as text: each row is a memo
// component, it is handed nothing that changes on a tick, and its callback
// never changes.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('the sending page\'s file list', () => {
    const src = read('../components/SelectedFilesList.tsx');

    it('renders each row through a memo component', () => {
        expect(src).toContain('const FileRow = memo(function FileRow(');
    });

    it('hands a row only what decides its look, never the progress or the file index', () => {
        const props = src.slice(src.indexOf('interface FileRowProps'), src.indexOf('const FileRow'));
        expect(props).not.toMatch(/\bprogress\b|currentFileIndex/);
    });

    it('hands the rows a delete callback that never changes', () => {
        expect(src).toContain('const onDelete = useCallback((id: string) => deleteRef.current(id), []);');
    });
});

describe('the receiving page\'s file list', () => {
    const src = read('../components/ReceivedFilesList.tsx');

    it('renders each row through a memo component given the file and a callback', () => {
        expect(src).toContain('const ReceivedFileRow = memo(function ReceivedFileRow(');
        expect(src).toContain('<ReceivedFileRow key={file.id} file={file} onSaved={onRowSaved} />');
    });

    it('hands the rows a save callback that never changes', () => {
        expect(src).toContain('const onRowSaved = useCallback((ids: readonly string[]) => savedRef.current(ids), []);');
    });
});
