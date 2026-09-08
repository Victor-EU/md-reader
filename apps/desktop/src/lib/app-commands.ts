import { palette } from '@mdreader/markdown';
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
    {
      id: 'file.convert',
      title: 'Convert to UTF-8',
      group: 'File',
      enabled: () => workspace.activeDoc?.meta?.read_only === true,
      run: () => workspace.convertToUtf8(),
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
    {
      id: 'file.settings',
      title: 'Settings',
      group: 'File',
      key: 'Mod+,',
      run: () => workspace.openSettings(),
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
    {
      id: 'edit.markReviewed',
      title: 'Mark Reviewed',
      group: 'Edit',
      enabled: () => workspace.unreviewed > 0,
      run: () => workspace.markReviewed(),
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
    {
      id: 'view.sidebar',
      title: 'Toggle Sidebar',
      group: 'View',
      key: 'Mod+Shift+B',
      run: () => workspace.toggleSidebar(),
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
