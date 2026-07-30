# Floe Desktop

## About

The Floe desktop app: Wails (Go) shell around the shared `cli/engine` transfer core, with a
React + TypeScript + Tailwind frontend.

You can configure the project by editing `wails.json`. More information about the project settings can be found
here: https://wails.io/docs/reference/project-config

## Docs to write at desktop launch

The Settings screen keeps every description to 12 words or fewer, on the promise that the full
detail lives at floe.one/docs. These facts were deliberately removed from the UI copy and MUST
land on a desktop settings docs page before or with the first desktop release, or they are lost
rather than relocated:

- Save folder: leaving the field blank means Floe asks where to save on every transfer.
- Hide my IP: transfers route through a relay so the other peer never sees your IP; takes full
  effect on the next transfer; relayed transfers are capped at 2 GB while direct transfers are
  unlimited, and why.
- Global stats: only the receiving side reports; only the byte count is sent, never file names
  or contents; the total is public on floe.one; opt-out parity with the browser toggle and the
  CLI `--no-report` / `FLOE_NO_STATS`.
- Right-click menu (Windows): a per-user registry entry, needs no administrator approval,
  applies to files only, appears under "Show more options" on Windows 11.
- Custom server: what the signaling server does (brokers connection setup; file bytes never
  touch it) and what "people on floe.one cannot connect to you" means for reachability.
- Share link address: the recommended self-host topology is one address for server and web app;
  how the link address derives from the server address when blank.
- Use Floe's server: the reset clears both addresses and reconnects the app to api.floe.one.
- Transfer protocol: both devices must run compatible protocol versions; the check runs before
  any file bytes move; the `floe update` hint when versions miss.

## Live Development

To run in live development mode, run `wails dev` in the project directory. This will run a Vite development
server that will provide very fast hot reload of your frontend changes. If you want to develop in a browser
and have access to your Go methods, there is also a dev server that runs on http://localhost:34115. Connect
to this in your browser, and you can call your Go code from devtools.

## Building

To build a redistributable, production mode package, use `wails build`.
