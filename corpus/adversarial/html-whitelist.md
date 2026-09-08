<!-- adversarial: the inline HTML whitelist of design 5.3, allowed and refused -->
Allowed: <mark>marked</mark>, <sub>2</sub>, <sup>nd</sup>, <u>underlined</u>, <s>struck</s>,
<kbd>Cmd</kbd>, a break<br>here, and <span style="color: #c00">red</span>.

Refused: <script>alert(1)</script>, <iframe src="x"></iframe>, <style>b{}</style>,
<b onclick="steal()">handler</b>, <div>a block tag inline</div>, <a href="x">a link</a>.

A span with more than a colour is text: <span style="color:red;font-size:99px">too much</span>.
A span with a colour that is not one: <span style="color:url(x)">not a colour</span>.

Nesting: <mark>outer <sup>inner</sup> outer</mark>.
Crossed tags: <mark>one <sup>two</mark> three</sup>.
Unclosed: <mark>runs to the end of the paragraph.

<details>
<summary>The compact form, with no blank lines</summary>
Body text inside the block.
</details>

<details>

<summary>The form with blank lines</summary>

Its tags are separate blocks, so they read as text.

</details>
