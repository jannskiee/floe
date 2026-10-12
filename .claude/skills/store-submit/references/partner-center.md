# Partner Center: URLs, identity, idioms, history

Recorded from Partner Center sessions on 2026-08-02, 2026-08-13, 2026-08-14, 2026-08-16, 2026-08-19, 2026-08-28 (a full rehearsal: draft created, duplicate upload refused, listing marker saved and read back, draft deleted), 2026-09-17 (Submission 14, a routine update) and 2026-10-09 (Submission 15, the first to change the description, the features, the screenshots and the certification notes as well as the package). Partner Center is a shadow-DOM SPA that changes without notice: when a label, URL or selector here does not match the page, the page wins, and this file gets the correction with the date. Nothing here is a permission; the standing authorization is in SKILL.md.

This file is not complete. Three things were done on 2026-10-09 and not written down; they are listed under "To capture at the next submission", and the session that next meets one records it here with the date.

## URLs

| Page                                             | URL                                                                                                                             | Recorded   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Product overview (the draft card lives here too) | `https://partner.microsoft.com/en-us/dashboard/products/9NBQ8ZQ1065L/overview`                                                  | 2026-08-28 |
| Packages page of a submission                    | `https://partner.microsoft.com/en-us/dashboard/products/9NBQ8ZQ1065L/submissions/<id>/packages`                                 | 2026-08-28 |
| en-US Store listing of a submission              | `https://partner.microsoft.com/en-us/dashboard/products/9NBQ8ZQ1065L/submissions/<id>/listings?languageid=4&languagecode=en-us` | 2026-08-28 |
| Submission page (Save bounces through it)        | `https://partner.microsoft.com/en-us/dashboard/products/9NBQ8ZQ1065L/submissions/<id>`                                          | 2026-08-28 |
| Additional Testing Information (certification notes, product-level) | the page whose path ends `/suppinfo/additionaltestinginfo`, under Supplemental info; the full URL was not written down, so follow the pointer on the Submission options page | 2026-10-09 |
| Public listing                                   | `https://apps.microsoft.com/detail/9NBQ8ZQ1065L` (404 until the app was live; live since 2026-08-02)                            | 2026-08-02 |
| Private-audience listing (private era)           | `https://apps.microsoft.com/detail/restricted/9NBQ8ZQ1065L`                                                                     | 2026-08-02 |
| Store policies                                   | `https://learn.microsoft.com/en-us/windows/apps/publish/store-policies`                                                         | 2026-08-28 |

`<id>` is a 19-digit submission id (Submission 10 is 1152921505701756193; the 2026-08-28 draft was 1152921505701763224; Submission 15 is 1152921505702087159). The draft's sections are reached from the overview card's rows; "View product details" under Store presence opens the published submission's pages with an enabled Save, so read there and never save. Section links inside the SPA sometimes no-op (2026-08-02); direct navigation to a section URL always works. A deleted draft's URLs render an empty page shell with a disabled Save and "Status: OK, FaultCode: undefined" (2026-08-28).

## Identity (frozen by the first reservation)

| Field                 | Value                                       | Source                                                            |
| --------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| Store ID              | `9NBQ8ZQ1065L`                              | `DESKTOP_STORE_ID` in `client/lib/desktopRelease.ts`              |
| Identity Name         | `JanCarloParedes.FloeDesktop`               | `desktop/build/msix/AppxManifest.xml`                             |
| Identity Publisher    | `CN=5D497A40-D927-4850-8A83-E21F677E80E3`   | `desktop/build/msix/AppxManifest.xml`                             |
| PublisherDisplayName  | `Jan Carlo Paredes`                         | `desktop/build/msix/AppxManifest.xml`                             |
| DisplayName           | `Floe Desktop`                              | `desktop/build/msix/AppxManifest.xml`                             |
| ProcessorArchitecture | `x64`                                       | `desktop/build/msix/AppxManifest.xml`                             |
| MinVersion            | `10.0.19041.0`                              | `desktop/build/msix/AppxManifest.xml`                             |
| Package Family Name   | `JanCarloParedes.FloeDesktop_r1y5w9chaxnzc` | memory `project_floe_store_identity` (Partner Center, 2026-08-02) |

Name and Publisher are case and punctuation sensitive; a mismatch is an upload FAILURE, not a warning (2026-08-02). The first reservation froze Name and the Package Family Name for good; only the per-language display name can change.

## Version mapping

`desktop-vX.Y.Z` becomes Identity Version `(X+1).Y.Z.0` (the Store rejects a first octet of 0 and reserves the fourth; `desktop/build/msix/pack.ps1`): `desktop-v0.2.8` is `1.2.8.0`, `desktop-v0.10.0` is `1.10.0.0`, `desktop-v1.0.0` is `2.0.0.0`. The package file is `FloeDesktop_<identity>_x64.msix`. The Store requires every package, published or uploaded, to have a unique full name (identity, version, architecture), so a shipped version can never be uploaded again. The docs say packages may be submitted in any order; every recorded run saw Partner Center mark the lower version for removal when a higher one arrived (2026-08-02 and since).

## Click path (a routine update touches Packages and the en-US What's new, nothing else)

| Page                | Action                   | What worked                                                                                                         | Success signal                                                                                                                                                 | Recorded                                   |
| ------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Overview            | Start update             | `find`, click the ref                                                                                               | the draft card "Product update: In draft (Submission N: ...)" with Delete submission and Submit for certification; chip "Update in draft"                      | 2026-08-28                                 |
| Packages            | upload the MSIX          | `file_upload` on the ref of the file input (`find` "file input for uploading a package"; empty-labeled file button) | "Validating…" modal plus "Analyzing package" on the upload row, 50 to 60 s; then the new version listed and the old one struck through, or the duplicate alert | 2026-08-28                                 |
| Packages            | Remove a package         | `find` "Remove", click the ref                                                                                      | "This package will be removed after you save this page. Revert" and "Click Save to confirm removal..."                                                         | 2026-08-28                                 |
| Packages            | Save                     | `find`, click the ref                                                                                               | redirect through `.../submissions/<id>` to the overview; Packages chip "Updated"                                                                               | 2026-08-28                                 |
| Store listing en-US | fill What's new          | `javascript_tool`, native setter on `#releaseNotes` (maxlength 1500)                                                | the snippet returns `len`                                                                                                                                      | 2026-08-28                                 |
| Store listing en-US | Save                     | ref click no-op'd; `computer` click on the visible Save by coordinates. One Save covers every field on the page: on 2026-10-09 a single coordinate click saved What's new, the description, the features and the screenshots together | redirect to the overview within 5 s                                                                                                                            | 2026-08-28, 2026-10-09                     |
| Store listing en-US | read back                | `javascript_tool` after `navigate` to the listing URL                                                               | `len` and `djb2` equal the script's                                                                                                                            | 2026-08-28                                 |
| Store listing en-US | fill the description (only when the release changes it) | `javascript_tool`, native setter on the textarea `#description-required` | after the listing Save and a reload, `len` and `djb2` read back | 2026-10-09 |
| Store listing en-US | fill the features (only when the release changes them) | native `HTMLInputElement` value setter on `#feature-0` to `#feature-N`, then composed `input`, `change` and `blur`; "Add more" by JS `.click()` on its `he-button` | after the listing Save and a reload, the feature count and each length read back | 2026-10-09 |
| Store listing en-US | add a screenshot | `file_upload` on the add tile's file input; the tile keeps the same ref after each upload | after the listing Save and a reload, the screenshots are the new set | 2026-10-09 |
| Store listing en-US | remove a screenshot | `computer` click on the tile's trash icon, by coordinates | as above | 2026-10-09 |
| Store listing en-US | caption a screenshot | "Add image caption", `computer` `type` into the modal's textarea, then OK | after the listing Save and a reload, the captions read back in order | 2026-10-09 |
| Additional Testing Information | change the certification notes | fill `#certificationNotesDescription` (maximum 6000), then "Save description" (how the field was filled was not written down; try the native setter idiom first) | no redirect: reload, then `len` and `djb2` read back | 2026-10-09 |
| Overview            | Submit for certification | `find`, click the ref; coordinates as fallback                                                                      | "Update in certification" with the submission timeline                                                                                                         | 2026-08-28 (ref), 2026-08-14 and 2026-10-09 (coordinates) |
| Survey              | Cancel                   | `find`, click the ref                                                                                               | the survey closes                                                                                                                                              | 2026-08-19                                 |
| Overview            | Delete submission        | ref click no-op'd; `computer` click by coordinates                                                                  | dialog "Delete submission? This will delete your product submission. Do you want to continue?" Yes / No                                                        | 2026-08-28                                 |
| Dialog              | Yes                      | `find`, click the ref (a real button)                                                                               | overview back to "In Microsoft Store", Start update present, no draft, within 5 s                                                                              | 2026-08-28                                 |
| Overview            | View product details     | ref and coordinate clicks no-op'd; JS `.click()` on the `he-button`                                                 | the published submission's Packages page                                                                                                                       | 2026-08-28                                 |

## To capture at the next submission

Each was done on 2026-10-09 and not recorded. Until someone writes it here, treat the matching line above as a starting point, not as a recipe.

1. The full URL of the Additional Testing Information page. Only the end of its path is known (`/suppinfo/additionaltestinginfo`); reach it through the pointer on the Submission options page, then copy the address into the URL table.
2. How `#certificationNotesDescription` takes its text. The native setter idiom is the first thing to try; record whether it persisted (reload, then `len` and `djb2`), or what did.
3. The snippets that filled the description and the features. The idioms below describe them, but the session's own code was not kept; save the code that works, with the event list and whether `composed` mattered.

## JS idioms (run with `javascript_tool`)

Fill What's new. The SPA ignores `form_input` and a plain `.value =` assignment (2026-08-14); it registers the native setter plus `input`, `change` and `blur`:

```text
const ta = document.querySelector('#releaseNotes');
if (!ta) throw new Error('no #releaseNotes on this page');
const text = <json literal from release-notes.mjs>;
Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text);
for (const t of ['input', 'change', 'blur']) ta.dispatchEvent(new Event(t, { bubbles: true }));
JSON.stringify({ len: ta.value.length });
```

Read What's new back after a full reload. Textarea values never appear in innerText (2026-08-02), so read `.value`. The fingerprint is djb2 over LF-normalized text, iterated by code point, which is what `release-notes.mjs` prints:

```text
const v = (document.querySelector('#releaseNotes')?.value ?? '').replace(/\r\n/g, '\n');
let h = 5381; for (const c of v) h = (Math.imul(h, 33) + c.codePointAt(0)) >>> 0;
JSON.stringify({ len: v.length, djb2: h.toString(16).padStart(8, '0'), head: v.slice(0, 60), tail: v.slice(-60) });
```

The description is a textarea too, `#description-required`: the fill snippet above works with that selector, and the read-back snippet reads it the same way (2026-10-09: 3,296 characters, djb2 5e78a360). A feature is an input, `#feature-0` to `#feature-N`: use `HTMLInputElement.prototype` where the snippet has `HTMLTextAreaElement.prototype`, and dispatch `input`, `change` and `blur` as composed events. The 2026-10-09 session's own snippets were not kept, so prove the idiom on one field before trusting it with the rest: set the first field, Save the listing, reload, read that field back, and only then fill the others and Save once more (SKILL.md 5a says the same).

Struck-through package rows, when `get_page_text` is ambiguous (unverified; the recorded check is `get_page_text` showing both version strings):

```text
[...document.querySelectorAll('*')].filter((e) => getComputedStyle(e).textDecorationLine.includes('line-through')).map((e) => e.textContent.trim()).filter(Boolean).slice(0, 10);
```

Clickable controls include `he-button` web components; when clicking through JS, query `'button, a, [role=button], he-button'` (2026-08-02). Never `.click()` the file input: a native click opens an invisible OS picker that no tool can close (2026-08-19).

## Which clicks register (`he-button` wrappers)

- 2026-08-14 (Submission 6): the a11y-tree "button" ref for Submit was a non-interactive wrapper; clicking it did nothing; a click on the visible blue button by screenshot coordinates worked.
- 2026-08-19 (Submission 8): a coordinate click on Submit was ignored; `find` plus a click on the ref worked.
- 2026-08-28 (Submission 10): `find` plus a click on the ref worked for Submit.
- 2026-08-28 (rehearsal): ref clicks worked on Start update, the Packages Save, Remove, and the dialog's Yes; ref clicks did nothing on the listing Save, Delete submission and View product details; coordinates worked on the first two and JS `.click()` on the third.
- 2026-10-09 (Submission 15): the ref click on Submit did nothing (a wrapper, as on 2026-08-14); after a `zoom` check, a coordinate click on the visible blue button started a spinner and the page flipped to "Update in certification" within about 15 s. On the listing, "Add more" under the features took a JS `.click()` on its `he-button`, and a screenshot's trash icon took a coordinate click.

Rule: ref first, wait 3 s, then coordinates from a fresh screenshot, then JS `.click()` on the `he-button`; only the page changing counts. A satisfaction survey follows the Submit flip; Cancel it.

## What the hidden tab hides (2026-09-17, Submission 14)

- The tab the browser tools drive is hidden. After Submit had already flipped the page, `get_page_text` kept returning the "In draft" card; only a screenshot, which renders the tab, showed "Update in certification" and the survey. Take a screenshot before any second Submit click.
- A `zoom` timed out once while the SPA was busy and worked on the retry.
- Sign-in showed an account picker with three accounts. The owner picks the account; the session never does.

## Submission history (recorded facts only)

| Submission | Date       | Package | What changed                                                                                           | Certification                                           | Source                                                                                                           |
| ---------- | ---------- | ------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1          | 2026-08-02 | 1.2.0.0 | first submission, private audience                                                                     | passed the same day                                     | memory `project_floe_store_identity`                                                                             |
| 2          | 2026-08-02 | 1.2.1.0 | tile color fix; audience Private to Public; second screenshot; captions; What's new                    | outcome recorded only as "listing public on 2026-08-02" | DESKTOP.md step d; `client/lib/desktopRelease.ts`                                                                |
| 3, 4       |            |         | not recorded                                                                                           |                                                         |                                                                                                                  |
| 5          | 2026-08-13 | 1.2.3.0 | package and What's new (1,342 characters)                                                              | published before 0.2.4 began                            | memory `project_desktop_next_steps_2026_08` (flow, 1,342 characters); published per `project_desktop_0_2_4_plan` |
| 6          | 2026-08-14 | 1.2.4.0 | package and What's new                                                                                 | submitted; outcome never written down                   | memory `project_desktop_0_2_4_release`                                                                           |
| 7          | 2026-08-16 | 1.2.5.0 | package and What's new                                                                                 | live the same day, about 36 minutes after the tag       | memory `project_release_0_2_5_and_1_10_2`                                                                        |
| 8          | 2026-08-19 | 1.2.6.0 | package and What's new                                                                                 | submitted; outcome never written down                   | memory `project_release_1_10_3_and_0_2_6`                                                                        |
| 9          |            | 1.2.7.0 | not recorded (expected after 8 cleared)                                                                |                                                         |                                                                                                                  |
| 10         | 2026-08-28 | 1.2.8.0 | package from `floe-desktop-msix-0.2.8-run12` (run 33109830152); What's new, 1,306 characters persisted | live about 20 minutes after submit                      | memory `project_release_1_10_5_and_0_2_8`                                                                        |
| 11 to 13   |            |         | not recorded here                                                                                      |                                                         |                                                                                                                  |
| 14         | 2026-09-17 | 1.2.12.0 | package and What's new for desktop-v0.2.12, a routine update                                           | submitted about 15:03 UTC; the result was left to the email and never written down, but 1.2.12.0 was the package in the Store when Submission 15 replaced it | memory `project_release_1_10_11_and_0_2_12`; the Submission 15 record (its `replaces` value)                     |
| 15         | 2026-10-09 | 1.3.0.0 | package from `floe-desktop-msix-0.3.0-run18` (run 37949335531), 7,733,023 bytes, replacing 1.2.12.0; What's new, 1,494 characters (djb2 e868b446); description, 3,296 characters (djb2 5e78a360); 11 features; the two old screenshots removed and four 1366x768 uploaded with captions; certification notes, 1,278 characters (djb2 6db7e3bd) in place of 890 | submitted about 15:55 UTC; certified and live within about an hour, as a regular submission with no package flight                              | the S-03 submit record of the 0.3.0 release, kept in the owner's plan folder outside this repository; the outcome from memory `project_release_1_11_0_and_0_3_0` |

On 2026-08-28 a rehearsal created draft Submission 11 (id 1152921505701763224), had the live 1.2.8.0 package refused as a duplicate, saved a marker into What's new, and deleted the draft; the overview returned to Submission 10 and the live What's new read back unchanged (1,306 characters, djb2 0954a1b5). Whether a later Start update reused number 11 was never written down; the count had reached 15 by 2026-10-09. Submissions 3, 4, 9, 12 and 13 happened (the numbering says so) and were never written down here, and neither was what became of number 11 after the rehearsal; do not claim which package rode which.

The four screenshot captions Submission 15 saved, in order, as read back after a reload:

1. Send files with a room code, share link, or QR code
2. Receive with a three-word code or a share link
3. Request links (Beta): make a one-time link so one person can send you files from Chrome or Edge on their computer
4. By default nothing is saved until you accept. The request shows how many files and how large, never a file name or anything the sender typed

## Never touched on a routine update

- Audience: Public is a one-way door; public to private is permanently forbidden.
- Pricing and availability, markets.
- Properties: category Utilities & tools > File managers; privacy URL `https://www.floe.one/privacy`; support URL (the GitHub issues page).
- Age ratings (IARC questionnaire, done once).
- Store listing: the description and the features (product first, requirements last), the screenshots, the short description, the logos, the display name and the keywords (the docs allow 7 keywords of up to 40 characters and at most 21 words across them; the project recorded 30 on 2026-08-02; the 2026-10-09 record counts six keywords and left them as they were; never the app name; chips drop when Save happens while the chip input has focus, 2026-08-02). What the listing holds since Submission 15 (2026-10-09): a 3,296-character description, 11 features and four 1366x768 screenshots with the captions listed under the history table. Before it: 7 features and two screenshots. None of these words or images is in this repository, only the lengths and fingerprints in the history table, and how the four screenshots were made was not recorded; read the live fields back and keep a copy before overwriting any of them. A release that changes what the app does changes these on purpose; SKILL.md step 5a is that flow.
- Submission options: the runFullTrust justification (775 characters, not re-read on 2026-10-09) carries over, and publishing is set to happen as soon as the submission passes (2026-10-09). The "Submission options: Incomplete" badge is advisory and did not block Submit on any recorded run. The certification notes are no longer on this page (2026-10-09): it only points to them.
- Certification notes: product-level, under Supplemental info > Additional Testing Information (the field `#certificationNotesDescription`, maximum 6000 characters, its own "Save description" control, no redirect on save). They carry over until someone changes them there. 1,278 characters since 2026-10-09 (djb2 6db7e3bd); the 890 characters before that (djb2 99086620) explained pairing with floe.one in a browser, since one reviewer on one machine cannot test a two-peer app. SKILL.md step 5b is the flow.

## Policy notes (Microsoft Store Policies v7.19, effective 2025-10-14; read 2026-08-28)

The project's 2026-08 notes cited 10.8.5 for "no links to other channels"; the change history says 7.10 moved that rule to 10.2.6 and 7.11 republished it as 10.1.5. Quote the current text from `https://learn.microsoft.com/en-us/windows/apps/publish/store-policies` when you touch this section.

- 10.1.1: all metadata must accurately describe the product; the title must be unique and carry no marketing or descriptive text or extraneous keywords; the product must not claim to be from an entity without permission.
- 10.1.3: search terms are at most seven unique terms or phrases, relevant to the product, without pricing terms or other publishers' product titles.
- 10.1.5: a product may enable acquisition of other products only when they are also distributed through the Store and acquired through it. This is why the rendered What's new drops GitHub, winget and download links; the listing docs also say to keep URLs out of the description and use the designated support and website fields.
- 10.3, 10.3.1, 10.3.2: the product must be testable; a login needs a demo account in Notes for certification; a required server must be functional during review. A two-peer app with a single-instance lock is the "anything else testers need" case: the notes as written in 2026-08 described pairing with floe.one in a browser (their 2026-10-09 text is not in this repository), and api.floe.one must be up during review. Since the listing shows request links (2026-10-09), the server must also offer them during review: Floe Desktop makes a link only against a server whose `/health` lists `request-1` (`RequestLinkSupport` in `desktop/serverprobe.go`). The Submission 15 record read `https://api.floe.one/health` at submit and it listed `request-1`.

## What the docs say (Microsoft Learn, read 2026-08-28; verify on the page before relying on any of it)

- Start update "will create a new submission for the application, using the info from your previous submission as a starting point" (publish-update-to-your-app-on-store, updated 2026-08-24).
- A draft can be deleted: "From the Product submission (or product update card in case of an update submission) card, click Delete submission", then confirm (app-submission-control, updated 2026-04-09). A submitted one can be canceled from the Certification status card's three-dot menu, "Cancel certification", until the Publishing phase begins (same page; app-certification-process).
- Certification "can take up to three business days"; after a pass "customers will be able to see the app's listing within 15 minutes"; phases Preprocessing, Certification, Release, Publishing, In the Store; the account owner is notified by email and the Action Center (app-certification-process, manage-submission-options).
- Package version numbering: the fourth octet is reserved for the Store and must be 0; the first octet cannot be 0; packages "can be submitted in any order"; every package needs a unique full identity; manifest identity values are case and punctuation sensitive and a mismatch is an upload failure (app-package-requirements, view-app-identity-details, updated 2026-08-24).
- A package that fails validation shows a message; remove it with the Remove link at the bottom of its Details section, fix, upload again. The Packages section reads "Incomplete" until every required field is set, even when each package shows "Validated" (upload-app-packages, ms.date 2026-04-21; create-app-submission).
- What's new "has a 1500 character limit" (previously called Release notes). The description takes 10,000 characters of plain text, with no HTML, code or URLs (add-and-edit-store-listing-info, updated 2026-08-24).
- Not in the docs: a "package version must be greater than" error. What Partner Center shows for a package it already holds, measured 2026-08-28: "Multiple uploaded files contain the same package (JanCarloParedes.FloeDesktop_1.2.8.0_x64\_\_r1y5w9chaxnzc). Please keep only one of the duplicate packages to continue." A Microsoft Q&A thread recorded a sibling wording: "All .msix and .appx packages (including previously published and currently uploaded) must be uniquely identified by their full names ... Please remove one of these packages, or increment current package versions to continue."
