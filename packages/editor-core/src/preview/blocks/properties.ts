import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { type EditorView, WidgetType } from '@codemirror/view';
import { type Property, properties, propertyLine } from '@markdown/markdown';

/** The frontmatter block as the panel needs it, read from the current state. */
export interface FrontmatterModel {
  properties: Property[];
  /** Where a new property's line goes: the start of the closing `---`. */
  insertAt: number;
  /** The first content line, for a click that asks for the YAML itself. */
  contentFrom: number;
  source: string;
}

/**
 * The frontmatter of a document, if it has one the panel can represent.
 *
 * Read from the state at the moment it is needed rather than carried on
 * the widget: a widget can outlive the positions it was built from, and
 * an edit that lands one line off is exactly the loss principle 1 rules
 * out.
 */
export function frontmatterModel(state: EditorState): FrontmatterModel | null {
  const node = syntaxTree(state).topNode.firstChild;
  if (node?.name !== 'Frontmatter') return null;
  const marks = node.getChildren('FrontmatterMark');
  const close = marks[1];
  const content = node.getChild('FrontmatterContent');
  const contentFrom = content ? content.from : (close?.from ?? node.to);
  const contentTo = content ? content.to : contentFrom;
  const source = state.doc.sliceString(contentFrom, contentTo);
  const found = content ? properties(source, contentFrom) : [];
  if (found === null) return null;
  return {
    properties: found,
    insertAt: close ? state.doc.lineAt(close.from).from : node.to,
    contentFrom,
    source,
  };
}

/**
 * Frontmatter as the properties panel of design 5.1 and 7.1.
 *
 * Every edit replaces exactly one line, or inserts one before the closing
 * `---`. The YAML is never reparsed and re-emitted, so quoting, spacing,
 * comments, and key order survive an edit to a neighbouring key.
 *
 * A property holding a list is shown but not edited here: a text input is
 * the wrong shape for a sequence, and showing one would promise an edit
 * this widget cannot make losslessly. Clicking the panel's background
 * puts the cursor in the block, where the YAML itself is editable.
 */
export class PropertiesWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }

  override eq(other: PropertiesWidget): boolean {
    return other.source === this.source;
  }

  override ignoreEvent(event: Event): boolean {
    // Everything inside an input is the panel's business; a click on the
    // panel itself belongs to the editor, which puts the cursor in the
    // block and reveals the source.
    return (event.target as HTMLElement | null)?.tagName === 'INPUT';
  }

  toDOM(view: EditorView): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'mdr-properties';
    const model = frontmatterModel(view.state);
    for (const [index, property] of (model?.properties ?? []).entries()) {
      panel.appendChild(this.row(view, property, index));
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'mdr-property-add';
    add.textContent = 'Add property';
    add.tabIndex = -1;
    add.addEventListener('mousedown', (event) => event.preventDefault());
    add.addEventListener('click', () => addProperty(view));
    panel.appendChild(add);
    return panel;
  }

  private row(view: EditorView, property: Property, index: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'mdr-property';
    row.appendChild(field(view, 'mdr-property-key', property.key, index, 'key'));
    if (property.items) {
      const value = document.createElement('span');
      value.className = 'mdr-property-value mdr-property-list';
      value.textContent = property.items.join(', ');
      row.appendChild(value);
    } else {
      row.appendChild(field(view, 'mdr-property-value', property.value, index, 'value'));
    }
    return row;
  }
}

function field(
  view: EditorView,
  className: string,
  value: string,
  index: number,
  part: 'key' | 'value',
): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = className;
  input.value = value;
  input.spellcheck = false;
  input.dataset.part = part;
  input.dataset.index = String(index);
  // On change, not on input: a keystroke that rebuilt the widget would
  // take the focus away from the field being typed in.
  input.addEventListener('change', () => setProperty(view, index, part, input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
    if (event.key === 'Escape') {
      input.value = value;
      input.blur();
    }
  });
  return input;
}

/** Replace one property's line with the key and value the panel now shows. */
export function setProperty(
  view: EditorView,
  index: number,
  part: 'key' | 'value',
  text: string,
): boolean {
  const model = frontmatterModel(view.state);
  const property = model?.properties[index];
  if (!property || property.items) return false;
  const key = (part === 'key' ? text : property.key).trim();
  const value = part === 'value' ? text.trim() : property.value;
  if (key === '') return false;
  const line = propertyLine(key, value);
  if (line === view.state.doc.sliceString(property.from, property.to)) return false;
  view.dispatch(
    view.state.update({
      changes: { from: property.from, to: property.to, insert: line },
      userEvent: 'input.property',
    }),
  );
  return true;
}

/** The name a new property carries until it is given one. */
export const NEW_PROPERTY = 'property';

/** Append a property line before the closing `---` and put the cursor in its key. */
export function addProperty(view: EditorView, key = NEW_PROPERTY): boolean {
  const model = frontmatterModel(view.state);
  if (!model) return false;
  const taken = new Set(model.properties.map((property) => property.key));
  let name = key;
  for (let n = 2; taken.has(name); n++) name = `${key}-${n}`;
  view.dispatch(
    view.state.update({
      changes: { from: model.insertAt, insert: `${propertyLine(name, '')}\n` },
      userEvent: 'input.property',
    }),
  );
  focusProperty(view, name);
  return true;
}

/** Put the caret in the key field of the named property, once it is drawn. */
function focusProperty(view: EditorView, key: string): void {
  requestAnimationFrame(() => {
    const model = frontmatterModel(view.state);
    const index = model?.properties.findIndex((property) => property.key === key) ?? -1;
    if (index < 0) return;
    const input = view.dom.querySelector<HTMLInputElement>(
      `.mdr-property-key[data-index="${index}"]`,
    );
    input?.focus();
    input?.select();
  });
}
