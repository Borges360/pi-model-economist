import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import * as piTui from '@earendil-works/pi-tui';
import * as piAgent from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import install from './extension.mjs';

/**
 * The dashboard draws with host terminal components, so the host modules have to be
 * imported **statically, here at the entry point**, and handed to the extension.
 *
 * This is not a style preference — it is the only way that resolves. pi loads
 * extensions through jiti with a map of host modules, and that map applies to static
 * imports; a dynamic `await import('@earendil-works/pi-tui')` from inside an extension
 * falls through to Node's native resolver and dies with `ERR_MODULE_NOT_FOUND`, even
 * for `@earendil-works/pi-ai`. Verified against the installed 1.1.0 by
 * `scripts/smoke-dashboard.mjs`, and mirrored by the shipped examples
 * (`examples/extensions/border-status-editor.ts:8`,
 * `examples/extensions/built-in-tool-renderer.ts:35`).
 *
 * `node --test` never loads this file — the suite imports `extension.mjs` / `menu.mjs`
 * directly and injects doubles through the `host` seam — so keeping the host out of the
 * tested modules still holds.
 */
export default function (pi: ExtensionAPI) {
  install(pi, { tui: piTui, agent: piAgent, Type });
}
