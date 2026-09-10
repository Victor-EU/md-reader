//! The macOS menu bar (build plan section 8).
//!
//! The items are not written here. Every action the app has is registered
//! once in the shell's command registry with an id, a title and a key, and
//! the palette, the keymap and this menu are three views of that one list
//! (plan WP 1.3) — so the window describes the menus it wants and Rust
//! builds them. What Rust adds is only what a registry cannot hold: the
//! standard items, which are `AppKit` selectors rather than commands of the
//! app's, and Quit, which is this app's own for the reason below.
//!
//! Only macOS is served from here. Elsewhere a menu is drawn inside the
//! window, and this window's top edge is a tab strip (plan WP 2.8) with
//! nowhere to put one; Windows menus are section 8's Windows work.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::menu::{
    AboutMetadata, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Manager, Wry};
use tauri_specta::Event;

/// Quit, as an item of the app's own rather than the standard one.
///
/// `PredefinedMenuItem::quit` is `NSApplication.terminate:`, which reaches
/// the app as `RunEvent::Exit` with no window close and no exit request —
/// far too late to ask a webview for anything (see `before_exit`). An
/// ordinary item that calls `AppHandle::exit` raises `ExitRequested`
/// instead, which is the round trip closing a window already gets: every
/// window is asked to write down what it holds, and the quit waits for the
/// answers. Tauri installs its default menu when an app sets none, so
/// until there was a menu bar this was the quit the app had.
const QUIT: &str = "app.quit";

/// One of the standard items: what it does belongs to `AppKit` rather than
/// to this app, so the window can only say where it goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum MenuRole {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Zoom,
    Fullscreen,
    BringAllToFront,
}

impl MenuRole {
    /// The name this role goes by in a menu's shape, which is how a
    /// description that only changes state is told from a new menu.
    fn name(self) -> &'static str {
        match self {
            Self::About => "about",
            Self::Services => "services",
            Self::Hide => "hide",
            Self::HideOthers => "hide_others",
            Self::ShowAll => "show_all",
            Self::Quit => "quit",
            Self::Cut => "cut",
            Self::Copy => "copy",
            Self::Paste => "paste",
            Self::SelectAll => "select_all",
            Self::Minimize => "minimize",
            Self::Zoom => "zoom",
            Self::Fullscreen => "fullscreen",
            Self::BringAllToFront => "bring_all_to_front",
        }
    }
}

/// One line of a menu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MenuEntry {
    /// One of the app's own commands, by the id its registry knows it by.
    /// That id is what comes back when the item is chosen, so the window
    /// runs the command the same way the palette and a key run it.
    Command {
        id: String,
        title: String,
        /// Tauri's accelerator spelling, absent for a command with no key.
        accelerator: Option<String>,
        enabled: bool,
    },
    Standard {
        role: MenuRole,
    },
    Separator,
}

impl MenuEntry {
    fn name(&self) -> String {
        match self {
            Self::Command { id, .. } => format!("command:{id}"),
            Self::Standard { role } => format!("standard:{}", role.name()),
            Self::Separator => "separator".to_owned(),
        }
    }
}

/// One menu of the bar, named as the registry's groups are named.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct MenuSection {
    pub title: String,
    pub items: Vec<MenuEntry>,
}

/// A menu item was chosen in the window that has the keyboard.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
pub struct MenuCommandEvent(pub String);

/// The bar as it stands, so a window that only wants an item greyed out
/// does not rebuild the menu the pointer may be inside.
#[derive(Default)]
pub struct Bar {
    /// What the bar is made of, in order. A description that matches this
    /// is a change of state; one that does not is a different menu.
    shape: Vec<String>,
    /// The app's own items, by command id.
    items: HashMap<String, MenuItem<Wry>>,
    /// The title and enabled state each was last given, so an unchanged
    /// item is not written to. Every write is a hop to the main thread.
    state: HashMap<String, (String, bool)>,
}

/// What the shape of a description is, for that comparison.
fn shape(sections: &[MenuSection]) -> Vec<String> {
    sections
        .iter()
        .flat_map(|section| {
            std::iter::once(format!("menu:{}", section.title))
                .chain(section.items.iter().map(MenuEntry::name))
        })
        .collect()
}

/// Draw this description of the menu bar.
///
/// # Errors
/// Fails when a menu item cannot be built or installed.
pub fn apply(app: &AppHandle, bar: &mut Bar, sections: &[MenuSection]) -> tauri::Result<()> {
    let wanted = shape(sections);
    if bar.shape != wanted {
        let (menu, items) = build(app, sections)?;
        install(&menu)?;
        bar.shape = wanted;
        bar.items = items;
        bar.state.clear();
    }
    let Bar { items, state, .. } = bar;
    for entry in sections.iter().flat_map(|section| &section.items) {
        let MenuEntry::Command {
            id, title, enabled, ..
        } = entry
        else {
            continue;
        };
        let Some(item) = items.get(id) else { continue };
        let now = (title.clone(), *enabled);
        if state.get(id) == Some(&now) {
            continue;
        }
        item.set_text(title)?;
        item.set_enabled(*enabled)?;
        state.insert(id.clone(), now);
    }
    Ok(())
}

/// The bar, and the app's own items in it by command id: those are what
/// a later description writes to when only their state has changed.
type Built = (Menu<Wry>, HashMap<String, MenuItem<Wry>>);

fn build(app: &AppHandle, sections: &[MenuSection]) -> tauri::Result<Built> {
    let mut items: HashMap<String, MenuItem<Wry>> = HashMap::new();
    let mut menus: Vec<Submenu<Wry>> = Vec::new();
    for section in sections {
        let mut owned: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
        for entry in &section.items {
            owned.push(match entry {
                MenuEntry::Separator => Box::new(PredefinedMenuItem::separator(app)?),
                MenuEntry::Standard { role } => standard(app, *role)?,
                MenuEntry::Command {
                    id,
                    title,
                    accelerator,
                    enabled,
                } => {
                    let item = MenuItem::with_id(app, id, title, *enabled, accelerator.as_deref())?;
                    items.insert(id.clone(), item.clone());
                    Box::new(item)
                }
            });
        }
        let refs: Vec<&dyn IsMenuItem<Wry>> = owned.iter().map(|item| &**item).collect();
        menus.push(Submenu::with_items(app, &section.title, true, &refs)?);
    }
    let refs: Vec<&dyn IsMenuItem<Wry>> = menus
        .iter()
        .map(|menu| menu as &dyn IsMenuItem<Wry>)
        .collect();
    Ok((Menu::with_items(app, &refs)?, items))
}

fn standard(app: &AppHandle, role: MenuRole) -> tauri::Result<Box<dyn IsMenuItem<Wry>>> {
    let name = app.package_info().name.clone();
    Ok(match role {
        MenuRole::About => Box::new(PredefinedMenuItem::about(app, None, Some(about(app)))?),
        MenuRole::Services => Box::new(PredefinedMenuItem::services(app, None)?),
        MenuRole::Hide => Box::new(PredefinedMenuItem::hide(app, None)?),
        MenuRole::HideOthers => Box::new(PredefinedMenuItem::hide_others(app, None)?),
        MenuRole::ShowAll => Box::new(PredefinedMenuItem::show_all(app, None)?),
        MenuRole::Quit => Box::new(MenuItem::with_id(
            app,
            QUIT,
            format!("Quit {name}"),
            true,
            Some("CmdOrCtrl+Q"),
        )?),
        MenuRole::Cut => Box::new(PredefinedMenuItem::cut(app, None)?),
        MenuRole::Copy => Box::new(PredefinedMenuItem::copy(app, None)?),
        MenuRole::Paste => Box::new(PredefinedMenuItem::paste(app, None)?),
        MenuRole::SelectAll => Box::new(PredefinedMenuItem::select_all(app, None)?),
        MenuRole::Minimize => Box::new(PredefinedMenuItem::minimize(app, None)?),
        MenuRole::Zoom => Box::new(PredefinedMenuItem::maximize(app, Some("Zoom"))?),
        MenuRole::Fullscreen => Box::new(PredefinedMenuItem::fullscreen(app, None)?),
        MenuRole::BringAllToFront => Box::new(PredefinedMenuItem::bring_all_to_front(app, None)?),
    })
}

/// What the About panel says. The same four facts Tauri's own default
/// menu shows, which are the ones the bundle carries.
fn about(app: &AppHandle) -> AboutMetadata<'_> {
    let info = app.package_info();
    let bundle = &app.config().bundle;
    AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        copyright: bundle.copyright.clone(),
        authors: bundle.publisher.clone().map(|publisher| vec![publisher]),
        ..AboutMetadata::default()
    }
}

/// Put the bar up. Only macOS has one to put it in; the shell only asks
/// for a menu there, and this is the second lock on that door.
#[cfg(target_os = "macos")]
fn install(menu: &Menu<Wry>) -> tauri::Result<()> {
    menu.set_as_app_menu()?;
    Ok(())
}

// The signature is the macOS one's, which is the point: `apply` calls one
// function and does not know which platform answered. Clippy sees only
// this arm on Linux and Windows, where it cannot fail.
#[cfg(not(target_os = "macos"))]
#[allow(clippy::unnecessary_wraps)]
fn install(_menu: &Menu<Wry>) -> tauri::Result<()> {
    Ok(())
}

/// An item was chosen. Quit is the app's; every other item is one of the
/// app's commands, and belongs to the window in front — the bar is the
/// whole app's on macOS, and what it shows is whatever that window last
/// described.
pub fn chosen(app: &AppHandle, event: &MenuEvent) {
    let id = event.id().as_ref();
    if id == QUIT {
        app.exit(0);
        return;
    }
    let Some(label) = focused(app) else {
        return;
    };
    if let Err(error) = MenuCommandEvent(id.to_owned()).emit_to(app, &label) {
        eprintln!("could not deliver the menu command {id}: {error}");
    }
}

fn focused(app: &AppHandle) -> Option<String> {
    app.webview_windows()
        .into_iter()
        .find(|(_, window)| window.is_focused().unwrap_or(false))
        .map(|(label, _)| label)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(id: &str, enabled: bool) -> MenuEntry {
        MenuEntry::Command {
            id: id.to_owned(),
            title: id.to_owned(),
            accelerator: None,
            enabled,
        }
    }

    fn section(items: Vec<MenuEntry>) -> Vec<MenuSection> {
        vec![MenuSection {
            title: "File".to_owned(),
            items,
        }]
    }

    #[test]
    fn a_state_change_is_not_a_new_menu() {
        let before = section(vec![command("file.save", false), MenuEntry::Separator]);
        let after = section(vec![command("file.save", true), MenuEntry::Separator]);
        assert_eq!(
            shape(&before),
            shape(&after),
            "greying an item out must not rebuild the bar under the pointer"
        );
    }

    #[test]
    fn a_different_menu_is_a_different_shape() {
        let one = section(vec![command("file.save", true)]);
        assert_ne!(
            shape(&one),
            shape(&section(vec![
                command("file.save", true),
                command("file.close", true)
            ])),
            "an item added"
        );
        assert_ne!(
            shape(&one),
            shape(&section(vec![MenuEntry::Standard {
                role: MenuRole::Cut
            }])),
            "a standard item where one of the app's was"
        );
        assert_ne!(
            shape(&one),
            shape(&[MenuSection {
                title: "Edit".to_owned(),
                items: vec![command("file.save", true)]
            }]),
            "the same items under a different name"
        );
    }
}
