// Every string the visitor page renders, in one place.
//
// The copy is frozen: it was approved at Checkpoint C (2026-09-18) and the ids
// below are that table's ids. Edit a string here only with a new approval.
//
// Three rules the table itself carries, restated because they are invariants of
// this module rather than of any one string: American English; no em dash and no
// en dash in any value; and the page never renders a peer-supplied string, so
// nothing here is a template for one. Peer-derived VALUES that do reach the page
// later (the saved and verified counts) arrive clamped and are formatted where
// they are shown, never by concatenating into a constant here.
//
// S1-WEB-01 renders the three static states. The rest of the table (the Ready
// controls, the connection and transfer states, the refusal-code copy) arrives
// with the states that use it.

export const visitorCopy = {
    /** C-01: the Ready eyebrow, drawn as a mono line with the chip at its right.
     *  Written in capitals rather than lowercased and transformed, so the DOM
     *  carries the approved string and a screen reader is not handed a
     *  differently-cased one. */
    readyEyebrow: 'SEND FILES THROUGH THIS LINK',
    /** C-01: the chip beside the eyebrow. */
    betaChip: 'Beta',
    /** C-02: what this page is, and where the files go. */
    readyIntro:
        'This is a Floe request link. Files go to the computer of the person who made it, not to a Floe server. Floe does not know who made this link.',
    /** C-13: the Beta support line, shown while request links are in Beta. */
    betaSupport: 'During Beta, request links work in current Chrome and Edge on desktop.',

    /** C-20: V1, a link whose shape does not parse. Detected locally; no network
     *  call happens to produce it. */
    incompleteTitle: 'This link looks incomplete',
    /** C-21. */
    incompleteBody: 'Copy the whole link again, including everything after the # sign.',

    /** C-22: V2, no RTCPeerConnection or no data channel support. */
    unsupportedTitle: 'This browser cannot send through Floe',
    /** C-23. */
    unsupportedBody: 'Open the link in current Chrome or Edge.',

    /** C-30: V3a, this browser cannot pick folders. It is also the refusal for a
     *  dropped folder that arrived as a directory pseudo-File, because from the
     *  visitor's side those are the same problem with the same remedy. */
    foldersUnsupported: 'This browser cannot pick folders. Drag the folder in, or zip it first.',
    /** C-34, the over-10,000-files half. */
    tooManyFiles: 'This drop has more than 10,000 files. Zip them first.',
    /** C-34, the path-over-the-cap half. Its second sentence is C-33, which is
     *  drawn only as this tail and never on its own. */
    pathTooLong: 'A folder path is too long to send. Zip deeply nested folders first.',
    /** C-35: a quiet line under the count, not a refusal. Empty folders, and the
     *  modification times, are not delivered. */
    emptyFoldersSkipped: 'Empty folders are not sent.',
    /** C-36: the walk hit an entry it could not read, so nothing was added. */
    folderUnreadable: 'Some files in this folder could not be read. Nothing was added.',
} as const;
