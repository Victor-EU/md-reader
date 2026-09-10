# Third-party notices

Fonts bundled in the application binary. Each is used under the SIL Open
Font License, Version 1.1, whose full text ships in the corresponding
package under `node_modules/@fontsource-variable/<name>/LICENSE`.

| Family | Used as | Upstream | Copyright as the package states it |
|---|---|---|---|
| Inter | the sans | <https://github.com/rsms/inter> | Copyright 2016 The Inter Project Authors |
| Source Serif 4 | the serif | <https://github.com/adobe-fonts/source-serif> | Google Inc. |
| JetBrains Mono | the monospace | <https://github.com/JetBrains/JetBrainsMono> | Copyright 2020 The JetBrains Mono Project Authors |

Only the Latin and Latin Extended subsets are bundled; see
`apps/desktop/src/fonts.css`.

This file ships inside the application. On macOS it is at
`Markdown.app/Contents/Resources/THIRD-PARTY-NOTICES.md`; the Settings
colophon says so.

## pdf.js, and the decoders it carries

The PDF viewer is Mozilla's pdf.js (ADR 0035), used under the Apache
License, Version 2.0. Unlike the libraries below, it is not only linked:
its data files are copied into the application and shipped as content,
so its notices ship with them.

| Part | Shipped as | Licence | Upstream |
|---|---|---|---|
| pdf.js | the viewer and its worker | Apache-2.0 | <https://github.com/mozilla/pdf.js> |
| Character maps | `pdfjs/cmaps/` | Apache-2.0, and Adobe's CMap licence | Adobe, via pdf.js |
| Standard fonts | `pdfjs/standard_fonts/` | Foxit's, and the SIL OFL for Liberation | Foxit and Red Hat, via pdf.js |
| JBIG2 decoder | `pdfjs/wasm/jbig2.wasm` | Apache-2.0 and the upstream JBIG2 licence | <https://github.com/mozilla/pdf.js.jbig2> |
| OpenJPEG decoder | `pdfjs/wasm/openjpeg.wasm` | BSD-2-Clause | <https://github.com/uclouvain/openjpeg> |
| qcms | `pdfjs/wasm/qcms_bg.wasm` | MPL-2.0 | <https://github.com/FirefoxGraphics/qcms> |
| CGATS001 profile | `pdfjs/iccs/` | see `pdfjs/iccs/LICENSE` | Adobe, via pdf.js |

The full texts ship beside what they cover — `pdfjs/wasm/LICENSE_*`,
`pdfjs/standard_fonts/LICENSE_FOXIT` and `LICENSE_LIBERATION`,
`pdfjs/cmaps/LICENSE`, `pdfjs/iccs/LICENSE` — and pdf.js's own in
`pdfjs/LICENSE`. All of them are copied out of
`node_modules/pdfjs-dist` at build time by
`apps/desktop/pdfjs-assets.ts`, which is also the one list of what is
shipped.

The QuickJS sandbox that runs a PDF's own JavaScript is deliberately not
among them: this app builds its own pane on the core API, with no
annotation layer and so no scripting path (ADR 0035).

Every other dependency is a build-time or runtime library resolved by
pnpm and Cargo; their licences are recorded in `pnpm-lock.yaml` and
`Cargo.lock` and are not redistributed as content.
