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

Install the Wails CLI at v2.16.0, the version `go.mod` links against. CI
installs that same version and fails when its pin and `go.mod` drift apart.

A build you run from here talks to Floe's live server, `api.floe.one`, until
you set **Server address** under Settings, **Advanced** (`http://localhost:3001`
for a server started from `server/`). While it is on the live server, a test
transfer it receives adds its bytes to the public counter for good: turn the
report off first, as
[Test transfers and the public counter](../CONTRIBUTING.md#test-transfers-and-the-public-counter)
shows. `CONTRIBUTING.md` at the repository root also has the steps for turning
request links on locally.

## Where things are documented

User-facing behavior lives in the six-page desktop docs group (`docs/desktop/`):

- [Installation](https://www.floe.one/docs/desktop/installation)
- [Sending files](https://www.floe.one/docs/desktop/sending)
- [Receiving files](https://www.floe.one/docs/desktop/receiving)
- [Request links](https://www.floe.one/docs/desktop/request-links)
- [Settings](https://www.floe.one/docs/desktop/settings)
- [Keyboard shortcuts](https://www.floe.one/docs/desktop/keyboard-shortcuts)

Release status, the Store plan, and the roadmap live in `DESKTOP.md` at the
repository root. The Microsoft Store packaging pipeline lives in `build/msix/`
(see `build/README.md`).
