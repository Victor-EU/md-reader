import { type Binding, bindingMatches, formatBinding, parseBinding } from './keys.ts';

/**
 * Every action the shell can take is registered once, with an id, a title,
 * and a default shortcut. The palette, the menus, and the keymap are all
 * derived from this list — the only way principle 6 stays true as commands
 * are added (build plan, WP 1.3).
 */
export type MenuGroup = 'File' | 'Edit' | 'View' | 'Go' | 'Help';

export const MENU_ORDER: MenuGroup[] = ['File', 'Edit', 'View', 'Go', 'Help'];

export interface CommandSpec {
  id: string;
  title: string;
  group: MenuGroup;
  /** Platform-independent binding, `Mod` meaning Cmd or Ctrl. */
  key?: string;
  /** Overrides `key` on macOS, for the few shortcuts that differ. */
  macKey?: string;
  /** False greys the command out in the palette and makes the key a no-op. */
  enabled?: () => boolean;
  /** Bound but not listed: the nine tab jumps would drown the palette. */
  hidden?: boolean;
  run: () => unknown;
}

export interface Command extends CommandSpec {
  binding: Binding | null;
  /** The shortcut as this platform writes it, for the palette and the menus. */
  shortcut: string;
}

export interface Menu {
  group: MenuGroup;
  items: Command[];
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  constructor(private readonly mac: boolean) {}

  register(...specs: CommandSpec[]): void {
    for (const spec of specs) {
      if (this.commands.has(spec.id)) throw new Error(`command ${spec.id} is already registered`);
      const key = (this.mac ? spec.macKey : undefined) ?? spec.key;
      const binding = key ? parseBinding(key) : null;
      const shortcut = binding ? formatBinding(binding, this.mac) : '';
      this.commands.set(spec.id, { ...spec, binding, shortcut });
    }
  }

  get(id: string): Command {
    const command = this.commands.get(id);
    if (!command) throw new Error(`no command ${id}`);
    return command;
  }

  all(): Command[] {
    return [...this.commands.values()];
  }

  /** The commands the palette and the menus show. */
  listed(): Command[] {
    return this.all().filter((command) => !command.hidden);
  }

  isEnabled(command: Command): boolean {
    return command.enabled ? command.enabled() : true;
  }

  /**
   * The command a key event should run, disabled ones included: a bound key
   * belongs to the app whether or not the command can run right now, so it
   * never falls through to the webview's own default.
   */
  forEvent(event: KeyboardEvent): Command | null {
    for (const command of this.commands.values()) {
      if (command.binding && bindingMatches(command.binding, event, this.mac)) return command;
    }
    return null;
  }

  /** Runs the command if it is enabled. Returns what it did, for tests. */
  run(id: string): boolean {
    const command = this.get(id);
    if (!this.isEnabled(command)) return false;
    command.run();
    return true;
  }

  /** The menu bar and the palette's grouping, in one order. */
  menus(): Menu[] {
    return MENU_ORDER.map((group) => ({
      group,
      items: this.listed().filter((command) => command.group === group),
    })).filter((menu) => menu.items.length > 0);
  }
}
