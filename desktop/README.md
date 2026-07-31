# Floe Desktop

## About

The Floe desktop app: Wails (Go) shell around the shared `cli/engine` transfer core, with a
React + TypeScript + Tailwind frontend.

You can configure the project by editing `wails.json`. More information about the project settings can be found
here: https://wails.io/docs/reference/project-config

## Docs to write at desktop launch

Settings descriptions state what each setting does and the one consequence that changes a
decision. The facts below are the ones that genuinely do not fit a settings row, so they must land
on a desktop settings docs page before or with the first desktop release. Anything already covered
in the UI has been removed from this list; keep it that way, so it stays an accurate statement of
what is still missing.

- **Hide my IP, the relay cap.** Why relayed sessions stop at 2 GB while direct transfers are
  uncapped, and that an oversized relayed transfer is refused before any bytes move rather than
  failing partway.
- **Hide my IP against a self-hosted server.** Relay-only requires TURN. If a custom server offers
  none, ICE falls back to public STUN, the relay-only connection finds no candidates, and the
  transfer dies with a generic WebRTC error. This is the highest-value item on the list.
- **Global stats, who reports.** Only the receiving side reports, and only on a completed
  transfer. Opt-out parity with the browser toggle and the CLI `--no-report` / `FLOE_NO_STATS`.
  Note the counter follows the configured server, so a self-hoster's bytes go to their own server,
  not floe.one.
- **Right-click menu, how it is installed.** A per-user registry entry needing no administrator
  approval, scoped to files rather than folders.
- **Save folder, name collisions.** An arriving file never overwrites an existing one; it is kept
  as `name (1).ext`. Worth documenting precisely, because a user told "nothing is overwritten"
  who then cannot find the file by its original name is worse off than one told nothing.
- **Custom server, reachability.** What "people on floe.one cannot connect to you" means in
  practice, and that reaching you still requires the room id.
- **Share link address.** The recommended self-host topology is one address serving both the API
  and the web app; when a split setup needs this field.
- **Transfer protocol.** Compatibility is a range overlap, not an exact match, and the check runs
  before any file data moves.

## Live Development

To run in live development mode, run `wails dev` in the project directory. This will run a Vite development
server that will provide very fast hot reload of your frontend changes. If you want to develop in a browser
and have access to your Go methods, there is also a dev server that runs on http://localhost:34115. Connect
to this in your browser, and you can call your Go code from devtools.

## Building

To build a redistributable, production mode package, use `wails build`.
