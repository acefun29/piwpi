<p align="center">
  <img alt="piwpi logo" src="logo.svg" width="300">
</p>

# piwpi

piwpi is an independent desktop Agent harness based on a modified [Pi](https://github.com/earendil-works/pi) runtime. It combines a Windows desktop client, multi-provider model runtime, coding tools, durable sessions, Default/Plan collaboration modes, file-context mounting, and a persistent Project Map in one product.

The piwpi capabilities are built into `packages/coding-agent`; there is no extension to install or `-e` startup path. Desktop communication is `Electron → authenticated local bridge → JSONL RPC → CodingAgentHarness`, with one prompt queue, model execution state, abort path, and session owner.

## Install

The first prerelease targets Windows x64:

- NSIS installer: `piwpi-0.1.0-windows-x64-setup.exe`
- Portable executable: `piwpi-0.1.0-windows-x64-portable.exe`

The beta is unsigned, so Windows SmartScreen may display an unknown-publisher warning. Verify the download with `SHA256SUMS.txt` from the same GitHub Release before running it.

## Development

Requirements: Node.js 22.19 or newer.

```bash
npm install --ignore-scripts
npm run build
npm run check
./test.sh

cd desktop
npm install
npm start
```

Build the Windows installer and portable executable:

```bash
npm run build
npm --prefix desktop run pack:win
```

Release artifacts are written to `desktop/dist/`. The tag workflow publishes only those Windows artifacts and their SHA-256 checksums; it does not publish npm packages.

## Data and configuration

- Sessions, plans, and Project Map: `<project>/.piwpi/`
- Model credentials and provider configuration: `~/.pi/agent/`
- Model credentials are handled by the inherited Pi model runtime and are not stored in project data.

## Repository layout

| Path | Purpose |
|---|---|
| `desktop/` | Electron shell, local bridge, and web UI |
| `packages/coding-agent/src/core/piwpi/` | Built-in context mounting, memory, and Project Map |
| `packages/coding-agent/` | CodingAgentHarness, tools, sessions, RPC, and model runtime |
| `packages/agent/` | Generic Agent harness and agent loop |
| `packages/ai/` | Provider and model APIs |

## Upstream and license

piwpi is based on [Pi](https://github.com/earendil-works/pi) and retains inherited `@earendil-works/*` package names and Pi configuration paths. The project is distributed under the [MIT License](LICENSE).
