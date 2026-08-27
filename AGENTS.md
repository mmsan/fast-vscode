# Fast VS Code Plugin — Agent Guide

## Stable identity and scope

This repository contains the SCS VS Code extension and Fast Bridge client.

- Extension ID: `mmsan.scs`; package: `scs`; entry point: `extension.js`.
- Bridge client: `fast-vscode-bridge`; editor identity: `ide: Visual Studio Code`. Read the release version from `package.json`; never hard-code it.
- `fast-vscode-bridge` is recognized by `D:\v\fast\utils\socket-vscode.js`; update that service before changing the value.

Key surfaces: `extension.js` (activation/formatting), `fastBridge.js` (WebSocket, snapshots, identities, reconnect, commands, and rolling logs), `package.json` / `package-lock.json` (manifest/version/dependencies), and the publish scripts.

## Bridge behavior and security

- Default endpoint is `ws://127.0.0.1:19900`; keep host, port, path, bearer token, auto-connect, text sharing, and context length configurable.
- Preserve `installationId`, `instanceId`, `connectionId`, deterministic project IDs, project roots, and open-workspace identities. Mutating commands require `target.instanceId` and ignore other instances.
- Resolve files only inside open workspace roots; reject traversal and absolute paths outside them.
- `command.copyResourcePath` handles one or more focused Files Explorer files/directories. Return all absolute paths in `data.paths`, retain `data.path` for a single selection, and keep its Ctrl+Shift+C keybinding limited to Files Explorer filesystem resources so other contexts retain Fast Ctrl+Shift+C.
- A caret is the text insertion caret, not the mouse pointer. `fastBridge.sendText` controls text sharing; when disabled, omit selected/nearby text but retain structural ranges. Never log source text, selections, or bearer tokens.
- Preserve `D:\v\fast\fast.js` binding of the active file/workspace root to `f.fast.currentWindow.filePath` and `.dir`.
- Keep `Fast Bridge` diagnostics concise, use the VS Code `LogOutputChannel`, and delete plugin log files older than three days.

## Plugin log locations (on demand)

- Output channel: `Fast Bridge`, available through the `Fast Bridge: 显示日志` command.
- Daily file: `fast-vscode-bridge-YYYY-MM-DD.log` in VS Code's extension `logUri` directory.

When changing handshake fields, events, commands, or payloads, update the VS Code and generic Node adapters with backward-compatible routing, then run:

```powershell
node --check .\extension.js
node --check .\fastBridge.js
node --check D:\v\fast\utils\socket-vscode.js
node --check D:\v\fast\utils\socket-browser.js
node --check D:\v\fast\utils\f.mjs
```

## Local package publishing

Local publication or installation is an explicit user-authorized action, not a default verification step. After ordinary code changes, use syntax checks and package-only verification (`-SkipInstall`). Do not install the VSIX, bump a release solely for publication, or run the publishing workflow without `-SkipInstall` unless the user explicitly asks to publish locally, release a version, install it, or uses equivalent wording. A request to modify, fix, build, test, or verify does not authorize publication.

For a normal local release:

```powershell
.\publish-local-plugin.cmd
```

The script must:

1. Increment the patch version in `package.json` and `package-lock.json`.
2. Restore both files if dependency installation, packaging, or installation fails.
3. Install dependencies with lifecycle scripts disabled.
4. Build `scs-<version>.vsix` with `@vscode/vsce`.
5. Install/update it with `code --install-extension ... --force`.
6. Tell the user to run **Developer: Reload Window**.

Use `-NoVersionBump` only to retry an interrupted/manual version bump. Use `-SkipInstall` for package-only verification. A release is complete only when the VSIX exists and syntax, dependency, and package checks pass.

For a coordinated release, use the highest current version across IDEA, Visual Studio, and VS Code, increment the patch component once, write that exact version to `package.json`, `package-lock.json`, the IDEA property, the VSIX manifest/assembly files, and `D:\v\fast\bridge-version.json` when maintained. Then run this publisher with `-NoVersionBump`; do not let `npm version patch` create a different version. Verify the generated `scs-<shared-version>.vsix` before installation or reload.

Recommended verification:

```powershell
node --check .\extension.js
node --check .\fastBridge.js
npm.cmd ls --depth=0
.\publish-local-plugin.cmd -NoVersionBump -SkipInstall
```

Keep model-visible verification output concise. Successful `node --check` commands should normally produce no output; summarize `npm.cmd ls --depth=0` rather than returning the full dependency tree. When package verification is verbose, capture the complete `.\publish-local-plugin.cmd -NoVersionBump -SkipInstall` output in a local ignored or temporary log and report only the exit status, dependency/package check summary, and generated VSIX path and size. Routine npm/vsce chatter and repeated known warnings may be omitted from the model-visible success summary, but preserve nonzero exit codes, missing or extraneous dependency findings, packaging errors, unexpected warnings, and a short surrounding diagnostic excerpt.

Do not commit npm caches, temporary package files, or generated VSIX files unless explicitly requested.

## Three-plugin synchronization

Any shared event, command, identity, targeting, path-safety, text-sharing, reconnect, or disposal change must be updated across:

- Plugins: `D:\v\fast-idea` and `D:\v\fast-visual-studio`.
- Fast adapters: `D:\v\fast\utils\socket-idea.js`, `socket-visual-studio.js`, and `socket-vscode.js`.

Also update affected protocol documents and README examples. Keep VS Code-specific language/UI details local. For shared changes, verify all three installable packages with their repository procedures; source-level checks alone are insufficient.
