/**
 * Drive the real `/economist` panel the way a terminal does: raw key bytes into the
 * vendored Pi adapter, with the real pi-tui keybindings (`getKeybindings()`), so the
 * tests exercise the same key matching, editing and rendering code as Pi.
 *
 * The theme is the identity (no colour codes), so assertions read plain text.
 */
import { getKeybindings, visibleWidth } from '@earendil-works/pi-tui';

export const KEY = Object.freeze({
  up: '\x1b[A',
  down: '\x1b[B',
  enter: '\r',
  esc: '\x1b',
  ctrlS: '\x13',
  tab: '\t',
  backspace: '\x7f',
});

export const plainTheme = { fg: (_color, text) => text, bold: (text) => text };

const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Replace `ctx.ui.custom` with a recorder that mounts each screen as Pi would: factory
 * called with (tui, theme, keybindings, done), resolved when `done` is called.
 */
export function attachScreens(ctx, { rows = 40 } = {}) {
  const screens = [];
  const host = {
    screens,
    keybindings: getKeybindings(),
    get current() {
      return screens.at(-1);
    },
    get component() {
      return screens.at(-1)?.component;
    },
  };
  ctx.ui.custom = (factory, options) =>
    new Promise((resolve) => {
      const screen = { options, closed: false, renders: 0 };
      const tui = { requestRender: () => { screen.renders++; }, terminal: { rows } };
      screen.component = factory(tui, plainTheme, host.keybindings, (value) => {
        screen.closed = true;
        resolve(value);
      });
      screens.push(screen);
    });
  return host;
}

/** Wait until `count` screens were mounted (the command opens them asynchronously). */
export async function waitForScreen(host, count = 1, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (host.screens.length < count && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  if (host.screens.length < count) throw Error(`expected screen #${count}, saw ${host.screens.length}`);
  return host.screens[count - 1];
}

/** Send key bytes one by one and wait for the panel's own async work to settle. */
export async function press(component, ...keys) {
  for (const key of keys) {
    component.handleInput(key);
    await settle();
    await component.drain?.();
    await settle();
  }
}

/** Type literal text into the focused input, one terminal byte at a time. */
export async function type(component, text) {
  for (const ch of text) await press(component, ch);
}

/** Move the cursor with ↑/↓ until the field or action `id` has the focus. */
export async function focus(component, id) {
  const controller = component.controller;
  const ids = [
    ...controller.session.fields.map((f) => f.id),
    ...controller.listActions.map((a) => a.id),
  ];
  const target = ids.indexOf(id);
  if (target < 0) throw Error(`no row ${id}`);
  for (let guard = 0; guard < ids.length * 2 && controller.session.focusedId !== id; guard++) {
    const current = ids.indexOf(controller.session.focusedId);
    await press(component, current < target ? KEY.down : KEY.up);
  }
  if (controller.session.focusedId !== id) throw Error(`could not focus ${id}`);
}

/** Open a select field and choose the option `value` with ↑/↓ + Enter. */
export async function choose(component, id, value) {
  await focus(component, id);
  await press(component, KEY.enter);
  const controller = component.controller;
  const choices = controller.choices.map((c) => c.id);
  const target = choices.indexOf(value);
  if (target < 0) throw Error(`${id} has no choice ${value}: ${choices.join(', ')}`);
  for (let guard = 0; guard < choices.length * 2 && controller.choiceIndex !== target; guard++)
    await press(component, controller.choiceIndex < target ? KEY.down : KEY.up);
  await press(component, KEY.enter);
}

/** Rendered text at a width; every line must fit, as pi-tui requires. */
export function view(component, width = 80) {
  const lines = component.render(width);
  for (const line of lines)
    if (visibleWidth(line) > width) throw Error(`line wider than ${width}: ${JSON.stringify(line)}`);
  return lines.join('\n');
}

export { visibleWidth };
