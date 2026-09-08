<!-- adversarial: an .mdx file read as markdown, where imports and JSX fall to the HTML rules -->
import Chart from './Chart'
export const meta = { title: 'Q3' }

# A heading after the imports

<Chart data={sales} width={640} />

Text around a JSX block.

<Callout type="warning">
  Children of a component.
</Callout>

An inline component <Badge count={3} /> in a sentence.

Braces on their own {not: 'javascript'} are just text.
