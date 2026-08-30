# Fast VS Code Plugin — Agent Guide

## Stable identity and scope

This repository contains the SCS VS Code extension and Fast Bridge client.

- Extension ID: `mmsan.scs`; package: `scs`; entry point: `extension.js`.
- Bridge client: `fast-vscode-bridge`; editor identity: `ide: Visual Studio Code`. Read the release version from `package.json`; never hard-code it.
- `fast-vscode-bridge` is recognized by `D:\v\fastjs\utils\socket-vscode.js`; update that service before changing the value.

Key surfaces: `extension.js` (activation/formatting), `fastBridge.js` (WebSocket, snapshots, identities, reconnect, commands, and rolling logs), `package.json` / `package-lock.json` (manifest/version/dependencies), and the publish scripts.

## Shared rules

See `D:\v\fast-idea\AGENTS.md` under **Shared editor-bridge rules**. Do not duplicate shared protocol, focus/search semantics, performance constraints, privacy rules, targeting, reconnect, or cross-plugin synchronization rules here.

## VS Code-specific bridge rules

- Keep `command.copyResourcePath` and its Ctrl+Shift+C override scoped to Files Explorer resources; inspect the implementation for response fields.
- A caret is the text insertion caret, not the mouse pointer. `fastBridge.sendText` controls text sharing; when disabled, omit selected/nearby text but retain structural ranges.
- Preserve `D:\v\fastjs\fast.js` binding of the active file/workspace root to `f.fast.currentWindow.filePath` and `.dir`.
- Keep `Fast Bridge` diagnostics concise, use the VS Code `LogOutputChannel`, and delete plugin log files older than three days.

## Plugin log locations (on demand)

- Output channel: `Fast Bridge`, available through the `Fast Bridge: 显示日志` command.
- Daily file: `fast-vscode-bridge-YYYY-MM-DD.log` in VS Code's extension `logUri` directory.

When changing handshake fields, events, commands, or payloads, update the VS Code and generic Node adapters with backward-compatible routing, then run:

```powershell
node --check .\extension.js
node --check .\fastBridge.js
node --check D:\v\fastjs\utils\socket-vscode.js
node --check D:\v\fastjs\utils\socket-browser.js
node --check D:\v\fastjs\utils\f.mjs
```

## Local package publishing

Local publication or installation is an explicit user-authorized action, not a default verification step. After ordinary code changes, use source-level syntax or dependency checks. Do not create or install the VSIX, bump a release solely for publication, or run the publishing workflow unless the user explicitly asks to build a package, verify a package, publish locally, release a version, or install it.

For ordinary code changes, the user prefers source-level validation only. Do not create a VSIX unless the user explicitly asks to build a package, verify a package, publish, install, or release. Use the narrowest relevant syntax or dependency check instead.

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

For a coordinated release, use the highest current version across IDEA, Visual Studio, and VS Code, increment the patch component once, write that exact version to `package.json`, `package-lock.json`, the IDEA property, the VSIX manifest/assembly files, and `D:\v\fastjs\bridge-version.json` when maintained. Then run this publisher with `-NoVersionBump`; do not let `npm version patch` create a different version. Verify the generated `scs-<shared-version>.vsix` before installation or reload.

Recommended verification:

```powershell
node --check .\extension.js
node --check .\fastBridge.js
npm.cmd ls --depth=0
.\publish-local-plugin.cmd -NoVersionBump -SkipInstall
```

Keep model-visible verification output concise. Successful `node --check` commands should normally produce no output; summarize `npm.cmd ls --depth=0` rather than returning the full dependency tree. When package verification is verbose, capture the complete `.\publish-local-plugin.cmd -NoVersionBump -SkipInstall` output in a local ignored or temporary log and report only the exit status, dependency/package check summary, and generated VSIX path and size. Routine npm/vsce chatter and repeated known warnings may be omitted from the model-visible success summary, but preserve nonzero exit codes, missing or extraneous dependency findings, packaging errors, unexpected warnings, and a short surrounding diagnostic excerpt.

Do not commit npm caches, temporary package files, or generated VSIX files unless explicitly requested.

## Cross-project changes

Follow the shared rules in `D:\v\fast-idea\AGENTS.md`. Keep VS Code-specific language/UI details local and use the package verification procedure for all three plugins when a shared change is made.
