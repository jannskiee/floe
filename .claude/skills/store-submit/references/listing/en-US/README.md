# The Store listing, en-US

What the Microsoft Store listing of Floe Desktop (Store ID 9NBQ8ZQ1065L) says and shows, as Submission 15 saved it on 2026-10-09 with package 1.3.0.0. Before this folder existed the words lived only in Partner Center and in the owner's planning notes, and the repository held their lengths and fingerprints alone.

| File | Listing field | Form |
| --- | --- | --- |
| `description.txt` | Description | the text as pasted, blank lines included |
| `features.txt` | Product features | one feature per line, no bullets (the Store draws them) |
| `captions.txt` | Screenshot captions | one caption per line, in the order of the images |
| `screenshots/NN-*.png` | Desktop screenshots | listing order is file name order |
| `certification-notes.txt` | Notes for certification (Supplemental info, not the listing page) | the text as pasted |
| `manifest.json` | none | each field's length and djb2 fingerprint, each image's size and SHA-256, and the submission that saved them |

Every text file ends with one newline that is not part of the field. The lengths and fingerprints are taken with line ends as LF and that last newline removed, so a checkout with CRLF measures the same.

## The rules

- These files are a record of what is live, not a draft. The skill never writes listing text on its own authority: new words and new images come from the owner (SKILL.md step 5a).
- A release that changes the listing changes this folder in the same pull request that prepares the release: the new text, the new images, the new rows in `manifest.json`, and a new row in the history table of `../../partner-center.md`. `scripts/listing.test.mjs` fails when the three disagree.
- After the listing is saved in Partner Center, read each field back and compare its fingerprint with the manifest's. `node .claude/skills/store-submit/scripts/listing.mjs` prints them, and the djb2 loop for a browser snippet is in `scripts/release-notes.mjs`.
- What's new is not here. It is rendered from `docs/changelog.mdx` for each release (`scripts/release-notes.mjs`).

Not in this folder, because a routine update never pastes them: the short description, the keywords, the logos, the display name. `../../partner-center.md` says what is known about each.

## How the four screenshots were made

They show the build tagged `desktop-v0.3.0`, captured on 2026-10-09 with nobody at the PC (driving the app through UI Automation activates its window).

1. The `wails build` exe of the tagged commit, not `wails dev` (the listing shows the shipped window) and not the Store package (it cannot be pointed at a local server without the same steps).
2. `APPDATA` and `LOCALAPPDATA` redirected to a fresh scratch folder before launch, so History is empty and no real path or setting shows. Never the owner's `%APPDATA%\floe`.
3. A local stack from the floe-run skill with request links on and the stats counter neutralized, and the app's server address set to it in the scratch `desktop.json`.
4. Settings, Advanced, Share link address set to `https://floe.one`, so the link fields read like production. The room ids existed only in that local server's memory and ended with it.
5. The window on the second monitor, moved with `SWP_NOACTIVATE`, sized so the capture is 1366 x 768 (the Store's minimum for desktop), captured with `PrintWindow` and `PW_RENDERFULLCONTENT`, which is already cropped to the window.
6. Fixture data only: the label "Acme footage", files with neutral names, Hide my IP off.

The shots, in order: Send with two files staged and the share panel showing; Receive with CODE selected and the field empty; REQUEST LINK waiting for files; the Accept prompt after a local test visitor (`cli/internal/rlvisitor`, which refuses any server that is not local) sent a dozen fixture files, captured once Accept was enabled, then declined so nothing was written.

Before a new set is accepted, look at each image: no user name, no personal path, no real link or address, no other window, no notification over the app.
