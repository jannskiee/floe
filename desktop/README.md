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

## Where things are documented

User-facing behavior lives in the five-page desktop docs group
(`docs/desktop/`): installation, sending, receiving, settings, and
keyboard-shortcuts. The pre-launch list of facts that had to reach those pages
shipped with them, including the relay cap and Hide my IP (sending, settings),
save-folder name collisions (receiving), who reports global stats (receiving),
the right-click Explorer entry and what Reset covers (settings), and
self-hosted server reachability (settings).

Release status, the Store plan, and the roadmap live in `DESKTOP.md` at the
repository root. The Microsoft Store packaging pipeline lives in `build/msix/`
(see `build/README.md`).
