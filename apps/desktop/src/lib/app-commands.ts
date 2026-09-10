import { palette } from '@markdown/markdown';
import type { CommandRegistry, CommandSpec } from './commands.ts';
import type { Workspace } from './workspace.svelte.ts';

/**
 * Every action the shell offers, in one list. The menus, the palette, and
 * the keymap are derived from it, so a new command is one entry here and
 * appears in all three (build plan, WP 1.3).
 */
export function appCommands(workspace: Workspace): CommandSpec[] {
  const hasTab = () => workspace.activeTab !== null;
  /**
   * Not every tab is a document — Settings is one too (plan WP 1.9) — so
   * anything that acts on the text asks for the document rather than the
   * tab that would usually have one.
   */
  const hasDoc = () => workspace.activeDoc !== null;
  /**
   * Find is the one thing a PDF shares with a document, and it shares
   * only the bar: what it searches is text extracted from the pages
   * rather than a buffer (ADR 0035). Replace is not shared, because a
   * PDF is read here and never written.
   */
  const canFind = () => workspace.activeDoc !== null || workspace.activePdf !== null;
  return [
    {
      id: 'file.new',
      title: 'New File',
      group: 'File',
      key: 'Mod+N',
      run: () => workspace.newUntitled(),
    },
    {
      id: 'file.open',
      title: 'Open File…',
      group: 'File',
      key: 'Mod+O',
      run: () => workspace.pickAndOpen(),
    },
    {
      id: 'file.save',
      title: 'Save',
      group: 'File',
      key: 'Mod+S',
      enabled: () => workspace.canSave,
      run: () => workspace.save(),
    },
    // The folder workspace (design 4.1, scenario S6). Cmd+Shift+O is
    // Cmd+O with more of the same gesture in it: the open panel, asking
    // for a folder rather than a file.
    {
      id: 'file.openFolder',
      title: 'Open Folder…',
      group: 'File',
      key: 'Mod+Shift+O',
      run: () => workspace.pickAndOpenFolder(),
    },
    {
      id: 'file.closeFolder',
      title: 'Close Folder',
      group: 'File',
      enabled: () => workspace.folder.root !== null,
      run: () => workspace.closeFolder(),
    },
    {
      id: 'file.newInFolder',
      title: 'New File in Folder',
      group: 'File',
      enabled: () => workspace.folder.root !== null,
      run: () => workspace.newFileInFolder(),
    },
    {
      id: 'file.convert',
      title: 'Convert to UTF-8',
      group: 'File',
      enabled: () => workspace.activeDoc?.meta?.read_only === 'encoding',
      run: () => workspace.convertToUtf8(),
    },
    // A copy of the document that opens anywhere, with no app around it
    // (plan WP 3.2). It asks where to put it, which is the second of the
    // two dialogs design 4.5 allows.
    {
      id: 'file.exportHtml',
      title: 'Export as HTML…',
      group: 'File',
      enabled: hasDoc,
      run: () => void workspace.exportHtml(),
    },
    {
      id: 'file.close',
      title: 'Close Tab',
      group: 'File',
      key: 'Mod+W',
      enabled: hasTab,
      run: () => workspace.closeActive(),
    },
    {
      id: 'file.reopen',
      title: 'Reopen Closed Tab',
      group: 'File',
      key: 'Mod+Shift+T',
      enabled: () => workspace.canReopen,
      run: () => workspace.reopenClosed(),
    },
    // A second window (design 4.1). Dragging a tab out of the strip is
    // the gesture for the same thing; these are for the keyboard.
    {
      id: 'file.newWindow',
      title: 'New Window',
      group: 'File',
      key: 'Mod+Shift+N',
      run: () => workspace.newWindow(),
    },
    {
      id: 'file.moveToWindow',
      title: 'Move Tab to New Window',
      group: 'File',
      // A PDF travels as a path rather than as a buffer, but it travels
      // (ADR 0035). Settings is the tab that stays where it is.
      enabled: () => {
        const kind = workspace.activeTab?.kind;
        return kind === 'document' || kind === 'pdf';
      },
      run: () => workspace.tearOffActive(),
    },
    {
      id: 'file.settings',
      title: 'Settings',
      group: 'File',
      key: 'Mod+,',
      run: () => workspace.openSettings(),
    },
    // Undo and redo are the app's rather than the standard menu items;
    // `Workspace.undo` says why, and why they have to answer for a plain
    // text field as well as for the document.
    {
      id: 'edit.undo',
      title: 'Undo',
      group: 'Edit',
      key: 'Mod+Z',
      run: () => workspace.undo(),
    },
    {
      id: 'edit.redo',
      title: 'Redo',
      group: 'Edit',
      key: 'Mod+Shift+Z',
      run: () => workspace.redo(),
    },
    // The four inline marks (design 4.5). Cmd+B, Cmd+I, Cmd+K, Cmd+E are
    // the shortcuts every editor has; the palette lists them by name.
    {
      id: 'edit.bold',
      title: 'Bold',
      group: 'Edit',
      key: 'Mod+B',
      enabled: hasDoc,
      run: () => workspace.bold(),
    },
    {
      id: 'edit.italic',
      title: 'Italic',
      group: 'Edit',
      key: 'Mod+I',
      enabled: hasDoc,
      run: () => workspace.italic(),
    },
    {
      id: 'edit.link',
      title: 'Link',
      group: 'Edit',
      key: 'Mod+K',
      enabled: hasDoc,
      run: () => workspace.link(),
    },
    {
      id: 'edit.code',
      title: 'Code',
      group: 'Edit',
      key: 'Mod+E',
      enabled: hasDoc,
      run: () => workspace.code(),
    },
    {
      id: 'edit.highlight',
      title: 'Highlight',
      group: 'Edit',
      key: 'Mod+Shift+H',
      enabled: hasDoc,
      run: () => workspace.highlight(),
    },
    {
      id: 'edit.strikethrough',
      title: 'Strikethrough',
      group: 'Edit',
      key: 'Mod+Shift+X',
      enabled: hasDoc,
      run: () => workspace.strikethrough(),
    },
    {
      id: 'edit.comment',
      title: 'Add Comment',
      group: 'Edit',
      key: 'Mod+Shift+M',
      enabled: hasDoc,
      run: () => workspace.comment('note'),
    },
    // The five-meaning palette (design 4.3). Each colours the selection
    // and pre-fills the comment that carries the meaning to a model.
    ...palette.map((entry) => ({
      id: `edit.color.${entry.meaning}`,
      title: `Mark as ${entry.title}`,
      group: 'Edit' as const,
      enabled: hasDoc,
      run: () => workspace.color(entry.meaning),
    })),
    // Find and replace (design 4.5). Cmd+F opens the bar; Cmd+G steps
    // through the matches whether or not the bar has the keyboard.
    {
      id: 'edit.find',
      title: 'Find…',
      group: 'Edit',
      key: 'Mod+F',
      enabled: canFind,
      run: () => workspace.openFind(false),
    },
    {
      id: 'edit.replace',
      title: 'Find and Replace…',
      group: 'Edit',
      key: 'Mod+Alt+F',
      enabled: hasDoc,
      run: () => workspace.openFind(true),
    },
    {
      id: 'edit.findNext',
      title: 'Find Next',
      group: 'Edit',
      key: 'Mod+G',
      enabled: () => workspace.find.query !== '',
      run: () => workspace.findStep(true),
    },
    {
      id: 'edit.findPrevious',
      title: 'Find Previous',
      group: 'Edit',
      key: 'Mod+Shift+G',
      enabled: () => workspace.find.query !== '',
      run: () => workspace.findStep(false),
    },
    // Cmd+Shift+F is Cmd+F over the folder instead of the document
    // (design 4.1). The results are a sidebar panel, so the same key
    // opens the sidebar and puts the keyboard in the field.
    {
      id: 'edit.findInFolder',
      title: 'Find in Folder…',
      group: 'Edit',
      key: 'Mod+Shift+F',
      enabled: () => workspace.folder.root !== null,
      run: () => workspace.findInFolder(),
    },
    // Stepping through what an agent changed, then saying it has been
    // seen (design scenario S4). `G` because these are the siblings of
    // Find Next and Find Previous: the same gesture over a different
    // list.
    {
      id: 'edit.nextChange',
      title: 'Next Change',
      group: 'Edit',
      key: 'Mod+Alt+G',
      enabled: () => workspace.unreviewed > 0,
      run: () => workspace.stepChange(true),
    },
    {
      id: 'edit.previousChange',
      title: 'Previous Change',
      group: 'Edit',
      key: 'Mod+Alt+Shift+G',
      enabled: () => workspace.unreviewed > 0,
      run: () => workspace.stepChange(false),
    },
    {
      id: 'edit.markReviewed',
      title: 'Mark Reviewed',
      group: 'Edit',
      enabled: () => workspace.unreviewed > 0,
      run: () => workspace.markReviewed(),
    },
    // The other half of the review walk: step to a change, put it back.
    // Mod+Alt+Z because that is what it is — an undo of one change,
    // reached from beside the undo of one edit.
    {
      id: 'edit.revertChange',
      title: 'Revert This Change',
      group: 'Edit',
      key: 'Mod+Alt+Z',
      enabled: () => workspace.unreviewed > 0,
      run: () => workspace.revertHere(),
    },
    // Settling a hunk both sides wrote (scenario S5). No shortcuts:
    // the choice is two buttons in the widget itself, and a reader who
    // has one open reaches it from the status bar or the palette. Three
    // more chords for something that happens once in a session would be
    // three fewer left for something that happens all the time.
    {
      id: 'edit.nextConflict',
      title: 'Next Conflict',
      group: 'Edit',
      enabled: () => workspace.unsettled > 0,
      run: () => workspace.stepConflict(),
    },
    {
      id: 'edit.keepMine',
      title: 'Keep Mine',
      group: 'Edit',
      enabled: () => workspace.unsettled > 0,
      run: () => workspace.settleConflict(true),
    },
    {
      id: 'edit.takeTheirs',
      title: 'Take Theirs',
      group: 'Edit',
      enabled: () => workspace.unsettled > 0,
      run: () => workspace.settleConflict(false),
    },
    {
      id: 'edit.copyForAi',
      title: 'Copy for AI',
      group: 'Edit',
      key: 'Mod+Shift+C',
      enabled: hasDoc,
      run: () => workspace.copyForAi(),
    },
    {
      id: 'edit.copyMarkdown',
      title: 'Copy as Markdown',
      group: 'Edit',
      enabled: hasDoc,
      run: () => workspace.copyMarkdown(),
    },
    {
      id: 'edit.copyRichText',
      title: 'Copy as Rich Text',
      group: 'Edit',
      enabled: hasDoc,
      run: () => workspace.copyRichText(),
    },
    {
      id: 'view.read',
      title: 'Read Mode',
      group: 'View',
      key: 'Mod+Alt+R',
      enabled: hasDoc,
      run: () => workspace.setMode('read'),
    },
    {
      id: 'view.edit',
      title: 'Edit Mode',
      group: 'View',
      key: 'Mod+Alt+E',
      enabled: hasDoc,
      run: () => workspace.setMode('edit'),
    },
    {
      id: 'view.source',
      title: 'Source Mode',
      group: 'View',
      key: 'Mod+Alt+S',
      enabled: hasDoc,
      run: () => workspace.setMode('source'),
    },
    // Review mode: the changes told rather than marked, with a way to
    // put each one back (design 4.4). Cmd+Shift+R is the design's own
    // shortcut for it.
    {
      id: 'view.review',
      title: 'Review Changes',
      group: 'View',
      key: 'Mod+Shift+R',
      enabled: hasDoc,
      run: () => workspace.toggleReview(),
    },
    {
      id: 'view.sidebar',
      title: 'Toggle Sidebar',
      group: 'View',
      key: 'Mod+Shift+B',
      run: () => workspace.toggleSidebar(),
    },
    {
      id: 'view.files',
      title: 'Show Files',
      group: 'View',
      run: () => workspace.showPanel('files'),
    },
    {
      id: 'view.outline',
      title: 'Show Outline',
      group: 'View',
      run: () => workspace.showPanel('outline'),
    },
    {
      id: 'view.history',
      title: 'Show History',
      group: 'View',
      run: () => workspace.showPanel('history'),
    },
    {
      id: 'view.comments',
      title: 'Show Comments',
      group: 'View',
      run: () => workspace.toggleComments(),
    },
    {
      id: 'view.remoteImages',
      title: 'Load Remote Images in This Document',
      group: 'View',
      enabled: hasDoc,
      run: () => workspace.toggleRemoteImages(),
    },
    // Zoom is the reading size (design 4.5): one number, which the
    // settings tab shows and the session remembers.
    {
      id: 'view.zoomIn',
      title: 'Zoom In',
      group: 'View',
      key: 'Mod+=',
      run: () => workspace.zoom(1),
    },
    {
      id: 'view.zoomOut',
      title: 'Zoom Out',
      group: 'View',
      key: 'Mod+-',
      run: () => workspace.zoom(-1),
    },
    {
      id: 'view.zoomReset',
      title: 'Actual Size',
      group: 'View',
      key: 'Mod+0',
      run: () => workspace.resetZoom(),
    },
    // The reading settings where the document is, rather than in the tab
    // that edits the app's (plan WP 2.6): every change previews itself on
    // the page it is about, and the panel says which of the two it is
    // writing to.
    {
      id: 'view.reading',
      title: 'Reading…',
      group: 'View',
      key: 'Mod+Shift+,',
      run: () => workspace.toggleReading(),
    },
    {
      id: 'view.ownSettings',
      title: 'Read This Document in the App’s Settings',
      group: 'View',
      enabled: () => workspace.overridden,
      run: () => void workspace.clearOverride(),
    },
    {
      id: 'view.duplicate',
      title: 'Open a Second View',
      group: 'View',
      enabled: hasDoc,
      run: () => workspace.duplicateView(),
    },
    {
      id: 'go.quickOpen',
      title: 'Quick Open…',
      group: 'Go',
      key: 'Mod+P',
      run: () => workspace.openPalette('files'),
    },
    {
      id: 'go.newTab',
      title: 'New Tab',
      group: 'Go',
      key: 'Mod+T',
      run: () => workspace.openPalette('files'),
    },
    {
      id: 'go.commands',
      title: 'Command Palette…',
      group: 'Go',
      key: 'Mod+Shift+P',
      run: () => workspace.openPalette('commands'),
    },
    // Pinning has been a double-click on a tab since WP 2.8 and nothing
    // else; this is the name of it, for the palette and the menu bar.
    {
      id: 'go.pin',
      title: 'Pin Tab',
      label: () => (workspace.activePinned ? 'Unpin Tab' : 'Pin Tab'),
      group: 'Go',
      enabled: hasTab,
      run: () => workspace.togglePinActive(),
    },
    {
      id: 'go.next',
      title: 'Next Tab',
      group: 'Go',
      key: 'Mod+Shift+]',
      enabled: hasTab,
      run: () => workspace.cycle(1),
    },
    {
      id: 'go.previous',
      title: 'Previous Tab',
      group: 'Go',
      key: 'Mod+Shift+[',
      enabled: hasTab,
      run: () => workspace.cycle(-1),
    },
    // The agent server (design 9, plan WP 3.1). Two commands, because
    // there are exactly two things a person ever has to do about it:
    // connect something to it, and stop something being connected.
    {
      id: 'edit.copyAgentConfig',
      title: 'Copy Agent Client Configuration',
      group: 'Edit',
      enabled: () => workspace.agent.port !== 0,
      run: () => workspace.copyAgentConfig(),
    },
    {
      id: 'edit.rotateAgentToken',
      title: 'Rotate the Agent Token',
      group: 'Edit',
      enabled: () => workspace.agent.port !== 0,
      run: () => workspace.rotateAgentToken(),
    },
    // The updater (plan WP 1.12). The status bar offers the same two
    // actions where they can be seen; these are so the keyboard can
    // reach them, and so the palette says what the app can do.
    {
      id: 'help.checkUpdates',
      title: 'Check for Updates…',
      group: 'Help',
      run: () => workspace.checkForUpdates(true),
    },
    {
      id: 'help.installUpdate',
      title: 'Install Update',
      group: 'Help',
      enabled: () => workspace.update.phase === 'available',
      run: () => workspace.installUpdate(),
    },
    {
      id: 'help.restart',
      title: 'Restart to Update',
      group: 'Help',
      enabled: () => workspace.update.phase === 'ready',
      run: () => workspace.restartForUpdate(),
    },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
      id: `go.tab${n}`,
      title: n === 9 ? 'Last Tab' : `Tab ${n}`,
      group: 'Go' as const,
      key: `Mod+${n}`,
      hidden: true,
      enabled: hasTab,
      run: () => workspace.activateIndex(n),
    })),
  ];
}

export function registerAppCommands(registry: CommandRegistry, workspace: Workspace): void {
  registry.register(...appCommands(workspace));
}
