import type { CommandRegistry, CommandSpec } from './commands.ts';
import type { Workspace } from './workspace.svelte.ts';

/**
 * Every action the shell offers, in one list. The menus, the palette, and
 * the keymap are derived from it, so a new command is one entry here and
 * appears in all three (build plan, WP 1.3).
 */
export function appCommands(workspace: Workspace): CommandSpec[] {
  const hasTab = () => workspace.activeTab !== null;
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
      id: 'view.read',
      title: 'Read Mode',
      group: 'View',
      key: 'Mod+Alt+R',
      enabled: hasTab,
      run: () => workspace.setMode('read'),
    },
    {
      id: 'view.edit',
      title: 'Edit Mode',
      group: 'View',
      key: 'Mod+Alt+E',
      enabled: hasTab,
      run: () => workspace.setMode('edit'),
    },
    {
      id: 'view.source',
      title: 'Source Mode',
      group: 'View',
      key: 'Mod+Alt+S',
      enabled: hasTab,
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
      id: 'view.remoteImages',
      title: 'Load Remote Images in This Document',
      group: 'View',
      enabled: hasTab,
      run: () => workspace.toggleRemoteImages(),
    },
    {
      id: 'view.duplicate',
      title: 'Open a Second View',
      group: 'View',
      enabled: hasTab,
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
