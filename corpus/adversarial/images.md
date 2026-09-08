<!-- adversarial: image sources of every kind, in markdown and in HTML -->
Relative: ![a diagram](pictures/diagram.png)

Relative with a title: ![alt](./sub/dir/photo.jpg "A title")

Remote: ![remote](https://example.com/remote.png)

Protocol relative: ![protocol](//example.com/x.png)

Data: ![dot](data:image/gif;base64,R0lGODlhAQABAAAAACw=)

No alt text at all: ![](pictures/nameless.png)

Reference style: ![by reference][pic]

Unsafe: ![js](javascript:alert(1))

Inline HTML, local: <img src="pictures/inline.png" alt="inline" width="120">

Inline HTML, remote: <img src="https://example.com/inline.png" alt="blocked">

[pic]: pictures/from-a-reference.png "Referenced"
