# Fast VS Code Plugin — Agent Guide

## Scope and identity

- Extension ID: `mmsan.scs`; package: `scs`; entry point: `extension.js`.
- Bridge client: `fast-vscode-bridge`; editor identity: `ide: Visual Studio Code`. Read the version from `package.json`; never hard-code it.
- `fast-vscode-bridge` is recognized by `D:\v\fastjs\utils\socket-vscode.js`; update that service before changing the value.
- Key files: `extension.js`, `fastBridge.js`, `package.json`, `package-lock.json`, and the publish scripts.

## Shared bridge rules

Follow `D:\v\fast-idea\AGENTS.md`; do not copy shared protocol, targeting, focus/search, performance, privacy, reconnect, or synchronization rules here.

## VS Code-specific rules

- Keep `command.copyResourcePath` and its Ctrl+Shift+C override scoped to Files Explorer resources; inspect the implementation for response fields.
- A caret is the text insertion caret. `fastBridge.sendText` controls text sharing; when disabled, omit selected/nearby text but retain structural ranges.
- Preserve `D:\v\fastjs\fast.js` binding of the active file/workspace root to `f.fast.currentWindow.filePath` and `.dir`.
- Keep `Fast Bridge` diagnostics concise, use `LogOutputChannel`, and delete plugin logs older than three days.

## Logs

- Output channel: `Fast Bridge`, available through `Fast Bridge: 显示日志`.
- Daily file: `fast-vscode-bridge-YYYY-MM-DD.log` in VS Code's extension `logUri` directory.

## Validation

When changing handshake fields, events, commands, or payloads, update the affected Node adapters with backward-compatible routing and run:

```powershell
node --check .\extension.js
node --check .\fastBridge.js
node --check D:\v\fastjs\utils\socket-vscode.js
node --check D:\v\fastjs\utils\socket-browser.js
node --check D:\v\fastjs\utils\f.mjs
```

## Package and release

- Publication, installation, version bumps, and VSIX creation require explicit authorization. Ordinary changes use source-level checks only.
- Run `.\publish-local-plugin.cmd` for a local release. It bumps and rolls back package versions on failure, installs dependencies with lifecycle scripts disabled, builds the VSIX, and installs it. Use `-NoVersionBump` only for retries and `-SkipInstall` for package-only verification; ask the user to run **Developer: Reload Window** after installation.
- A release is complete only when the VSIX exists and syntax, dependency, and package checks pass. Keep verification output concise while preserving failures, unexpected warnings, and relevant diagnostics.
- Coordinated releases use the highest plugin version, bump once, update every version file, publish with `-NoVersionBump`, and verify the shared-version VSIX. Follow `D:\v\fastjs\AGENTS.md`.
- Do not commit npm caches, temporary package files, or generated VSIX files unless requested.
