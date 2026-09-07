import { syntaxTree } from '@codemirror/language';
import type { RangeSet } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { buildDecorations } from './build.ts';
import { type RevealRange, revealRanges, sameReveal } from './reveal.ts';

/**
 * The live preview: rebuilds decorations for the visible ranges when the
 * document, the viewport, or the syntax tree changes, and when a
 * selection change alters what the reveal rule shows. A cursor moving
 * within one revealed unit costs one reveal computation and no rebuild.
 */
class PreviewPlugin implements PluginValue {
  decorations: DecorationSet = Decoration.none;
  atomic: RangeSet<Decoration> = Decoration.none;
  private reveal: RevealRange[] = [];

  constructor(view: EditorView) {
    this.rebuild(view);
  }

  update(update: ViewUpdate): void {
    const treeChanged = syntaxTree(update.state) !== syntaxTree(update.startState);
    if (update.docChanged || update.viewportChanged || treeChanged) {
      this.rebuild(update.view);
      return;
    }
    if (update.selectionSet) {
      const next = revealRanges(update.state);
      if (!sameReveal(next, this.reveal)) this.rebuild(update.view, next);
    }
  }

  private rebuild(view: EditorView, reveal = revealRanges(view.state)): void {
    const built = buildDecorations(view.state, view.visibleRanges, reveal);
    this.decorations = Decoration.set(built.decorations, true);
    this.atomic = Decoration.set(built.atomic, true);
    this.reveal = reveal;
  }
}

export const previewPlugin = ViewPlugin.fromClass(PreviewPlugin, {
  decorations: (plugin) => plugin.decorations,
  provide: (plugin) =>
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
});
