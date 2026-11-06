// What the Sentry SDK may collect on its own, stated in full (L5-19).
//
// @sentry/nextjs 10 worked this out from sendDefaultPii, which all three
// configs set to false. Version 11 removes that option and reads
// dataCollection instead, and with no dataCollection it collects everything:
// the browser client tells Sentry to infer the visitor's IP address
// (sdk.settings.infer_ip "auto"), server spans carry client.address, and
// cookies, every request and response header, request and response bodies
// and query strings are kept. A config that still set only sendDefaultPii
// would compile, because failClosedHooks is generic over its options, and
// would collect all of it.
//
// So the three configs pass this block. It is exactly what @sentry/core
// 10.76.2 resolved sendDefaultPii false to (defaultPiiToCollectionOptions.js),
// with the deny list it used (PII_HEADER_SNIPPETS) written out, because 11 no
// longer exports it. queues is new in 11 and false here: 10 sent no queue
// data. mcp is new in 11.9.0 and false here, as genAI is: Floe runs no MCP
// server, and until 12 the SDK falls back on genAI for it.
// sentryDataCollection.test.ts resolves it on the installed SDK.
//
// The deny list filters only the cookies, headers and query keys whose names
// can carry an address. The server scrub (scrubUrl.ts) then removes every
// request header but the user agent, and the cookies and the body, as it did
// before.
//
// Shapes are declared here rather than imported, so this module never loads
// the SDK.

const ADDRESS_NAME_SNIPPETS = ['forwarded', '-ip', 'remote-', 'via', '-user'];

type Collect = boolean | { deny: string[] };

export interface DataCollectionBlock {
    userInfo: boolean;
    cookies: Collect;
    httpHeaders: { request: Collect; response: Collect };
    httpBodies: never[];
    urlQueryParams: Collect;
    graphQL: { document: boolean; variables: boolean };
    genAI: { inputs: boolean; outputs: boolean };
    mcp: { inputs: boolean; outputs: boolean };
    databaseQueryData: boolean;
    queues: boolean;
    stackFrameVariables: boolean;
    frameContextLines: number;
}

export const DATA_COLLECTION: DataCollectionBlock = {
    userInfo: false,
    cookies: { deny: ADDRESS_NAME_SNIPPETS },
    httpHeaders: {
        request: { deny: ADDRESS_NAME_SNIPPETS },
        response: { deny: ADDRESS_NAME_SNIPPETS },
    },
    httpBodies: [],
    urlQueryParams: { deny: ADDRESS_NAME_SNIPPETS },
    graphQL: { document: true, variables: true },
    genAI: { inputs: false, outputs: false },
    mcp: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    stackFrameVariables: true,
    frameContextLines: 7,
};
