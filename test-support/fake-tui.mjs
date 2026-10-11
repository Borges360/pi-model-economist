/**
 * A stand-in for the host terminal components, faithful to the parts the dashboard
 * relies on: `SettingsList` cycles enum values and opens submenus that report back
 * through `done(value, { navigateTo })`, and `SelectList` calls `onSelect`/`onCancel`.
 *
 * It records what was rendered and what was chosen so a test can drive the real
 * dashboard code without a terminal.
 */
export function fakeTui() {
  const created = { settings: [], select: [], text: [], input: [], render: [] };

  class Container {
    constructor() {
      this.children = [];
    }
    addChild(c) {
      this.children.push(c);
    }
    clear() {
      this.children = [];
    }
    invalidate() {}
    render(width) {
      return this.children.flatMap((c) => c.render?.(width) ?? []);
    }
  }
  class Text {
    constructor(text = '') {
      this.text = text;
      created.text.push(this);
    }
    setText(text) {
      this.text = text;
    }
    render() {
      return String(this.text).split('\n');
    }
  }
  class DynamicBorder extends Text {}
  class Input {
    constructor(options = {}) {
      this.value = '';
      this.placeholder = options.placeholder;
      created.input.push(this);
    }
    getValue() {
      return this.value;
    }
    setValue(v) {
      this.value = v;
    }
    handleInput(data) {
      if (data !== '\r' && data !== '\n') this.value += data;
    }
    render() {
      return [`> ${this.value}`];
    }
  }
  class SelectList {
    constructor(items) {
      this.items = items;
      this.onSelect = undefined;
      this.onCancel = undefined;
      created.select.push(this);
    }
    handleInput() {}
    render() {
      return this.items.map((i) => `  ${i.label ?? i.value}`);
    }
    /** Test driver: behave like the real picker on enter, returning the write. */
    pick(value) {
      const item = this.items.find((i) => i.value === value);
      if (!item) throw Error(`fake SelectList: ${value} not offered: ${this.items.map((i) => i.value)}`);
      return this.onSelect(item);
    }
    cancel() {
      this.onCancel();
    }
  }
  class SettingsList {
    constructor(items, maxVisible, theme, onChange, onCancel) {
      this.items = items;
      this.maxVisible = maxVisible;
      this.theme = theme;
      this.onChange = onChange;
      this.onCancel = onCancel;
      this.opened = [];
      created.settings.push(this);
    }
    updateValue(id, value) {
      const item = this.find(id);
      if (item) item.currentValue = value;
    }
    selectItem(id) {
      this.selected = this.find(id);
    }
    find(id) {
      return this.items.find((i) => i.id === id);
    }
    handleInput() {}
    render() {
      return this.items.map((i) => `${i.label} = ${i.currentValue}`);
    }
    /** Enter on an enum row: cycle to the given value and report the change. */
    cycle(id, value) {
      const item = this.find(id);
      if (!item?.values) throw Error(`fake SettingsList: ${id} is not a cycle row`);
      item.currentValue = value;
      return this.onChange(id, value);
    }
    /**
     * Enter on a submenu row. Mirrors pi: the submenu receives the current value and
     * a `done` that writes the value back, fires onChange, and can navigate onward.
     */
    open(id) {
      const item = this.find(id);
      if (typeof item.submenu !== 'function') throw Error(`fake SettingsList: ${id} has no submenu`);
      let closed = false;
      const component = item.submenu(item.currentValue, (value, options) => {
        if (closed) throw Error('submenu already closed');
        closed = true;
        if (value !== undefined) {
          item.currentValue = value;
          return this.onChange(id, value);
        }
        if (options?.navigateTo) {
          this.selectItem(options.navigateTo);
          return this.open(options.navigateTo);
        }
        return undefined;
      });
      this.opened.push({ id, component });
      return component;
    }
    /** The most recently opened submenu component, whatever it is. */
    top() {
      return this.opened.at(-1)?.component;
    }
  }

  const theme = {
    fg: (_token, text) => String(text),
    bold: (text) => String(text),
  };
  return {
    tuiPkg: { Container, SettingsList, SelectList, Text, Input, DynamicBorder },
    agentPkg: {
      getSettingsListTheme: () => ({
        label: (t) => t,
        value: (t) => t,
        description: (t) => t,
        cursor: '> ',
        hint: (t) => t,
      }),
      getSelectListTheme: () => ({
        selectedPrefix: (t) => t,
        selectedText: (t) => t,
        description: (t) => t,
        scrollInfo: (t) => t,
        noMatch: (t) => t,
      }),
    },
    theme,
    created,
    keybindings: { matches: (data, name) => name === 'tui.select.cancel' && data === '\u001b' },
  };
}

/** A ctx.ui that runs the custom screen and lets the test drive it. */
export function withCustomUi(ctx, tui) {
  ctx.lastScreen = null;
  ctx.ui.custom = async (factory) => {
    const tuiRef = { requestRender: () => tui.created.render.push('render') };
    const done = (result) => {
      ctx.customResult = result;
      ctx.customDone?.(result);
    };
    ctx.customDone = () => {};
    const settled = new Promise((resolve) => {
      ctx.customDone = resolve;
    });
    ctx.lastScreen = factory(tuiRef, tui.theme, tui.keybindings, (result) => {
      ctx.customResult = result;
      ctx.customDone(result);
    });
    return settled;
  };
  return ctx;
}
