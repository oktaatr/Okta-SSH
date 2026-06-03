# Okta SSHManage

Okta SSHManage is a macOS desktop application for managing SSH hosts, launching embedded SSH sessions, browsing files over SFTP, and running local port-forwarding rules from a focused desktop interface.

The app is built with Tauri, Rust, Vite, and vanilla JavaScript. It keeps the frontend lightweight while using Rust for local storage, SSH process control, SFTP operations, and desktop integration.

## Features

- Manage SSH host profiles with label, address, port, username, password, and tags.
- Search saved hosts by name, host, username, and tags.
- Open multiple SSH session tabs with an embedded xterm-based terminal.
- Start password-based SSH sessions with PTY resizing and live session status updates.
- Generate SSH command strings through the backend command layer.
- Browse local and remote files in a dual-pane SFTP-style file manager.
- Switch each file panel between the local computer and a saved SSH host.
- Upload local files to remote hosts and download selected remote files.
- Rename and delete selected local or remote files and folders.
- Create folders on active remote SFTP panels.
- Drag files and folders between supported local and remote panels.
- Track transfer progress and cancel supported uploads.
- Create, edit, search, start, and stop local port-forwarding rules.
- Store connection and port-forwarding data locally through the Tauri app data directory.
- Preview the frontend in a browser with localStorage-backed mock data.

## Tech Stack

- Tauri 2 for the desktop shell and native command bridge.
- Rust for backend commands, validation, local persistence, PTY sessions, SSH, SFTP, and port forwarding.
- Vite for frontend development and builds.
- Vanilla JavaScript for the application UI, state, and view-model layer.
- xterm.js for embedded terminal rendering.
- ssh2 and portable-pty for SSH, SFTP, and terminal process integration.

## Project Structure

```text
.
├── src/                    # Frontend application code
│   ├── data/               # Tauri command wrapper and browser preview API
│   ├── domain/             # Frontend domain entities and empty drafts
│   └── presentation/       # State, view models, and UI rendering
├── src-tauri/              # Tauri and Rust backend
│   ├── src/domain/         # Rust models and error types
│   ├── src/infrastructure/ # PTY, SSH, and SFTP registries/clients
│   ├── src/interfaces/     # Tauri command handlers and repositories
│   └── src/usecases/       # Connection, SSH, SFTP, and port-forwarding logic
├── index.html              # Vite entry HTML
├── package.json            # Node scripts and frontend dependencies
├── vite.config.js          # Vite configuration
└── Makefile                # Convenience commands for install, build, and local service tasks
```

## Requirements

- macOS
- Node.js and npm
- Rust toolchain
- Tauri system requirements for macOS development
- SSH access to target hosts for real SSH, SFTP, and port-forwarding usage

## Getting Started

Install dependencies:

```bash
npm install
```

Run the desktop app in development mode:

```bash
npm run desktop:dev
```

Run the frontend-only browser preview:

```bash
npm run dev
```

Build the frontend:

```bash
npm run build
```

Build the macOS desktop app bundle and DMG installer:

```bash
npm run desktop:build
```

The build output is generated under `src-tauri/target/release/bundle/`.

## Installing an Unsigned macOS Build

The app is not code-signed or notarized yet. macOS Gatekeeper may block the first launch with a warning that the developer cannot be verified.

For local testing, use one of these options:

1. Open the generated `.dmg` from `src-tauri/target/release/bundle/dmg/`.
2. Drag `Okta SSH.app` into `/Applications`.
3. Right-click `Okta SSH.app` and choose **Open**.
4. Confirm **Open** again when macOS shows the security warning.

If macOS still blocks the app, open **System Settings > Privacy & Security**, then click **Open Anyway** for `Okta SSH.app`.

As a local development fallback, you can remove the quarantine attribute after copying the app to `/Applications`:

```bash
xattr -dr com.apple.quarantine "/Applications/Okta SSH.app"
```

Only use the unsigned build on machines you trust. For distribution, the app should be signed with an Apple Developer ID certificate and notarized by Apple.

## Makefile Commands

The repository also includes convenience targets:

```bash
make install    # Install npm dependencies
make start      # Start the Vite web service on http://127.0.0.1:1420
make stop       # Stop the Vite web service
make restart    # Restart the Vite web service
make redeploy   # Install deps, rebuild frontend, rebuild desktop app/DMG, and restart the web service
make build      # Build the frontend
make desktop    # Build the macOS app bundle and DMG installer
make status     # Show local web service status
make clear      # Remove generated build, log, and runtime files
make uninstall  # Remove generated files, dependencies, and local app data
```

## Local Data

The desktop app stores its connection profiles and port-forwarding rules in the Tauri app data directory for `com.okta.sshmanage`, usually under `~/Library/Application Support/com.okta.sshmanage` on macOS.

The browser preview does not use the Rust backend. It stores mock connection and port-forwarding data in `localStorage` so the interface can be tested without launching Tauri.

## Security Notes

Current SSH and SFTP flows are password-based. Passwords are stored with the local connection profile data, so use the app only on a trusted machine and avoid sharing local app data files.

A future hardening step should move secrets into macOS Keychain or another encrypted secret store.

## Current Limitations

- Connection profiles currently require a password. Embedded SSH sessions and SFTP connections use password authentication; SSH key and SSH agent authentication are not implemented for the normal host workflow.
- Port forwarding currently creates local forwarding tunnels with `ssh -L`. Remote and dynamic forwarding modes are not implemented, even though the UI/model has room for rule types.
- The host data model includes fields for favorites and notes, but the current host form does not expose those fields.
- SFTP toolbar upload/download actions are file-focused, but folder transfer is supported through panel drag-and-drop for supported directions.
- Direct remote-to-remote SFTP transfer is not supported.
- Creating new folders is currently exposed for remote SFTP panels only, not local panels.
- Transfer cancellation is implemented for uploads; downloads do not currently share the same cancel path.
- The frontend-only browser preview uses localStorage-backed mock behavior and does not perform real SSH, SFTP, or port-forwarding operations.

## Roadmap

- Store secrets in macOS Keychain.
- Add import/export support for connection profiles.
- Add import support for common SSH config entries.
- Improve terminal session history and tab management.
- Expand port-forwarding modes beyond local forwarding.
- Add stronger automated tests around backend commands and transfer flows.
