import { registerAppCommands } from './app-commands.ts';
import { CommandRegistry } from './commands.ts';
import { isMac } from './platform.ts';
import { Workspace, type WorkspaceOptions } from './workspace.svelte.ts';

export interface Shell {
  workspace: Workspace;
  registry: CommandRegistry;
}

/** The window's two pieces, wired together. Tests build one with the fake IPC. */
export function createShell(options: WorkspaceOptions & { mac?: boolean }): Shell {
  const workspace = new Workspace(options);
  const registry = new CommandRegistry(options.mac ?? isMac);
  registerAppCommands(registry, workspace);
  return { workspace, registry };
}
