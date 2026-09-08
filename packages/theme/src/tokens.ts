import { type Tag, tags as t } from '@lezer/highlight';
import type { CodeToken } from './theme.ts';

/**
 * What each token name means to the two highlighters.
 *
 * Shiki matches TextMate scopes; CodeMirror matches Lezer tags. Neither
 * vocabulary is a subset of the other, so the only way both can be given
 * the same palette is to name the sixteen things we actually have a
 * colour for and say, once, how each engine spells them.
 *
 * The lists are deliberately conservative. A scope left out falls back to
 * the theme's foreground, which is what an unhighlighted fence already
 * looks like; a scope put in the wrong place is a colour that means one
 * thing in Read mode and another in Source, which is the failure this
 * whole file exists to prevent. `code-theme.browser.test.ts` renders the
 * same fence through both and compares the result character by character.
 */

/** TextMate scope selectors, for Shiki. */
export const scopes: Record<Exclude<CodeToken, 'foreground'>, string[]> = {
  // The `//` of a comment is scoped as punctuation as well; the longer
  // selector wins, which is what keeps a comment one colour.
  comment: ['comment', 'punctuation.definition.comment'],
  keyword: ['keyword', 'storage', 'storage.type', 'storage.modifier'],
  operator: ['keyword.operator'],
  punctuation: ['punctuation', 'meta.brace'],
  string: [
    'string',
    'string.quoted',
    'string.template',
    'punctuation.definition.string',
    'constant.other.symbol',
  ],
  escape: ['constant.character.escape', 'string.regexp', 'constant.regexp'],
  number: ['constant.numeric'],
  constant: ['constant.language', 'constant.other', 'support.constant', 'variable.language'],
  variable: ['variable', 'variable.other', 'variable.parameter'],
  property: [
    'variable.other.property',
    'support.type.property-name',
    'entity.other.attribute-name',
    'meta.object-literal.key',
  ],
  function: ['entity.name.function', 'support.function', 'meta.function-call', 'variable.function'],
  type: [
    'entity.name.type',
    'entity.name.class',
    'entity.name.namespace',
    'entity.name.tag',
    'support.type',
    'support.class',
  ],
  invalid: ['invalid'],
  inserted: ['markup.inserted'],
  deleted: ['markup.deleted'],
};

/** Lezer highlighting tags, for CodeMirror. */
export const lezerTags: Record<Exclude<CodeToken, 'foreground'>, Tag[]> = {
  comment: [t.comment, t.lineComment, t.blockComment, t.docComment],
  keyword: [
    t.keyword,
    t.controlKeyword,
    t.moduleKeyword,
    t.operatorKeyword,
    t.definitionKeyword,
    t.modifier,
  ],
  operator: [
    t.operator,
    t.derefOperator,
    t.arithmeticOperator,
    t.logicOperator,
    t.bitwiseOperator,
    t.compareOperator,
    t.updateOperator,
    t.definitionOperator,
    t.typeOperator,
    t.controlOperator,
  ],
  punctuation: [
    t.punctuation,
    t.separator,
    t.bracket,
    t.angleBracket,
    t.squareBracket,
    t.paren,
    t.brace,
    t.contentSeparator,
  ],
  // A template literal is tagged `special(string)`, so it belongs with
  // the other strings and not with the escapes it may contain.
  string: [t.string, t.docString, t.character, t.attributeValue, t.url, t.special(t.string)],
  escape: [t.escape, t.regexp],
  number: [t.number, t.integer, t.float],
  constant: [t.atom, t.bool, t.self, t.null, t.unit, t.color, t.meta, t.annotation],
  variable: [t.variableName, t.local(t.variableName), t.definition(t.variableName)],
  property: [
    t.propertyName,
    t.definition(t.propertyName),
    t.attributeName,
    t.labelName,
    t.special(t.variableName),
  ],
  function: [
    t.function(t.variableName),
    t.function(t.propertyName),
    t.function(t.definition(t.variableName)),
    t.function(t.definition(t.propertyName)),
    t.macroName,
  ],
  type: [
    t.typeName,
    t.className,
    t.namespace,
    t.tagName,
    t.definition(t.typeName),
    t.definition(t.className),
    t.standard(t.typeName),
    t.standard(t.tagName),
  ],
  invalid: [t.invalid],
  inserted: [t.inserted],
  deleted: [t.deleted],
};
