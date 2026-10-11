# Floe Desktop

The Windows desktop app: a Wails v2 (Go) shell around the shared `cli/engine`
transfer core, with a React + TypeScript + Tailwind frontend in `frontend/`.
Project settings live in `wails.json`
(reference: https://wails.io/docs/reference/project-config).

## Build and develop

Build the frontend first, always: `main.go` embeds `frontend/dist`, which is not
checked in, so every Go command here fails on a fresh clone until it exists.

```
cd frontend
npm install
npm run build
npm test

cd ..
go test ./...
wails dev      # live development window with hot reload
wails build    # production build -> build/bin/floe-desktop.exe
```

`wails dev` also serves the app at http://localhost:34115, where a normal
browser can call the bound Go methods from devtools. Note that `wails build`
can exit 0 on a silent failure; check that the executable's timestamp changed.

Install the Wails CLI at v2.12.0, the version `go.mod` links against. CI
installs that same version and fails when its pin and `go.mod` drift apart.

A build you run from here talks to Floe's live server, `api.floe.one`, until
you set **Server address** under Settings, **Advanced** (`http://localhost:3001`
for a server started from `server/`). While it is on the live server, turn off
**Contribute to global stats** under Settings, **Privacy** before you receive a
test transfer: the bytes it reports are added to the public counter for good.
`CONTRIBUTING.md` at the repository root has the whole story, and the steps
for turning request links on locally.

## Where things are documented

User-facing behavior lives in the six-page desktop docs group
(`docs/desktop/`): installation, sending, receiving, request-links, settings,
and keyboard-shortcuts. The pre-launch list of facts that had to reach those
pages shipped with them, including the relay cap and Hide my IP (sending,
settings), save-folder name collisions (receiving), who reports global stats
(receiving), the right-click Explorer entry and what Reset covers (settings),
and self-hosted server reachability (settings).

Release status, the Store plan, and the roadmap live in `DESKTOP.md` at the
repository root. The Microsoft Store packaging pipeline lives in `build/msix/`
(see `build/README.md`).
