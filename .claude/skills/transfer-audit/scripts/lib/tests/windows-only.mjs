// The transfer audit runs on Windows only: it drives Floe Desktop, tasklist,
// WSL and Windows paths. A test that exercises those parts takes this as its
// options, so a contributor who runs the skill suites on macOS or Linux, as
// AGENTS.md asks, sees it skipped instead of failed, and sees no hang where a
// kill the safety check refuses leaves a child running. CI runs the suites on
// windows-latest, where every one of these tests runs.
export const WINDOWS_ONLY =
    process.platform === 'win32' ? {} : { skip: 'needs Windows: the audit drives Windows paths and processes' };
