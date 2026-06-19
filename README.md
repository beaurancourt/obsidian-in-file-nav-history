# In-File Navigation History

An Obsidian plugin that adds **back / forward navigation through cursor and scroll positions** — including jumps *within* a single note.

Obsidian's built-in back/forward only steps between files. This plugin remembers where you were, so going "back" returns you to the exact cursor position and scroll offset you left — whether the jump crossed files or just followed a heading/block link inside the same note.

## Features

- Per-pane history of cursor + scroll positions.
- Captures **cross-file jumps** (Quick Switcher, command palette, links to other notes, graph, etc.).
- Captures **same-file jumps** via internal links, heading/block links, and outline / file-tree clicks.
- History is persisted across restarts and tied to each pane.
- Works in both editing and reading modes.
- Mobile-compatible (not desktop-only).

## Usage

The plugin adds two commands:

- **In-File Navigation History: Go back (cursor + scroll position)**
- **In-File Navigation History: Go forward (cursor + scroll position)**

No hotkeys are assigned by default. To bind them, open **Settings → Hotkeys**, search for "navigation history", and assign keys you like — for example:

| Command     | Suggested hotkey |
| ----------- | ---------------- |
| Go back     | `Cmd/Ctrl + [`   |
| Go forward  | `Cmd/Ctrl + ]`   |

## Installation

### From the Community Plugins list

1. Open **Settings → Community plugins** and disable Restricted Mode.
2. Click **Browse**, search for "In-File Navigation History", and install.
3. Enable the plugin.

### Manual

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/beaurancourt/obsidian-in-file-nav-history/releases/latest).
2. Copy them into `<your-vault>/.obsidian/plugins/in-file-nav-history/`.
3. Reload Obsidian and enable the plugin under **Settings → Community plugins**.

### Via BRAT

Add `beaurancourt/obsidian-in-file-nav-history` as a beta plugin in [BRAT](https://github.com/TfTHacker/obsidian42-brat).

## How it works

Each pane (leaf) keeps a back/forward stack of `{ path, cursor, scroll }` snapshots. The plugin watches editor activity to detect when a pane's file or position changes, and records the position you left behind. Navigating "back" reopens the file in the same pane (if needed) and restores the cursor and scroll via Obsidian's ephemeral state.

## License

[MIT](LICENSE)
