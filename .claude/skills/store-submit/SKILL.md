---
name: store-submit
description: "Use when submitting a Floe Desktop release to the Microsoft Store: Partner Center, the MSIX artifact, Start update, a Store submission, certification, or the What's new notes for 9NBQ8ZQ1065L. Verifies the MSIX from the desktop-release.yml run, renders the changelog entry to plain text, and drives Partner Center through Submit for certification, or stops before it as a rehearsal. Not for writing the changelog entry, the tag, or the pin order; that is floe-release. Not for localStorage, storing a file, the App Store, or winget."
---

# Store submission runbook

One product, one package per release, one submission in flight. This is
floe-release step 7: it runs after the follow-up PR (step 6) and before the
update-notice check (step 8), which stays in floe-release. Symbols, not
lines: the Store ID is `DESKTOP_STORE_ID` in `client/lib/desktopRelease.ts`;
the package identity is the `<Identity>` element of
`desktop/build/msix/AppxManifest.xml`; the version mapping is the
`$identityVersion` line of `desktop/build/msix/pack.ps1`; the artifact is the
"Upload MSIX artifact" step of `.github/workflows/desktop-release.yml`. Every
URL, selector and JS idiom is in `references/partner-center.md`; the page
wins over that file, and the file gets the correction with the date.

Paths below are relative to the repo root. From a worktree or checkout that
predates the skill, run the scripts by absolute path from one that has them.

Browser work uses the Claude-in-Chrome tools. Load them once, in one call:

```text
ToolSearch "select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__find,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__file_upload,mcp__claude-in-chrome__computer"
```

Clicking and waiting: most Partner Center controls are `he-button` web
components. Click a ref with `computer` (`left_click` with the `ref` that
`find` returned); wait with `computer` (`wait`, up to 10 s per call);
reload by `navigate` to the same URL; bring a control into view with
`computer` (`scroll_to` with its ref). A ref click worked on Start update,
the Packages Save, Remove and dialog buttons, and no-op'd on the listing
Save, Delete submission and View product details (measured 2026-08-28).
The rule for every control: click the ref, wait 3 s, and when nothing
changed take a fresh screenshot and click the visible button by
coordinates; when that fails too, JS `.click()` on the `he-button` through
`javascript_tool`. Only the page changing counts. On the overview card,
Delete submission and Submit for certification sit side by side: before
any coordinate click there, `zoom` on the card and read the label under
the cursor.

Run both scripts from the repo root, in the PowerShell tool or the Bash
tool. The examples use forward slashes, which both shells and Node accept;
a backslash path survives only PowerShell.

The standing rule (owner, 2026-08-16, memory `project_floe_store_identity`):
do the whole submission including Submit, and verify every field after every
save by reloading and reading it back; the SPA has shown a value it never
saved (2026-08-14, `form_input` on What's new). Two lines never move: the
USER signs in (never type into a sign-in form), and one session drives the
browser at a time (never hand a subagent the browser tools while a draft is
open; every Save lands on the page that carries Submit).

Green from both scripts is a gate, not proof: they cannot see whether Partner
Center saved what you typed, whether the package the Store signs is the one
you verified, or whether certification will pass. The read-backs and the
certification email are the proof.

## 0. Preconditions (one in flight; 0.2.7 waited for Submission 8 to clear, 2026-08-19)

- The tag exists and its `desktop-release.yml` run succeeded (floe-release
  steps 3 to 5). The follow-up PR (step 6) is merged, so `DESKTOP_VERSION`
  equals the version you are submitting; the preflight warns when it does
  not, which is expected only in a rehearsal.
- `gh auth status` prints a logged-in account; every gh call the preflight
  makes in `--out` mode (repo view, run list, api, run download) needs it,
  and `--file` makes none.
- The Partner Center overview
  `https://partner.microsoft.com/en-us/dashboard/products/9NBQ8ZQ1065L/overview`
  shows the previous submission as "In Microsoft Store". "In certification"
  means one is in flight: stop, tell the user, wait for the email (20 minutes
  submit-to-live for Submission 10, about 36 minutes tag-to-live for
  Submission 7; the docs say up to 3 business days). The Start update control exists only in the first state.
- A draft already exists (an unsubmitted Submission N+1 and no Start update):
  a previous session died mid-way. Open it, read Packages (which version is
  listed, which is struck through) and the en-US What's new (`.value` through
  `javascript_tool`, never innerText), and resume from the first step whose
  result you cannot read back. Deleting the draft and starting over is also
  correct (step 9 does exactly that).
- Sign-in: sometimes the session is reused (2026-08-19), sometimes Partner
  Center forces `prompt=login` (2026-08-28). When the tab shows a Microsoft
  sign-in, say so and wait; the user signs in; then `navigate` to the
  overview again.
- "View product details" under Store presence opens the PUBLISHED
  submission's own pages, with an enabled Save (2026-08-28). Read there,
  never save there; a draft's URLs carry a different 19-digit submission id.
- Everything `file_upload` sends must live under THIS session's scratchpad:
  the tool refused other paths on 2026-08-02 and 2026-08-14. Pass a
  directory under it as the preflight's `--out`.

## 1. Fetch and verify the MSIX (a naive --limit 1 lands on the canceled twin, 2026-08-27)

```text
node .claude/skills/store-submit/scripts/msix-preflight.mjs --desktop desktop-v0.2.8 --out <scratchpad>/store
```

In order, it maps the tag to the Identity version and file name (`0.2.8` to
`1.2.8.0`, `FloeDesktop_1.2.8.0_x64.msix`, the `(major+1).minor.patch.0`
rule of pack.ps1); lists the tag's `desktop-release.yml` runs and picks the
successful one that holds a `floe-desktop-msix-X.Y.Z-run*` artifact, warning
about twins (run 33109832188, created one second after 33109830152 and
canceled later, holds zero artifacts); refuses an expired artifact (exit 4; retention is 90 days
from the run's start, 2026-11-25 for 0.2.8); downloads with
`gh run download`; reads `AppxManifest.xml` out of the package with its own
Zip64 reader (makeappx writes Zip64 with data descriptors, so a reader that
trusts local headers extracts nothing); checks every entry's crc32 (a
flipped byte anywhere fails it); asserts Identity Name, Publisher, Version
and ProcessorArchitecture against the template and the tag; prints size,
sha256, absolute path and a READY block. Exit codes: 0 ready, 1
findings, 2 usage, 3 no successful run or artifact, 4 expired, 5 gh failure.

Carry the READY block's lines (path, identity, sha256) into the step 6
record. `--desktop <tag> --file <path.msix>` verifies a package already on
disk without gh; `--desktop` stays required, because the expected version
comes from the tag.
Manual cross-check when in doubt (bsdtar reads MSIX):

```text
C:\Windows\System32\tar.exe -xOf <msix> AppxManifest.xml
Get-FileHash <msix>
```

The MSIX is never a release-page asset (`dist-msix/` sits outside the release
glob on purpose). The artifact ZIP also carries `priconfig.xml`,
`resources.pri` and `resources-dump.xml`: build residue, not uploads.

## 2. Render What's new (1,306 characters persisted for 0.2.8; the field takes 1,500)

```text
node .claude/skills/store-submit/scripts/release-notes.mjs --desktop desktop-v0.2.8 --out <scratchpad>/store/whats-new-desktop-v0.2.8.txt
```

It finds `<Update label="desktop-v0.2.8" ...>` in `docs/changelog.mdx`,
renders the body to plain text under a title line `Floe Desktop 0.2.8` (the
convention Submission 10 shipped by hand, whose 1,306 characters predate
the script; bold and code marks dropped,
links reduced to their text with the URL reported, bullets kept as `- `;
1,429 characters for 0.2.8), and checks it: HARD
when over 1,500 characters, when an em or en dash survives, when markdown or
MDX residue survives, when nothing is left under the title line, or when
the entry is missing (an `Unreleased` entry means floe-release step 6's
relabel has not happened). NOTE when the first body line is not a bold
headline (contract rule 4). NOTE for
external-channel words (`github.com`, `floe.one/download`,
`releases/download`, winget, Homebrew,
Scoop, "GitHub release", `apps.microsoft.com`): the listing docs keep URLs
out of listing fields, and Store policy 10.1.5 (formerly 10.8.5) confines
software acquisition to the Store, so reword or drop the sentence. It also
NOTEs a first tag other than `Desktop`, and any bullet starting `Web app:`
or `Self-hosting:`, which a Store reader has no use for.

Over the limit: condense by hand in the `--out` file (never in the
changelog), keep the headline and the bullets a Store user notices, then
`release-notes.mjs --check <file>` until it is green. 0.2.3 and 0.2.5 would
both need this (3,318 and 2,805 characters).

The script prints the length, a `djb2` fingerprint, and a `json:` line
holding the text as a JSON string literal; the literal is what step 5 pastes,
so quotes and newlines are already escaped.

## 3. Overview and Start update (every recorded submission since 5 began here)

`navigate` to the overview URL and confirm with `get_page_text` that the
page names the previous submission as "In Microsoft Store" and offers Start
update (the "Update your product" row under "Product release"). `find`
"Start update" and click its ref (worked 2026-08-28). The draft appears on
the overview itself (2026-08-28), as a card "Product update: In draft (Submission N: Last
modified on <date>)" with "Delete submission" and "Submit for certification"
side by side and a status chip "Update in draft" next to "In Microsoft
Store"; the section rows below it (Pricing and availability, Properties, Age
ratings, Packages, Store listings, Submission options) carry chips such as
Unchanged, Complete or Updated. Note the submission number for the report.
Submit is enabled from the first second on an update (2026-08-28; on the
first public submission, 2026-08-02, it stayed gray until the sections were
saved), so nothing in this runbook clicks near it until step 6.

The section rows are links to `.../submissions/<19-digit id>/<section>`.
Learn the id by clicking the Packages row: every browser tool result ends
with the tab's URL (so does `tabs_context_mcp`), and the id is the number
after `/submissions/`. From then on `navigate` to the section URLs
directly; a row click that changes nothing is the SPA no-op from
2026-08-02.

## 4. Packages: upload, wait, confirm the swap, Save (40 to 80 s across recorded runs)

- Open Packages (`.../submissions/<id>/packages`). The page lists the
  carried-over package (name, version, architecture, device family); its
  version is the `replaces` value of the step 6 record. `find`
  "file input for uploading a package"; it comes back as a file-type button
  with an empty label (2026-08-28). Hand its ref plus the READY path to `file_upload`.
  Never click the input or "browse your files": a native click opens an
  invisible OS picker that no tool can close (2026-08-19).
- Poll, do not sleep: `get_page_text` every 10 to 15 s. While validation
  runs, the upload row reads "<file> <size> 100 Analyzing package Cancel
  Pause" and a modal reads "Validating…" at the same time (both, 2026-08-28;
  the ellipsis is the single character U+2026, so match on "Validating");
  the row disappears when it ends: about 40 s on 2026-08-19, about 80 s for
  Submission 10, 50 to 60 s for 7.6 MB in the 2026-08-28 rehearsal. Past 5
  minutes,
  reload once and re-read; upload again only if the package is absent, never
  twice without a reload. The extension can drop for one call mid-poll;
  retry the same call.
- Success: the new Identity version is listed and the previous one is struck
  through, or marked for removal (Partner Center marks the lower version
  itself; 2026-08-02 and every run since). A package the Store already holds
  is listed a second time, ranked 2 in the device-family table, under a red
  alert: "Multiple uploaded files contain the same package
  (JanCarloParedes.FloeDesktop_1.2.8.0_x64\_\_r1y5w9chaxnzc). Please keep only
  one of the duplicate packages to continue." (2026-08-28). Then step 8.
- To drop a package: its "Remove" button (a real button, ref click works)
  marks it "This package will be removed after you save this page. Revert",
  and the page says "Click Save to confirm removal of the indicated
  package(s) from this submission." Nothing is removed until Save.
- Click Save (ref click worked 2026-08-28). A real Save REDIRECTS, through
  `.../submissions/<id>`, to the overview, whose Packages chip now reads
  "Updated"; staying on Packages means nothing was saved: read the page for
  an error, fix it, Save again. Reopen Packages after a reload and confirm
  the same lines.

## 5. Store listing, en-US: What's new (programmatic sets are ignored; 2026-08-14)

Open the en-US listing by URL
(`.../submissions/<id>/listings?languageid=4&languagecode=en-us`). The
What's new textarea is `#releaseNotes`, `maxlength="1500"` (measured
2026-08-28); it opens holding the previous submission's text (1,306
characters for Submission 10, beginning "Floe Desktop 0.2.8"). The SPA
ignores `form_input` and a plain `.value =` assignment; it registers the
native setter plus events. Run this with `javascript_tool`, pasting the
`json:` literal from step 2 as `text`:

```text
const ta = document.querySelector('#releaseNotes');
if (!ta) throw new Error('no #releaseNotes on this page');
const text = <json literal from release-notes.mjs>;
Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text);
for (const t of ['input', 'change', 'blur']) ta.dispatchEvent(new Event(t, { bubbles: true }));
JSON.stringify({ len: ta.value.length });
```

Click Save: the ref click no-op'd on 2026-08-28; `scroll_to` the Save ref,
take a fresh screenshot, and a coordinate click on the visible Save button
redirected to the overview within 5 s. No redirect means nothing was saved: read the page
for validation errors and record them. Then `navigate` to the listing URL
again and read the field back with the read-back snippet in the reference
(it returns `len`, `djb2`, head and tail). `len` and `djb2` must equal the
script's; on 2026-08-28 an 83-character text read back byte for byte. A
`len` short by exactly the number of newlines means the SPA stored CRLF or
trimmed: read the head and tail, judge, and record what you saw in the
reference.

Do not touch keywords, descriptions, screenshots, features or the display
name on a routine update; they carry over. Keyword chips silently drop when
Save happens while the chip input has focus (2026-08-02); the only defense
is never being in that field.

## 6. Submit for certification (the record goes in the same message as the click)

Standing authorization means you click Submit; it does not mean you click
silently. In the SAME message as the click, state what is being submitted,
as a record and not a request:

```text
Submitting Floe Desktop desktop-v0.2.8 as Submission <N, from the draft card>:
  package  FloeDesktop_1.2.8.0_x64.msix, 7,587,775 bytes, sha256 <hex>
           from artifact floe-desktop-msix-0.2.8-run12 (run 33109830152), replacing <version Packages listed before the upload>
  listing  en-US What's new, <N> chars, djb2 <hex>, read back after save
  untouched: audience, pricing, properties, age ratings, descriptions, screenshots, keywords, submission options
```

- The "Submission options: Incomplete" badge is advisory; the Submit button
  enabling is the gate (2026-08-02, and every run since).
- `find` "Submit for certification" and click the ref (worked 2026-08-19 and
  2026-08-28). Wait 3 s; if nothing changed, take a fresh screenshot, `zoom`
  on the card to confirm the label (Delete submission is its neighbor), and
  click the visible blue button by coordinates (what worked on 2026-08-14,
  when the ref was a non-interactive wrapper). The flip itself can take a
  few seconds more. Proof is the page flipping to "Update in certification" with the
  submission timeline; nothing else counts.
- A satisfaction survey pops up after submit: Cancel it. Never answer it for
  the user.

## 7. After submit (same day so far: 20 min submit-to-live for 10, 36 min tag-to-live for 7)

- The overview shows "Update in certification" and the timeline; the
  previous submission keeps serving until this one publishes.
- Tell the user: certification usually finishes the same day; the docs say
  up to three business days, then the listing updates within about 15
  minutes of a pass, and the account owner is notified by email and in the
  Action Center either way. Do not poll Partner Center for hours; check once
  later or when the user says the email landed.
- Submitted by mistake: the Certification status card on the overview has a
  three-dot menu with "Cancel certification" (docs page updated 2026-04-09); it works until
  the Publishing phase begins. Say what happened in the same message.
- Live means the overview says "Congrats! Your product is now updated" and
  Store presence names this submission. On this machine, once the Store app
  has updated, this prints the new Identity version:
  `Get-AppxPackage JanCarloParedes.FloeDesktop | Select-Object Version`.
  The Store build never shows the in-app update notice
  (`desktop/updatecheck.go` returns early when `isPackaged()`), so
  floe-release step 8 runs on the GitHub build.
- Record in the report: submission number, run id, artifact name, sha256,
  identity version, notes length and fingerprint, submit time, and later the
  live time.

## 8. When it goes wrong

- A package the Store already holds (same identity, version and
  architecture) uploads and validates, then is listed a second time under
  the duplicate alert, and the page says it cannot continue until one row
  is removed (step 4, 2026-08-28). A shipped version can never ship again:
  the docs allow packages in any order, but every recorded run saw Partner
  Center mark the lower version for removal, so treat the next number as
  the only fix (floe-release step 0); never delete and re-cut the tag for
  the Store's sake.
- Identity mismatch (Name or Publisher) from the preflight: the artifact was
  not built from `desktop/build/msix/AppxManifest.xml` as committed. Never
  hand-edit the manifest and repack (the block map would no longer match);
  fix the template on `main` and cut the next number.
- Expired artifact (preflight exit 4): do NOT rerun or dispatch
  `desktop-release.yml`. A rerun is refused after 30 days anyway, and a
  dispatch stamps `main.version=dev` and reuses the committed `wails.json`
  version, which the Store already holds. Cut the next number with
  floe-release; being here means the submission slipped more than 90 days
  past the tag, and the report says so.
- Sign-in expired mid-flow (`prompt=login`, 2026-08-28): the user signs in,
  then `navigate` back to the overview; the draft survives server-side.
- A ref click that does nothing: the control is an `he-button` wrapper
  (listing Save, Delete submission, View product details on 2026-08-28;
  Submit on 2026-08-14). Screenshot, click the visible button by
  coordinates, verify by the page changing.
- The SPA lies: a value shown is not a value saved (2026-08-14); a Save that
  does not redirect saved nothing; the a11y ref for Submit can be a wrapper
  (2026-08-14); a canceled twin run has no artifact (2026-08-27); textarea
  values never appear in innerText (2026-08-02). Every read-back step above
  exists because of one of these.

## 9. Rehearsal (stop before Submit, then delete the draft; done 2026-08-28)

Purpose: exercise every idiom above without shipping, and fill the unknowns
in the reference. It proves the click path, not the package: with the
shipped artifact the upload is flagged at step 4 as a duplicate, and that
alert text is itself worth recording.

- Steps 0 to 3 as written. Step 1 with `--desktop <tag> --file <the shipped
msix>` (no gh) or the live download, either is fine.
- Step 4 with the shipped package, expecting the duplicate alert (record
  its wording), then Remove the duplicate row and Save. With the next real
  artifact instead, the swap is real and you must still stop before Submit.
- Step 5 with a marker text from `release-notes.mjs --check` on a
  hand-written file (2026-08-28: `DRY RUN 2026-08-28: store-submit skill
rehearsal. Not a release. Delete this draft.`), so the read-back is
  unmistakable. Never step 6: read the Submit button's state from the page
  text and leave it.
- Delete the draft from the overview card: "Delete submission" (a ref click
  no-op'd on 2026-08-28; a coordinate click opened the dialog "Delete
  submission? This will delete your product submission. Do you want to
  continue?" with Yes and No; Yes is a real button and its ref click
  worked). Within 5 s the overview is back to "In Microsoft Store" with the
  Congrats banner, Start update, Store presence naming the live submission,
  and no draft. The deleted draft's URLs render an empty page shell with a
  disabled Save and "Status: OK, FaultCode: undefined".
- Confirm the live listing is unchanged: "View product details" under Store
  presence opens the published submission (JS `.click()` on the
  `he-button` worked when ref and coordinate clicks did not); read
  `#releaseNotes` on its listing URL and compare `len` and `djb2` with the
  values you read before the rehearsal. Do not save anything there.
- Every label, URL or selector that differs from the reference is corrected
  there with the date, in the same PR as the rehearsal report. The draft
  consumed a submission number (11 on 2026-08-28); whether the next Start
  update reuses it is measured at the next release.

## Done means

Submit clicked with the record message, the overview showing "Update in
certification", and the report carrying: run id, artifact name and expiry,
sha256, identity version, the preflight's `ok` lines, notes length and
fingerprint from both the script and the read-back, submission number, and
the submit time. Later: the certification email or the "Congrats" overview,
and `Get-AppxPackage` showing the new version.

## Pointers

- floe-release SKILL.md steps 0, 4, 6, 7 and 8, and its
  `references/tag-and-workflows.md`; DESKTOP.md "Microsoft Store plan" and
  steps c, d and g.
- `desktop/build/msix/pack.ps1` and `AppxManifest.xml`;
  `.github/workflows/desktop-release.yml`; the MDX contract at the top of
  `docs/changelog.mdx`; `client/lib/desktopRelease.ts`.
- Memory: project_floe_store_identity (authorization, identity, Submissions
  1 and 2), reference_release_automation_traps (textarea setter, the
  `file_upload` path rule, the 2026-08-14 Submit note),
  project_release_0_2_5_and_1_10_2 (Submission 7),
  project_release_1_10_3_and_0_2_6 (Submission 8, the flow that worked),
  project_release_1_10_5_and_0_2_8 (Submission 10, `prompt=login`),
  project_desktop_next_steps_2026_08 (Submission 5, `input[name=fileuploader]`,
  1,342 characters), project_desktop_0_2_4_release and
  project_desktop_0_2_4_plan (Submission 6).
