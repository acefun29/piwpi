# piwpi desktop

The desktop application runs the built-in piwpi Agent harness through an authenticated loopback bridge:

```text
Electron renderer
  ↕ HTTP/SSE (random 127.0.0.1 port, per-launch bearer token)
bridge.mjs
  ↕ strict JSONL
CodingAgentHarness RPC process
```

The RPC process owns the model execution state, queue, abort controller, session, context mounts, Project Map, and memory queue. There is no external extension or debug side server.

## Run

Build the monorepo runtime first, then start Electron:

```bash
npm run build
npm --prefix desktop start
```

The system Node used by `dev:web` must be Node 22.19 or newer. Electron supplies its own compatible Node runtime for the packaged app.

## Verify

```bash
npm --prefix desktop run typecheck:web
npm --prefix desktop run smoke
```

`smoke` uses the real built coding-agent RPC process but does not call a language model.

## Package Windows x64

```bash
npm run build
npm --prefix desktop run pack:win
```

This creates an unsigned NSIS installer and portable executable in `desktop/dist/`.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8901` | Web bridge port; Electron passes `0` for a random port |
| `PIWPI_WORKSPACE` | repository root in development | Initial project directory |
| `PIWPI_PI_CLI` | built or packaged `rpc-entry.js` | Override the Agent RPC entry |
| `PIWPI_PI_ARGS` | offline mode and desktop tools | Override arguments passed to the Agent runtime |
| `PIWPI_DATA_DIR` | `<project>/.piwpi` | Override piwpi project data directory |
