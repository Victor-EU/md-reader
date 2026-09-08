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

WP 1.12 packages the installers, and is where this file has to reach the
bundle itself rather than only the repository.

Every other dependency is a build-time or runtime library resolved by
pnpm and Cargo; their licences are recorded in `pnpm-lock.yaml` and
`Cargo.lock` and are not redistributed as content.
