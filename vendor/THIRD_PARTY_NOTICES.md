# Third-party code in `vendor/`

## `inteiro-terminal/`

- Origin: `@inteiro/terminal` (closure of the Pi adapter `pi.ts`), from the IDS repository
  (`packages/terminal/src`), transpiled to ES2022 JavaScript by the IDS vendoring script
  (`--format js`), so the extension keeps running without a build step on every Node in CI.
  Version, contract, source commit, date and the sha256 of every file are recorded in
  `inteiro-terminal/VENDOR.json`.
- License: MIT, copied verbatim in `inteiro-terminal/LICENSE`.
- Local patches: none (`"patches": []`). Do not edit these files by hand; regenerate them from
  an IDS checkout with
  `node scripts/vendor-terminal.mjs --out <this dir>/inteiro-terminal --format js`.
- Integrity: `node vendor/inteiro-terminal/verify-vendor.mjs` (also run by
  `test/vendor.test.mjs`, which does not need an IDS checkout). The verifier rejects any extra
  file inside `inteiro-terminal/`, which is why this notice lives one level up.
- External import: `@earendil-works/pi-tui` only (`Input`, `matchesKey`, `truncateToWidth`,
  `visibleWidth`), resolved to the host's own copy by Pi's extension loader.
- Only the panel/state code is used. No design-system tokens, palette, mark or slogan are
  included; the panel paints with the Pi host theme (`theme.fg`/`theme.bold`).
