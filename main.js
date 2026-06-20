'use strict';

const { Plugin, MarkdownView } = require('obsidian');

const MAX_HISTORY = 250;
const SAVE_DEBOUNCE_MS = 500;
// After a nav-intent click, wait this long before checking whether the
// position actually moved (lets the jump/scroll settle).
const JUMP_SETTLE_MS = 80;
// Clicks that count as navigation intent (vs. just placing the cursor):
// internal links (reading + live preview) and outline / tree items.
const NAV_CLICK_SELECTOR = '.internal-link, a.internal-link, .cm-hmd-internal-link, .tree-item-self';
// Search inputs whose focus means the user is about to jump: editor find
// (Cmd+F), quick switcher / command palette / heading search, and the global
// search panel. Focusing one anchors the pre-search position.
const SEARCH_INPUT_SELECTOR = '.document-search-input, .cm-search input, .prompt-input, .search-input-container input';
// After a search input blurs, keep the anchor this long so a result-click jump
// (which blurs the input before its position change registers) still consumes it.
const SEARCH_ANCHOR_GRACE_MS = 250;

module.exports = class InFileNavHistory extends Plugin {
  async onload() {
    // Per-pane navigation stacks, keyed by leaf id: { [leafId]: { back, fwd } }.
    // Persisted to disk; leaf ids are stable across restarts because Obsidian
    // restores the workspace layout with the same ids.
    this.history = {};
    // Live position per leaf, keyed by leaf id. Not persisted — the baseline
    // used to detect when a pane's file (or, on click, position) changed.
    this.snapshots = {};
    // Most recent markdown leaf, so outline/sidebar clicks (which steal focus)
    // still resolve to the editor pane they act on.
    this.lastMarkdownLeaf = null;
    // Suppresses recording while we are programmatically navigating.
    this.navigating = false;
    this._saveTimer = null;
    // Position to record when a search drives the editor somewhere new:
    // { leafId, entry }. Captured when a search input gains focus, consumed
    // (once) the first time the editor's position actually changes.
    this.searchAnchor = null;
    this._searchClearTimer = null;

    const data = await this.loadData();
    if (data && data.history) this.history = data.history;

    // Track the active pane's live position — and detect file changes — on any
    // activity. Quick Switcher (cmd+O), command palette, graph, links to other
    // files, etc. all surface here as a path change.
    const refresh = () => this.refresh();
    this.registerDomEvent(document, 'mouseup', refresh, true);
    this.registerDomEvent(document, 'keyup', refresh, true);
    this.registerDomEvent(document, 'scroll', refresh, true);
    this.registerEvent(this.app.workspace.on('editor-change', refresh));
    this.registerEvent(this.app.workspace.on('active-leaf-change', refresh));
    this.registerEvent(this.app.workspace.on('file-open', refresh));

    // Same-file jumps (heading/block links, outline clicks) don't change the
    // path, so catch the originating position before the jump.
    this.registerDomEvent(document, 'click', (evt) => this.onNavClick(evt), true);

    // Search jumps (editor find, switcher, search panel): anchor where the
    // editor was when the search input takes focus, so we can record the
    // pre-search position rather than each incremental match.
    this.registerDomEvent(document, 'focusin', (evt) => this.onSearchFocus(evt), true);
    this.registerDomEvent(document, 'focusout', (evt) => this.onSearchBlur(evt), true);

    // No default hotkeys: per Obsidian's plugin guidelines, leave them unbound
    // so users can assign their own (e.g. Mod+[ / Mod+]) without conflicts.
    this.addCommand({
      id: 'go-back',
      name: 'Go back (cursor + scroll position)',
      callback: () => this.navigate('back'),
    });

    this.addCommand({
      id: 'go-forward',
      name: 'Go forward (cursor + scroll position)',
      callback: () => this.navigate('fwd'),
    });

    // Baseline existing panes and drop history for panes that no longer exist.
    this.app.workspace.onLayoutReady(() => {
      const live = new Set();
      this.app.workspace.iterateAllLeaves((leaf) => {
        live.add(leaf.id);
        if (leaf.view instanceof MarkdownView) this.lastMarkdownLeaf = leaf;
        const entry = this.entryForLeaf(leaf);
        if (entry) this.snapshots[leaf.id] = entry;
      });
      for (const id of Object.keys(this.history)) {
        if (!live.has(id)) delete this.history[id];
      }
    });
  }

  onunload() {
    if (this._saveTimer) window.clearTimeout(this._saveTimer);
    if (this._searchClearTimer) window.clearTimeout(this._searchClearTimer);
    this.saveData({ history: this.history });
  }

  // The markdown leaf to act on. Falls back to the last active one so clicks in
  // the outline / sidebar (which can steal focus) still target the editor.
  markdownLeaf() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) {
      this.lastMarkdownLeaf = view.leaf;
      return view.leaf;
    }
    return this.lastMarkdownLeaf;
  }

  entryForLeaf(leaf) {
    if (!leaf) return null;
    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.file) return null;
    // getEphemeralState() returns { cursor, scroll } in exactly the shape
    // setEphemeralState()/openFile's eState expects — works in reading and
    // editing modes alike.
    return { path: view.file.path, state: view.getEphemeralState() };
  }

  stacksFor(leafId) {
    if (!this.history[leafId]) this.history[leafId] = { back: [], fwd: [] };
    return this.history[leafId];
  }

  // Update the active pane's snapshot, and if its file changed since we last
  // looked, record the position we left behind. This is where file-level jumps
  // (cmd+O et al.) get captured, regardless of which event fires first.
  refresh() {
    if (this.navigating) return;
    const leaf = this.markdownLeaf();
    if (!leaf) return;
    const entry = this.entryForLeaf(leaf);
    if (!entry) return;
    const prev = this.snapshots[leaf.id];
    if (prev && prev.path !== entry.path) {
      const stacks = this.stacksFor(leaf.id);
      this.pushEntry(stacks.back, prev);
      stacks.fwd.length = 0;
      this.scheduleSave();
      // The pre-jump position is already recorded as `prev`; drop the anchor.
      this.searchAnchor = null;
    } else if (
      this.searchAnchor &&
      this.searchAnchor.leafId === leaf.id &&
      this.searchAnchor.entry.path === entry.path &&
      !sameEntry(this.searchAnchor.entry, entry)
    ) {
      // Same-file search jump (editor find, heading switcher, in-file search
      // result): record where the search started, once per search session.
      const stacks = this.stacksFor(leaf.id);
      this.pushEntry(stacks.back, this.searchAnchor.entry);
      stacks.fwd.length = 0;
      this.scheduleSave();
      this.searchAnchor = null;
    }
    this.snapshots[leaf.id] = entry;
  }

  onSearchFocus(evt) {
    const el = evt.target;
    if (!el || !el.closest || !el.closest(SEARCH_INPUT_SELECTOR)) return;
    if (this._searchClearTimer) {
      window.clearTimeout(this._searchClearTimer);
      this._searchClearTimer = null;
    }
    const leaf = this.markdownLeaf();
    if (!leaf) return;
    const entry = this.entryForLeaf(leaf);
    if (!entry) return;
    // Anchor the editor's position before the search starts moving the cursor.
    this.searchAnchor = { leafId: leaf.id, entry };
  }

  onSearchBlur(evt) {
    const el = evt.target;
    if (!el || !el.closest || !el.closest(SEARCH_INPUT_SELECTOR)) return;
    // Keep the anchor briefly: a result click blurs the input before its
    // position change registers in refresh(). After the grace window, drop it
    // so an unrelated later cursor move isn't mistaken for a search jump.
    if (this._searchClearTimer) window.clearTimeout(this._searchClearTimer);
    this._searchClearTimer = window.setTimeout(() => {
      this.searchAnchor = null;
      this._searchClearTimer = null;
    }, SEARCH_ANCHOR_GRACE_MS);
  }

  onNavClick(evt) {
    const el = evt.target;
    if (!el || !el.closest || !el.closest(NAV_CLICK_SELECTOR)) return;
    const leaf = this.markdownLeaf();
    if (!leaf) return;
    const before = this.entryForLeaf(leaf);
    if (!before) return;
    // Anchor the pre-jump position so a cross-file jump records exactly this.
    this.snapshots[leaf.id] = before;
    window.setTimeout(() => {
      const after = this.entryForLeaf(leaf);
      if (!after) return;
      // Cross-file jumps are recorded by refresh() via the path change; here we
      // only handle same-file jumps, and only if the position actually moved.
      if (after.path === before.path && JSON.stringify(after.state) !== JSON.stringify(before.state)) {
        const stacks = this.stacksFor(leaf.id);
        this.pushEntry(stacks.back, before);
        stacks.fwd.length = 0;
        this.scheduleSave();
      }
    }, JUMP_SETTLE_MS);
  }

  pushEntry(stack, entry) {
    if (!entry) return;
    const top = stack[stack.length - 1];
    if (sameEntry(top, entry)) return;
    stack.push(entry);
    if (stack.length > MAX_HISTORY) stack.shift();
  }

  async navigate(direction) {
    const leaf = this.markdownLeaf();
    if (!leaf) return;
    const stacks = this.stacksFor(leaf.id);
    const from = direction === 'back' ? stacks.back : stacks.fwd;
    const to = direction === 'back' ? stacks.fwd : stacks.back;
    if (from.length === 0) return;

    const current = this.entryForLeaf(leaf);
    const target = from.pop();
    if (current) this.pushEntry(to, current);

    // Our own restore must not be picked up as a search jump.
    this.searchAnchor = null;
    this.navigating = true;
    try {
      if (current && current.path === target.path) {
        // Same file: just restore cursor + scroll.
        leaf.view.setEphemeralState(target.state);
      } else {
        // Different file: reopen it in this same pane, then restore position.
        const file = this.app.vault.getAbstractFileByPath(target.path);
        if (file) {
          await leaf.openFile(file, { eState: target.state, active: true });
        }
      }
      this.snapshots[leaf.id] = target;
      this.scheduleSave();
    } finally {
      // Let the view settle before re-enabling recording, so the restore
      // itself isn't misread as a navigation.
      window.setTimeout(() => {
        this.navigating = false;
      }, 60);
    }
  }

  scheduleSave() {
    if (this._saveTimer) window.clearTimeout(this._saveTimer);
    this._saveTimer = window.setTimeout(() => {
      this._saveTimer = null;
      this.saveData({ history: this.history });
    }, SAVE_DEBOUNCE_MS);
  }
};

function sameEntry(a, b) {
  return !!a && !!b && a.path === b.path && JSON.stringify(a.state) === JSON.stringify(b.state);
}
