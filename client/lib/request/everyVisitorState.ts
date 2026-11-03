// Every state of the /r page, for a test that has to walk them all. It comes from an object
// typed over the union, so a new state left out here fails tsc, where a list kept by hand in
// each test leaves that state uncovered with nothing to say so (V5d went missing from two).
// Imported only by tests, so no page carries it.

import type { VisitorState } from './visitorState';

const EVERY = {
    load: 1,
    V1: 1,
    V2: 1,
    V3: 1,
    V3c: 1,
    V4: 1,
    V5a: 1,
    V5b: 1,
    V5c: 1,
    V5d: 1,
    V6: 1,
    V6a: 1,
    V6b: 1,
    V6c: 1,
    V6d: 1,
    V6e: 1,
    V6f: 1,
    V6g: 1,
    V7: 1,
    V8a: 1,
    V8b: 1,
    V9: 1,
    V10: 1,
    V11: 1,
    V11a: 1,
    V11b: 1,
    V12: 1,
    V12a: 1,
    V13: 1,
} satisfies Record<VisitorState, 1>;

export const EVERY_VISITOR_STATE = Object.keys(EVERY) as VisitorState[];
