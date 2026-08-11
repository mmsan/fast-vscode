# Fast VS Code Plugin — Agent Guide

## Project overview

This repository contains the SCS VS Code extension and the Fast Bridge client. The bridge connects VS Code editor state to the local Fast WebSocket service and accepts targeted navigation commands.

Keep these public identities stable:

- Extension ID: `mmsan.scs`
- Package name: `scs`
- Entry point: `extension.js`
- Bridge client value: `fast-vscode-bridge`
- Actual editor identity: `ide: Visual Studio Code`
- Current version: always read `version` from `package.json`; do not hard-code it in documentation or scripts.

The client value is recognized by `D:\v\fast\utils\vscode-socket.js`. Do not rename it without updating and validating that service.

## Important files

- `extension.js`: SCS formatting and extension activation.
- `fastBridge.js`: WebSocket lifecycle, snapshots, identities, reconnect behavior, and inbound commands.
- `package.json`: extension manifest, settings, commands, dependencies, and release version.
- `.vscodeignore`: controls VSIX contents.
- `publish-local-plugin.ps1`: local version bump, dependency restore, packaging, and VS Code installation.
- `publish-local-plugin.cmd`: execution-policy-safe Windows entry point.

## Bridge behavior and security

The default endpoint is `ws://127.0.0.1:19900`. Host, port, path, bearer token, auto-connect, text sharing, and context length must remain configurable.

Preserve `installationId`, `instanceId`, `connectionId`, deterministic project IDs, project roots, and open-project identities. Mutating commands require `target.instanceId`; commands for another instance must be ignored. Resolve files only inside an open workspace root and reject path traversal or absolute paths outside those roots.

Caret means the text insertion caret, not the mouse pointer. Do not add mouse-position collection unless explicitly requested. Keep text sharing controlled by `fastBridge.sendText`; when disabled, omit selected text and nearby text while retaining structural positions and ranges. Never log source text, selections, or bearer tokens.

When changing handshake fields, event names, commands, or payloads, inspect `D:\v\fast\utils\vscode-socket.js` and `D:\v\fast\utils\socket-browser.js`, and keep the Node.js routing backward compatible. Validate all three JavaScript files with `node --check`.

`D:\v\fast\fast.js` copies the active VS Code bridge file and workspace root onto `f.fast.currentWindow.filePath` and `f.fast.currentWindow.dir`. Preserve this binding when changing current-editor lookup behavior.

## Local publishing

For a normal local release, run:

```powershell
.\publish-local-plugin.cmd
```

The script must:

1. Increment the patch version in both `package.json` and `package-lock.json`.
2. Restore both files if dependency installation, packaging, or installation fails.
3. Install dependencies with lifecycle scripts disabled.
4. build `scs-<version>.vsix` with `@vscode/vsce`.
5. Install or update it with `code --install-extension ... --force`.
6. Tell the user to run `Developer: Reload Window`.

Use `-NoVersionBump` only to rebuild an existing version. Use `-SkipInstall` for packaging verification without changing the installed VS Code extension. A release is not complete until the VSIX exists and syntax, dependency, and package checks pass.

Recommended verification:

```powershell
node --check .\extension.js
node --check .\fastBridge.js
npm.cmd ls --depth=0
.\publish-local-plugin.cmd -NoVersionBump -SkipInstall
```

Do not commit npm caches, temporary packaging files, or generated VSIX files unless the user explicitly wants the artifact tracked.
