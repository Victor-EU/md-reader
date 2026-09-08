<!-- adversarial: the leniency cases of design 5.2, each rendered as the most plausible intent -->
A heading with no blank line before it:
## Still a heading

Mixed tabs and spaces in one list:
- space item
	- tab child
  - two space child
	    - deep mixed child

A table with ragged columns:

| a | b | c |
|---|---|
| 1 | 2 | 3 | 4 |
| 5 |

Emphasis nobody closed: *open italic and **open bold

A stray angle bracket: 5 < 6 and a < b > c.

An unclosed link [label](https://example.com and a bare bracket [aside] in text.

A list that changes marker halfway:
- first
* second
+ third

Setext underline after a list:
- item
===

A fence that never closes:

```js
function open() {
