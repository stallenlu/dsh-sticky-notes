// The one minimal check for this bundle: load client.js under the documented
// static-bundle contract (factory gets `require` + real DOM globals), run
// apply(), then drive the registered component through every user path so a
// broken h() call, a wrong slot id, a stylesheet that never lands, or a
// delete/edit regression fails here instead of in the browser.
// Run: node plugins/dsh-sticky-notes/smoke.mjs
//
// ponytail: React is a ~70-line stub because the real one only runs in the
// browser. It keys hook state by render path and re-renders the whole tree on
// setState, which is enough to reach the open/edit/delete/blank-note paths.
// Swap in react + react-dom/server if this ever needs effects or keyed lists
// with reordering.
import { readFileSync } from 'node:fs';

const SEED = [{ id: 'n1', text: 'buy milk\nand eggs', updatedAt: 1762312345000 }];

// `settings` seeds the settings key. Most tests drive the plain textarea, so
// the default turns the markdown preview off; tests that exercise the preview
// pass `{}` to get the product defaults.
function createRuntime(seed, rawStorage, localeService, settings = { markdown: false }) {
  let bundle;
  let registration;
  const MEMO = Symbol.for('react.memo');
  const styles = [];
  const store = new Map();
  const writes = [];
  let tree = null;
  let writesFail = false;
  let readsFail = false;

  const stack = [];
  const here = () => stack[stack.length - 1];
  // Real React runs effects after commit, so a setState inside one re-renders
  // once instead of recursing mid-render. The stub drains them per pass to keep
  // that property; a no-op guard stops a runaway loop from hanging the test.
  let pendingEffects = [];
  let cleanups = [];
  let passGuard = 0;

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const frame = here();
      if (!frame) throw new Error('useState outside a component');
      const key = `${frame.path}#${frame.cursor++}`;
      if (!store.has(key)) store.set(key, typeof initial === 'function' ? initial() : initial);
      return [
        store.get(key),
        (next) => {
          const prev = store.get(key);
          const value = typeof next === 'function' ? next(prev) : next;
          if (Object.is(value, prev)) return; // React bails out on an unchanged value
          store.set(key, value);
          dirty = true;
        },
      ];
    },
    useEffect: (fn) => { pendingEffects.push(fn); },
  };

  const render = (node, path) => {
    if (node == null || typeof node === 'boolean') return null;
    if (Array.isArray(node)) return node.map((child, i) => render(child, `${path}/${i}`)).flat(Infinity);
    if (typeof node !== 'object') return node;
    // React renders a memo object by calling its inner type, so unwrap it here
    // too — otherwise the real memo export looks like a host element.
    if (node.type && typeof node.type === 'object' && node.type.$$typeof === MEMO) {
      return render({ ...node, type: node.type.type }, path);
    }
    if (typeof node.type === 'function') {
      const self = `${path}/${node.type.name || 'anon'}`;
      stack.push({ path: self, cursor: 0 });
      try {
        return render(node.type(node.props), `${self}/out`);
      } finally {
        stack.pop();
      }
    }
    return {
      type: node.type,
      props: {
        ...node.props,
        children: node.children.map((child, i) => render(child, `${path}/${i}`)).flat(Infinity),
      },
    };
  };

  // One commit: render the tree, then drain the effects it just scheduled, then
  // re-render if any of them changed state. Mirrors React's render→effect→
  // re-render order, which is what keeps `setUnsaved` from recursing.
  let dirty = false;
  const commit = () => {
    for (passGuard = 0; passGuard < 20; passGuard++) {
      dirty = false;
      tree = render(registration.component(), '');
      const effects = pendingEffects;
      pendingEffects = [];
      // Run the previous pass's disposers first, as React does before re-running
      // an effect (deps changed / unmounted).
      const previous = cleanups;
      cleanups = [];
      for (const dispose of previous) dispose();
      for (const effect of effects) {
        const dispose = effect();
        if (typeof dispose === 'function') cleanups.push(dispose);
      }
      if (!dirty && pendingEffects.length === 0) return;
    }
    throw new Error('render did not settle (state kept changing)');
  };

  // A real store, not a constant: getItem has to see what setItem wrote, or the
  // "edit a note, reload, it is still there" round trip is never tested.
  const disk = new Map();
  if (rawStorage !== undefined) disk.set('dsh-sticky-notes:v1', rawStorage);
  else if (seed) disk.set('dsh-sticky-notes:v1', JSON.stringify(seed));
  if (settings) disk.set('dsh-sticky-notes:settings', JSON.stringify(settings));

  const window = {
    localStorage: {
      getItem: (key) => {
        // A browser with storage disabled throws on read, not just on write.
        if (readsFail) throw new Error('access denied');
        return disk.has(key) ? disk.get(key) : null;
      },
      setItem: (key, value) => {
        if (writesFail) throw new Error('quota exceeded');
        writes.push({ key, value });
        disk.set(key, value);
      },
    },
    __ModuleLoader__: { load: (value) => { bundle = value; } },
    // A real viewport, so clamping has something to clamp against instead of
    // collapsing every position to zero.
    innerWidth: 1280,
    innerHeight: 800,
    listeners: new Map(),
    // Several listeners can watch the same event type (notes and settings both
    // watch `storage`), so a type maps to a set, not to one function.
    addEventListener: (type, fn) => {
      if (!window.listeners.has(type)) window.listeners.set(type, new Set());
      window.listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => { window.listeners.get(type)?.delete(fn); },
  };
  // The static-bundle contract: the factory gets `require` and real DOM globals,
  // nothing else. Stubbing `document` is what proves the stylesheet lands through
  // a <style> element instead of the dynamic runner's `styles` parameter.
  const document = {
    head: { appendChild: (el) => { styles.push(el); } },
    createElement: (tag) => ({ tag, dataset: {}, textContent: '', parentNode: null }),
    querySelector: () => null, // injectBaseline() probes for an existing style[data-dsb]
    listeners: new Map(),
    addEventListener: (type, fn) => { document.listeners.set(type, fn); },
    removeEventListener: (type) => { document.listeners.delete(type); },
  };
  const navigator = { language: 'zh-CN' };
  // Pasted images travel through FileReader.readAsDataURL. The stub hands back
  // a data URL synchronously: enough to prove the file that was read is the
  // file that was attached, without reimplementing base64 here.
  class StubFileReader {
    readAsDataURL(file) {
      // An optional realistic-length data URL lets the paste->reload round
      // trip exercise the size cap without reimplementing base64 here.
      this.result = file.dataUrl ?? `data:${file.type};base64,STUB=${file.name}`;
      queueMicrotask(() => this.onload());
    }
  }
  const fileReader = { current: StubFileReader };
  // `MarkdownText` lives in the platform seed table, so a static bundle may
  // require it. The stub renders the raw text inside a marker span: enough to
  // prove the preview path is taken without reimplementing markdown here.
  // It is a memo OBJECT, not a function, because that is what the real
  // primitives export — testing for "function" is what silently killed the
  // preview in 1.0.0.
  const MarkdownStub = ({ text }) => React.createElement('span', { className: 'md-stub' }, text);
  const primitives = {
    MarkdownText: { $$typeof: MEMO, type: MarkdownStub, compare: null },
  };
  const requireModule = (id) => {
    if (id === 'react') return React;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`unexpected require(${id})`);
  };

  new Function('window', 'document', 'navigator', 'console', 'require', 'FileReader', readFileSync(new URL('./client.js', import.meta.url), 'utf8'))(
    window, document, navigator, console, requireModule, fileReader.current,
  );

  if (!bundle) throw new Error('client.js never called window.__ModuleLoader__.load');
  if (bundle.id !== 'dsh-sticky-note-panel') throw new Error(`module id is ${bundle.id}`);

  const face = bundle.factory(requireModule);
  let effectCalls = 0;
  // Every surface registers into its own slot, so the harness keeps them all and
  // the tests mount whichever one they exercise.
  const registrations = new Map();
  const slots = {
    // Drive the generator: register() records the entry, and its yield is only
    // the disposer. The disposer has to actually remove the entry — the sidebar
    // switch hides its button by dropping the registration.
    inject: (name, gen) => { for (const _ of gen()) void _; },
    register: (options, component) => {
      registrations.set(options.name, { options, component });
      return () => { registrations.delete(options.name); };
    },
  };
  face.apply({
    get: (name) => (name === 'locale' ? localeService : undefined),
    on: () => () => {},
    provide: () => () => {},
    effect: (fn) => { fn(); effectCalls += 1; return () => {}; },
    slots,
  });

  // Default the harness at the floating panel; tests that exercise the page or
  // the settings page mount them by slot name.
  registration = registrations.get('shell.overlay');
  if (!registration) throw new Error('the overlay slot was never registered');

  return {
    face, registration, registrations, slots, styles, effectCalls, writes, document, fileReader,
    // The floating panel is what most tests drive; the others are mounted by name.
    mount: (slot) => {
      if (slot) {
        const entry = registrations.get(slot);
        if (!entry) throw new Error(`nothing registered into ${slot}`);
        registration = entry;
        tree = null;
      }
      commit();
      return tree;
    },
    get tree() {
      // Click handlers only mutate state; flush it the way React would commit.
      if (!tree || dirty || pendingEffects.length > 0) commit();
      return tree;
    },
    rerender: commit,
    window,
    disk,
    failWrites: () => { writesFail = true; },
    failReads: () => { readsFail = true; },
  };
}

const textOf = (node) => {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
};
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const findAll = (node, test, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (test(node)) out.push(node);
  for (const child of node.props?.children ?? []) findAll(child, test, out);
  return out;
};
const byClass = (node, name) => findAll(node, (n) => n.props?.className === name)[0];
const button = (node, label) =>
  findAll(node, (n) => n.type === 'button' && (n.props.children ?? []).flat(Infinity).join('') === label)[0];
const textareas = (node) => findAll(node, (n) => n.type === 'textarea');

// --- apply() wiring -------------------------------------------------------
const empty = createRuntime(null);
assert(empty.effectCalls === 1, `ctx.effect ran ${empty.effectCalls} times`);
assert(empty.styles.length === 2, `style elements appended ${empty.styles.length} times`);
// The house baseline (style[data-dsb]) is injected first, then this plugin's
// own sheet. Locate both by owner instead of by index.
const baselineStyle = empty.styles.find((el) => el.dataset.dsb);
const pluginStyle = empty.styles.find((el) => el.dataset.plugin === 'dsh-sticky-notes');
assert(baselineStyle && baselineStyle.tag === 'style', 'house baseline <style> was not injected');
assert(baselineStyle.textContent.includes('--dsb-accent-'), 'baseline sheet does not define the house accents');
assert(empty.styles.indexOf(baselineStyle) < empty.styles.indexOf(pluginStyle), 'baseline must precede the plugin sheet');
assert(pluginStyle && pluginStyle.tag === 'style', `appended a <${pluginStyle && pluginStyle.tag}>`);
assert(pluginStyle.textContent.includes('--dsw-alias-'), 'stylesheet does not use theme tokens');
assert(pluginStyle.textContent.includes('--dsb-accent-'), 'stylesheet does not use the house accents');
assert(pluginStyle.textContent.length > 1000, `stylesheet is only ${pluginStyle.textContent.length} B`);

// The tab must not move when the panel opens. The panel is taken out of flow and
// hung beside the tab; as a flex sibling it widened the root, and the root is
// edge-anchored, so opening it slid the tab away instead. It sits on the left
// edge and opens rightwards, flipping only when that would leave the screen.
const sheet = pluginStyle.textContent;
const rootRule = (/\.dsn-root \{[^}]*\}/.exec(sheet) || [''])[0];
const panelRule = (/\.dsn-panel \{[^}]*\}/.exec(sheet) || [''])[0];
assert(rootRule, 'no .dsn-root rule in the stylesheet');
assert(panelRule, 'no .dsn-panel rule in the stylesheet');
assert(!/flex-direction:\s*row-reverse/.test(rootRule), 'the root still lays the tab and the panel out as flex siblings');
assert(/position:\s*absolute/.test(panelRule), 'the panel was not taken out of the tab layout');
assert(/left:\s*calc\(100% \+ 10px\)/.test(panelRule), 'the panel does not open to the right of the tab');
assert(/top:\s*0/.test(panelRule), 'the panel top is not aligned with the tab top');
assert(!/translateY\(-50%\)/.test(panelRule), 'the panel is still vertically centred instead of aligned');
assert(/left:\s*16px/.test(rootRule), 'the tab is not anchored to the left edge');
const flipRule = (/\.dsn-root\.dsn-flip \.dsn-panel \{[^}]*\}/.exec(sheet) || [''])[0];
assert(flipRule, 'no rule to flip the panel to the other side');
assert(/right:\s*calc\(100% \+ 10px\)/.test(flipRule), 'the flipped panel does not hang to the left');
assert(empty.face.inject.includes('slots'), 'inject does not list slots');
assert(empty.registration?.options, 'nothing was registered');
assert(empty.registration.options.name === 'shell.overlay', `registered into ${empty.registration.options.name}`);
assert(empty.registration.options.id === 'sticky-notes', `registered as ${empty.registration.options.id}`);
assert(empty.registration.options.order === 900, `registered at order ${empty.registration.options.order}`);

// --- closed state, no notes ----------------------------------------------
const closed = empty.mount();
assert(String(closed.props.className).split(' ').includes('dsn-root'), 'root element is not .dsn-root');
assert(String(closed.props.className).split(' ').includes('dsb-root'), 'root element lacks the baseline .dsb-root mapping');
assert(byClass(closed, 'dsn-tab'), 'tab missing');
assert(!byClass(closed, 'dsn-panel'), 'panel rendered while closed');
assert(!byClass(closed, 'dsn-badge'), 'badge rendered with no notes');
assert(byClass(closed, 'dsn-tab').props['aria-expanded'] === false, 'aria-expanded is not false');

// --- locale falls back to the browser language when the service is absent --
assert(byClass(closed, 'dsn-title') === undefined, 'title rendered while closed');
const zhOpen = createRuntime(null);
zhOpen.mount();
byClass(zhOpen.tree, 'dsn-tab').props.onClick();
assert(byClass(zhOpen.tree, 'dsn-title').props.children.join('') === '便签', `title is ${JSON.stringify(byClass(zhOpen.tree, 'dsn-title').props.children)} with navigator.language zh-CN`);

// --- when the locale service IS present, it must win over the browser ------
// Production has the service, so this is the path users actually get; the
// fallback above is the degraded one. navigator stays zh-CN on purpose: an
// English active locale has to beat it, or switching language in DSH does nothing.
function fakeLocale(initial) {
  const listeners = new Set();
  let active = initial;
  return {
    getSnapshot: () => ({ active }),
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    switchTo: (next) => { active = next; for (const fn of listeners) fn(); },
  };
}
const svc = fakeLocale('en');
const viaService = createRuntime(null, undefined, svc);
viaService.mount();
byClass(viaService.tree, 'dsn-tab').props.onClick();
assert(
  byClass(viaService.tree, 'dsn-title').props.children.join('') === 'Sticky notes',
  `title is ${JSON.stringify(byClass(viaService.tree, 'dsn-title').props.children)} with active locale en`,
);

svc.switchTo('zh');
assert(
  byClass(viaService.tree, 'dsn-title').props.children.join('') === '便签',
  'the panel did not follow a locale switch',
);

// --- persisted note: badge, open, edit, persist ---------------------------
const full = createRuntime(SEED);
assert(byClass(full.mount(), 'dsn-badge'), 'badge missing with one note');
assert(byClass(full.tree, 'dsn-badge').props.children.join('') === '1', 'badge does not show the note count');

const emptyState = createRuntime(SEED);
emptyState.mount();
byClass(emptyState.tree, 'dsn-tab').props.onClick();
assert(byClass(emptyState.tree, 'dsn-panel'), 'panel did not open on click');

const area = textareas(byClass(emptyState.tree, 'dsn-panel'))[0];
assert(area, 'persisted note did not render a textarea');
assert(area.props.value === SEED[0].text, 'textarea does not carry the persisted text');
assert(typeof area.props.onChange === 'function', 'textarea has no onChange');
assert(area.props.rows >= 2, `textarea rows is ${area.props.rows}`);
assert(area.props.placeholder.length > 0, 'textarea has no placeholder');

area.props.onChange({ target: { value: 'rewritten' } });
const afterEdit = textareas(byClass(emptyState.tree, 'dsn-panel'))[0];
assert(afterEdit.props.value === 'rewritten', 'edit did not update the textarea');
assert(
  emptyState.writes.some((w) => w.key === 'dsh-sticky-notes:v1' && w.value.includes('rewritten')),
  'edit was not persisted to localStorage',
);

// --- the real round trip: edit, reload from what was written, still there --
// The other assertions only prove the in-memory state is right. This one feeds
// the written value back in as the next session's storage, which is the only
// thing that proves persistence actually works end to end.
const stored = emptyState.writes.filter((w) => w.key === 'dsh-sticky-notes:v1').pop();
assert(stored, 'nothing was written at all');
const reloaded = createRuntime(null, stored.value);
reloaded.mount();
byClass(reloaded.tree, 'dsn-tab').props.onClick();
const survived = textareas(byClass(reloaded.tree, 'dsn-panel'))[0];
assert(survived, 'the note did not come back after a reload');
assert(survived.props.value === 'rewritten', `reloaded value is ${JSON.stringify(survived.props.value)}`);
assert(
  !byClass(reloaded.tree, 'dsn-warn'),
  'a value this bundle wrote itself was reported as unreadable',
);

// --- delete is a two-step inline confirm, never window.confirm ------------
const del = createRuntime(SEED);
del.mount();
byClass(del.tree, 'dsn-tab').props.onClick();
const delBtn = byClass(del.tree, 'dsn-btn dsn-danger');
assert(delBtn, 'delete button missing');
delBtn.props.onClick();
assert(textareas(byClass(del.tree, 'dsn-panel')).length === 1, 'note vanished before confirming');
const confirmBtn = button(del.tree, '确认删除');
assert(confirmBtn, 'two-step confirm did not appear');
confirmBtn.props.onClick();
assert(textareas(byClass(del.tree, 'dsn-panel')).length === 0, 'note survived the confirmed delete');
assert(!byClass(del.tree, 'dsn-badge'), 'badge survived the last note being deleted');

const cancel = createRuntime(SEED);
cancel.mount();
byClass(cancel.tree, 'dsn-tab').props.onClick();
byClass(cancel.tree, 'dsn-btn dsn-danger').props.onClick();
button(cancel.tree, '关闭').props.onClick();
assert(textareas(byClass(cancel.tree, 'dsn-panel')).length === 1, 'cancelling the confirm deleted the note');

// --- creating a note: autofocus, and an untouched blank is dropped --------
const create = createRuntime(null);
create.mount();
byClass(create.tree, 'dsn-tab').props.onClick();
button(create.tree, '新建便签').props.onClick();
const fresh = textareas(byClass(create.tree, 'dsn-panel'))[0];
assert(fresh, 'new note did not render a textarea');
assert(fresh.props.autoFocus === true, 'new note is not focused for typing');
assert(fresh.props.value === '', 'new note is not empty');
fresh.props.onBlur();
assert(textareas(byClass(create.tree, 'dsn-panel')).length === 0, 'untouched blank note was kept');

const written = createRuntime(null);
written.mount();
byClass(written.tree, 'dsn-tab').props.onClick();
button(written.tree, '新建便签').props.onClick();
const typing = textareas(byClass(written.tree, 'dsn-panel'))[0];
typing.props.onChange({ target: { value: 'x' } });
textareas(byClass(written.tree, 'dsn-panel'))[0].props.onBlur();
assert(textareas(byClass(written.tree, 'dsn-panel')).length === 1, 'a written note was dropped on blur');

// Unmounting a textarea does not fire blur, so closing the panel has to drop
// the abandoned blank itself — otherwise it persists forever.
const abandoned = createRuntime(null);
abandoned.mount();
byClass(abandoned.tree, 'dsn-tab').props.onClick();
button(abandoned.tree, '新建便签').props.onClick();
assert(textareas(byClass(abandoned.tree, 'dsn-panel')).length === 1, 'blank note did not appear');
byClass(abandoned.tree, 'dsn-tab').props.onClick(); // close via the tab
assert(!byClass(abandoned.tree, 'dsn-panel'), 'tab click did not close the panel');
assert(
  !abandoned.writes.some((w) => w.value.includes('"text":""')),
  'an abandoned blank note was written to storage on close',
);

// --- corrupt storage must not take the panel down -------------------------
for (const raw of ['not json', '{"a":1}', '[{"text":5},{"id":1}]']) {
  const corrupt = createRuntime(null, raw);
  corrupt.mount();
  assert(byClass(corrupt.tree, 'dsn-tab'), `tab vanished with storage ${raw}`);
  byClass(corrupt.tree, 'dsn-tab').props.onClick();
  assert(byClass(corrupt.tree, 'dsn-panel'), `panel failed to open with storage ${raw}`);
  // Never overwrite a value we could not read: the user may still salvage it.
  assert(corrupt.writes.length === 0, `unparsable storage ${raw} was overwritten`);
  assert(byClass(corrupt.tree, 'dsn-warn'), `no warning for unparsable storage ${raw}`);
}

// --- a PARTIAL read must not be overwritten before the user touches it ----
// One salvageable note plus one junk entry: readNotes keeps the good one and
// flags the read as failed. Because the surviving note is real content, the
// panel used to write back immediately — silently deleting the junk entry while
// the warning claimed the original was "left untouched". Merely opening the
// panel must not rewrite storage.
const partialReload = createRuntime(null, JSON.stringify([
  { id: 'a', text: 'keep me', updatedAt: 1 },
  { id: 'b', text: 42 },
]));
partialReload.mount();
byClass(partialReload.tree, 'dsn-tab').props.onClick();
assert(byClass(partialReload.tree, 'dsn-warn'), 'a partial read raised no warning');
assert(
  partialReload.writes.length === 0,
  `a partial read was rewritten on mount (${partialReload.writes.length} writes) — the junk entry is gone before the user did anything`,
);
assert(
  textareas(byClass(partialReload.tree, 'dsn-panel'))[0].props.value === 'keep me',
  'the salvageable note is not shown',
);

// Only a real user edit earns the right to replace the unreadable original.
textareas(byClass(partialReload.tree, 'dsn-panel'))[0].props.onChange({ target: { value: 'edited' } });
void partialReload.tree; // reading the tree commits the effect that writes
assert(
  partialReload.writes.some((w) => w.value.includes('edited')),
  'editing after a partial read did not persist',
);
assert(!byClass(partialReload.tree, 'dsn-warn'), 'the warning survived a successful write');

// --- a failed write must be visible, not silent ---------------------------
const noStore = createRuntime(null);
noStore.failWrites();
byClass(noStore.mount(), 'dsn-tab').props.onClick();
button(noStore.tree, '新建便签').props.onClick();
const warn = byClass(noStore.tree, 'dsn-warn');
assert(warn, 'a failed write left no warning');
assert(warn.props.children.join('').includes('存储不可用'), 'warning is not translated');

const storeOK = createRuntime(null);
storeOK.mount();
byClass(storeOK.tree, 'dsn-tab').props.onClick();
assert(!byClass(storeOK.tree, 'dsn-warn'), 'warning shown with working storage');

// --- Escape closes the panel ---------------------------------------------
const esc = createRuntime(SEED);
esc.mount();
byClass(esc.tree, 'dsn-tab').props.onClick();
assert(byClass(esc.tree, 'dsn-panel'), 'panel did not open before the Escape test');
const onKey = esc.document.listeners.get('keydown');
assert(typeof onKey === 'function', 'no keydown listener installed while open');
onKey({ key: 'Escape' });
assert(!byClass(esc.tree, 'dsn-panel'), 'Escape did not close the panel');
assert(esc.document.listeners.size === 0, 'keydown listener leaked after closing');

// Escape closes through a listener installed when the panel opened, so its
// closure is stale by the time you press it. Anything typed since must survive.
const escTyped = createRuntime(null);
escTyped.mount();
byClass(escTyped.tree, 'dsn-tab').props.onClick();
button(escTyped.tree, '新建便签').props.onClick();
textareas(byClass(escTyped.tree, 'dsn-panel'))[0].props.onChange({ target: { value: 'typed before escape' } });
escTyped.document.listeners.get('keydown')({ key: 'Escape' });
byClass(escTyped.tree, 'dsn-tab').props.onClick();
const afterEsc = textareas(byClass(escTyped.tree, 'dsn-panel'))[0];
assert(afterEsc, 'Escape threw away a note that had been typed into');
assert(afterEsc.props.value === 'typed before escape', 'Escape restored stale text');

// --- duplicate ids in stored data must not merge two notes ----------------
// ids come from a timestamp plus 5 random chars, so a collision is possible, and
// stored data may be hand-edited. Two notes sharing an id would make editing one
// rewrite the other.
const dupIds = createRuntime(null, JSON.stringify([
  { id: 'same', text: 'first', updatedAt: 1 },
  { id: 'same', text: 'second', updatedAt: 2 },
]));
dupIds.mount();
byClass(dupIds.tree, 'dsn-tab').props.onClick();
const dupAreas = textareas(byClass(dupIds.tree, 'dsn-panel'));
assert(dupAreas.length === 2, `duplicate ids collapsed ${dupAreas.length} of 2 notes`);
dupAreas[0].props.onChange({ target: { value: 'edited-first' } });
const afterDup = textareas(byClass(dupIds.tree, 'dsn-panel'));
assert(afterDup[1].props.value === 'second', 'editing one note with a shared id overwrote the other');

// Opening a blank note without typing is not authorship either. The filtered
// list is empty here, and writing it would replace an unreadable original with
// `[]` — exactly the loss the warning promises not to cause.
const blankOnCorrupt = createRuntime(null, 'not json');
blankOnCorrupt.mount();
byClass(blankOnCorrupt.tree, 'dsn-tab').props.onClick();
button(blankOnCorrupt.tree, '新建便签').props.onClick();
void blankOnCorrupt.tree;
assert(
  blankOnCorrupt.writes.length === 0,
  `a blank new note overwrote unreadable storage (${JSON.stringify(blankOnCorrupt.writes.map((w) => w.value))})`,
);

// Blurring that same blank note is housekeeping, not a delete: it must not be
// the thing that finally writes `[]` over the unreadable original.
textareas(blankOnCorrupt.tree)[0].props.onBlur();
void blankOnCorrupt.tree;
assert(
  blankOnCorrupt.disk.get('dsh-sticky-notes:v1') === 'not json',
  `blurring a blank note overwrote unreadable storage (${JSON.stringify(blankOnCorrupt.disk.get('dsh-sticky-notes:v1'))})`,
);

// Deleting is the opposite case: it is explicit intent, so it must reach disk.
// Skipping it made a deliberate delete vanish from the panel and reappear on
// reload — indistinguishable from a broken delete button.
const deletePartial = createRuntime(
  null,
  '[{"id":"a","text":"keep me","updatedAt":1762312345000},{"id":"b","text":42}]',
);
deletePartial.mount();
byClass(deletePartial.tree, 'dsn-tab').props.onClick();
button(deletePartial.tree, '删除').props.onClick();
button(deletePartial.tree, '确认删除').props.onClick();
void deletePartial.tree;
assert(
  textareas(deletePartial.tree).length === 0,
  'the deleted note is still on screen',
);
assert(
  deletePartial.disk.get('dsh-sticky-notes:v1') === '[]',
  `deleting the last salvaged note never reached disk (${JSON.stringify(deletePartial.disk.get('dsh-sticky-notes:v1'))})`,
);

// --- storage disabled outright: both read and write throw -------------------
const noRead = createRuntime(null);
noRead.failReads();
noRead.failWrites();
noRead.mount();
byClass(noRead.tree, 'dsn-tab').props.onClick();
button(noRead.tree, '新建便签').props.onClick();
textareas(noRead.tree)[0].props.onChange({ target: { value: 'typed anyway' } });
const warnings = findAll(noRead.tree, (n) => n.props?.className === 'dsn-warn');
assert(
  warnings.some((w) => (w.props.children ?? []).flat(Infinity).join('').includes('存储不可用')),
  `a browser that blocks storage did not warn (${JSON.stringify(warnings.map((w) => [].concat(w.props.children).join('')))})`,
);

// --- hostile stored data: an unusable timestamp must not print "Invalid Date" --
// JSON.stringify turns Infinity into null, so the hostile value is hand-written.
const badTime = createRuntime(null, '[{"id":"t1","text":"note","updatedAt":1e999}]');
badTime.mount();
byClass(badTime.tree, 'dsn-tab').props.onClick();
const stampText = findAll(badTime.tree, (n) => n.props?.className === 'dsn-meta')[0];
const stamp = textOf(stampText);
assert(!stamp.includes('Invalid'), `an impossible timestamp renders as "${stamp}"`);

// --- a locale service that answers badly must not break the render -----------
const brokenLocale = {
  getSnapshot: () => undefined,
  subscribe: () => () => {},
};
const broken = createRuntime(null, undefined, brokenLocale);
broken.mount();
assert(byClass(broken.tree, 'dsn-tab'), 'a malformed locale service blanked the tab');

// --- the badge caps at 99+ instead of printing a huge number -----------------
const many = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}`, text: `n${i}`, updatedAt: 1762312345000 }));
const crowded = createRuntime(many);
crowded.mount();
assert(
  textOf(byClass(crowded.tree, 'dsn-badge')) === '99+',
  `a 120-note badge reads "${textOf(byClass(crowded.tree, 'dsn-badge'))}"`,
);

// --- a NaN timestamp is just as unusable as Infinity ------------------------
const nanTime = createRuntime(null, '[{"id":"t2","text":"note","updatedAt":null}]');
nanTime.mount();
byClass(nanTime.tree, 'dsn-tab').props.onClick();
const nanStamp = textOf(findAll(nanTime.tree, (n) => n.props?.className === 'dsn-meta')[0]);
assert(!nanStamp.includes('Invalid'), `a null timestamp renders as "${nanStamp}"`);

// --- a second window writing must be adopted, not overwritten ---------------
const twoWindows = createRuntime(null);
twoWindows.mount();
byClass(twoWindows.tree, 'dsn-tab').props.onClick();
const winListeners = [...(twoWindows.window.listeners.get('storage') || [])];
assert(winListeners.length >= 1, 'no storage listener, so two windows overwrite each other');
twoWindows.disk.set('dsh-sticky-notes:v1', JSON.stringify([{ id: 'w1', text: 'from the other window', updatedAt: 1762312345000 }]));
for (const fn of winListeners) fn({ key: 'dsh-sticky-notes:v1' });
const adopted = textareas(twoWindows.tree);
assert(
  adopted.length === 1 && adopted[0].props.value === 'from the other window',
  `a write from another window was not adopted (${JSON.stringify(adopted.map((t) => t.props.value))})`,
);
assert(twoWindows.writes.length === 0, 'adopting another window\'s value wrote it straight back');

// A window whose storage is broken shows text that exists nowhere else. A
// remote write must not replace it: that is the one copy of the user's work.
const keepUnsaved = createRuntime(null);
keepUnsaved.mount();
byClass(keepUnsaved.tree, 'dsn-tab').props.onClick();
button(keepUnsaved.tree, '新建便签').props.onClick();
keepUnsaved.failWrites();
textareas(keepUnsaved.tree)[0].props.onChange({ target: { value: 'my unsaved work' } });
void keepUnsaved.tree;
assert(byClass(keepUnsaved.tree, 'dsn-warn'), 'no warning after a failed write');
keepUnsaved.disk.set('dsh-sticky-notes:v1', JSON.stringify([{ id: 'z', text: 'remote', updatedAt: 1 }]));
for (const fn of keepUnsaved.window.listeners.get('storage') || []) fn({ key: 'dsh-sticky-notes:v1' });
void keepUnsaved.tree;
const keptWork = textareas(keepUnsaved.tree);
assert(
  keptWork.length === 1 && keptWork[0].props.value === 'my unsaved work',
  `another window overwrote work that had never been saved (${JSON.stringify(keptWork.map((t) => t.props.value))})`,
);

// --- the four surfaces ----------------------------------------------------
// The overlay is only one of them now: the sidebar entry, the page and the
// settings page are what the user asked for, so their registrations are part of
// the contract this check protects.
const surfaces = createRuntime(SEED);
assert(surfaces.registrations.size === 4, `registered ${surfaces.registrations.size} surfaces`);
for (const slot of ['shell.overlay', 'sidebar.panellist', 'main', 'settings.section']) {
  assert(surfaces.registrations.has(slot), `nothing registered into ${slot}`);
}
const sidebar = surfaces.registrations.get('sidebar.panellist').options;
assert(sidebar.id === 'sticky-notes', `sidebar entry id is ${sidebar.id}`);
assert(typeof sidebar.label === 'function', 'sidebar label is not a thunk');
assert(sidebar.label() === '便签', `sidebar label is ${JSON.stringify(sidebar.label())}`);
const page = surfaces.registrations.get('main').options;
assert(page.key === 'sticky-notes', `main key is ${page.key}`);
const settings = surfaces.registrations.get('settings.section');
assert(settings.options.id === 'sticky-notes', `settings id is ${settings.options.id}`);
assert(typeof settings.options.label === 'function', 'settings label is not a thunk');

// The page and the panel are two views of one list, not two lists.
const pageTree = surfaces.mount('main');
assert(findAll(pageTree, (n) => String(n.props?.className || '').split(' ').includes('dsn-page'))[0], 'page root is not .dsn-page');
assert(findAll(pageTree, (n) => String(n.props?.className || '').split(' ').includes('dsb-root'))[0], 'page root lacks the baseline .dsb-root mapping');
const pageAreas = textareas(pageTree);
assert(pageAreas.length === 1 && pageAreas[0].props.value === SEED[0].text, `page shows ${JSON.stringify(pageAreas.map((t) => t.props.value))}`);
assert(byClass(pageTree, 'dsn-page-sub').props.children.join('').includes('1'), 'page count is wrong');
button(pageTree, '新建便签').props.onClick();
const afterAdd = textareas(surfaces.tree);
assert(afterAdd.length === 2, `page add produced ${afterAdd.length} notes`);
surfaces.mount('shell.overlay');
byClass(surfaces.tree, 'dsn-tab').props.onClick();
assert(textareas(surfaces.tree).length === 2, 'the panel does not see the note added on the page');

// Turning the floating panel off must actually remove it, and the setting has to
// survive into this page's own view of the store.
const settingsTree = surfaces.mount('settings.section');
const checks = findAll(settingsTree, (n) => n.props && n.props.className === 'dsn-check');
assert(checks.length === 4, `settings page has ${checks.length} switches, want 4`);
const [check] = checks;
assert(check.props.type === 'checkbox', 'settings page has no overlay switch');
assert(check.props.checked === true, 'overlay switch starts off');
check.props.onChange({ target: { checked: false } });
assert(byClass(surfaces.tree, 'dsn-check').props.checked === false, 'the overlay switch did not stay off');
assert(
  JSON.parse(surfaces.disk.get('dsh-sticky-notes:settings')).overlay === false,
  `settings not persisted (${surfaces.disk.get('dsh-sticky-notes:settings')})`,
);
surfaces.mount('shell.overlay');
assert(surfaces.tree === null, 'the floating panel still renders with its switch off');

// The sidebar switch is a registration-level toggle, not a component that
// renders nothing: the sidebar lists entries, so a hidden-but-registered entry
// would still leave a blank button.
const sidebarOff = createRuntime(SEED);
assert(sidebarOff.registrations.has('sidebar.panellist'), 'the sidebar entry was never registered');
const sidebarChecks = findAll(sidebarOff.mount('settings.section'), (n) => n.props && n.props.className === 'dsn-check');
assert(sidebarChecks.length === 4, `settings has ${sidebarChecks.length} switches`);
sidebarChecks[1].props.onChange({ target: { checked: false } });
assert(!sidebarOff.registrations.has('sidebar.panellist'), 'turning the sidebar off left its entry registered');
sidebarChecks[1].props.onChange({ target: { checked: true } });
assert(sidebarOff.registrations.has('sidebar.panellist'), 'turning the sidebar back on did not re-register it');
assert(sidebarOff.registrations.has('main'), 'the sidebar switch removed the page too');

// Markdown preview is the default: the note renders through the platform
// renderer instead of a textarea, and clicking it returns to plain editing.
const md = createRuntime(SEED, undefined, undefined, { markdown: true });
md.mount('main');
const previewCard = byClass(md.tree, 'dsn-preview');
assert(previewCard, 'the default view is not a markdown preview');
assert(textareas(md.tree).length === 0, 'the preview should not also render a textarea');
assert(
  findAll(previewCard, (n) => n.props && n.props.className === 'md-stub').length === 1,
  'the preview did not go through MarkdownText',
);
// The mode is switched by this card's own button, top right — clicking the
// rendered text no longer edits it.
const toggle = byClass(md.tree, 'dsn-toggle');
assert(toggle, 'the per-note view switch is missing');
assert(toggle.props['aria-pressed'] === true, 'the switch does not report the rendered state');
toggle.props.onClick();
const editing = textareas(md.tree);
assert(editing.length === 1 && editing[0].props.value === SEED[0].text, 'the switch did not open the textarea');
assert(byClass(md.tree, 'dsn-toggle').props['aria-pressed'] === false, 'the switch did not flip to plain text');
// Blur keeps the note in edit mode: the button owns the mode, so moving focus
// away to reach it must not switch the view underneath the click.
editing[0].props.onBlur();
assert(textareas(md.tree).length === 1, 'blur switched the view even though the button owns the mode');
byClass(md.tree, 'dsn-toggle').props.onClick();
assert(byClass(md.tree, 'dsn-preview'), 'the switch did not return to the rendered view');
assert(byClass(md.tree, 'dsn-toggle').props['aria-pressed'] === true, 'the switch did not report the rendered state again');

// The switch has to be able to turn it off, and then the textarea is the view.
const mdOff = createRuntime(SEED, undefined, undefined, { markdown: true });
const mdSettings = findAll(mdOff.mount('settings.section'), (n) => n.props && n.props.className === 'dsn-check');
mdSettings[2].props.onChange({ target: { checked: false } });
mdOff.mount('main');
assert(!byClass(mdOff.tree, 'dsn-preview'), 'markdown off still rendered a preview');
// With markdown off there is nothing to switch, so the button must not appear.
assert(!byClass(mdOff.tree, 'dsn-toggle'), 'markdown off still rendered the per-note view switch');
const plainCard = textareas(mdOff.tree)[0];
assert(plainCard && plainCard.props.value === SEED[0].text, 'markdown off should leave a plain textarea');

// --- new settings: badge, width, order --------------------------------------
// The badge switch removes the count from the floating tab without touching
// notes, and the width lands on the panel as an inline style.
const tuned = createRuntime(SEED);
const tunedChecks = findAll(tuned.mount('settings.section'), (n) => n.props && n.props.className === 'dsn-check');
assert(tunedChecks[3].props.checked === true, 'the badge switch does not start on');
tunedChecks[3].props.onChange({ target: { checked: false } });
assert(
  JSON.parse(tuned.disk.get('dsh-sticky-notes:settings')).badge === false,
  `badge switch not persisted (${tuned.disk.get('dsh-sticky-notes:settings')})`,
);
tuned.mount('shell.overlay');
byClass(tuned.tree, 'dsn-tab').props.onClick();
assert(!byClass(tuned.tree, 'dsn-badge'), 'the badge still shows with its switch off');
assert(textareas(tuned.tree).length === 1, 'turning the badge off lost the note');

const widthPick = createRuntime(SEED);
widthPick.mount('settings.section');
const widthInput = byClass(widthPick.tree, 'dsn-width');
assert(widthInput && widthInput.props.type === 'number' && widthInput.props.value === 320, 'the width input is missing or not 320');
widthInput.props.onChange({ target: { value: '480' } });
assert(
  JSON.parse(widthPick.disk.get('dsh-sticky-notes:settings')).width === 480,
  `width not persisted (${widthPick.disk.get('dsh-sticky-notes:settings')})`,
);
widthPick.mount('shell.overlay');
byClass(widthPick.tree, 'dsn-tab').props.onClick();
assert(byClass(widthPick.tree, 'dsn-panel').props.style.width === '480px', 'the width preference did not reach the panel');
// A hand-edited absurd value must not be able to break the layout. It arrives
// the way a real out-of-window edit does: through the `storage` event.
widthPick.disk.set('dsh-sticky-notes:settings', '{"width":9999}');
for (const fn of widthPick.window.listeners.get('storage') || []) fn({ key: 'dsh-sticky-notes:settings' });
// The panel is still open; the tree getter flushes the re-render the reload caused.
assert(byClass(widthPick.tree, 'dsn-panel').props.style.width === '560px', 'an absurd width was not clamped to 560');
// Typing an absurd width must clamp immediately too, not only after a reload.
widthPick.mount('settings.section');
const widthLive = byClass(widthPick.tree, 'dsn-width');
widthLive.props.onChange({ target: { value: '9999' } });
void widthPick.tree;
assert(byClass(widthPick.tree, 'dsn-width').props.value === 560, 'a typed absurd width was not clamped live');

// Order is a list-level preference shared by the panel and the page.
const ordered = createRuntime([
  { id: 'a1', text: 'first', updatedAt: 1762312345000 },
  { id: 'b2', text: 'second', updatedAt: 1762312345001 },
]);
ordered.mount('main');
const orderedCards = textareas(ordered.tree);
assert(orderedCards[0].props.value === 'first', 'the newest-first default changed');
ordered.mount('settings.section');
const orderSegments = findAll(ordered.tree, (n) => n.props?.className === 'dsn-seg');
assert(orderSegments.length === 2, `the order control has ${orderSegments.length} options, want 2`);
assert(orderSegments[0].props['aria-pressed'] === true, 'the newest-first option does not start selected');
assert(!findAll(ordered.tree, (n) => n.type === 'select').length, 'a native <select> would ignore the dark theme');
orderSegments[1].props.onClick();
assert(
  JSON.parse(ordered.disk.get('dsh-sticky-notes:settings')).order === 'oldest',
  `order not persisted (${ordered.disk.get('dsh-sticky-notes:settings')})`,
);
ordered.mount('main');
const flipped = textareas(ordered.tree);
assert(flipped[0].props.value === 'second', 'choosing oldest-first did not flip the list');
ordered.mount('shell.overlay');
byClass(ordered.tree, 'dsn-tab').props.onClick();
assert(textareas(ordered.tree)[0].props.value === 'second', 'the panel shows a different order than the page');

// Clearing is a two-step action and must empty the one shared list.
const clearing = createRuntime(SEED);
clearing.mount('settings.section');
button(clearing.tree, '删除全部便签').props.onClick();
assert(button(clearing.tree, '确认全部删除'), 'the first clear click did not ask for confirmation');
assert(clearing.disk.get('dsh-sticky-notes:v1') === JSON.stringify(SEED), `the first clear click already deleted notes (${clearing.disk.get('dsh-sticky-notes:v1')})`);
button(clearing.tree, '确认全部删除').props.onClick();
clearing.mount('shell.overlay');
byClass(clearing.tree, 'dsn-tab').props.onClick();
assert(textareas(clearing.tree).length === 0, 'clearing did not empty the list');
assert(clearing.disk.get('dsh-sticky-notes:v1') === '[]', `clearing did not reach disk (${clearing.disk.get('dsh-sticky-notes:v1')})`);

// --- dragging: the tab moves, and the position is remembered ----------
// A pointerdown from the tab: the handler reads the root's box to know where
// inside it the grab started, so the stub has to answer getBoundingClientRect.
// The pointer listeners are attached by an effect, which React runs after the
// commit that set `dragging` — so the test has to flush the tree first, exactly
// as the browser would before the next pointermove arrives.
const grab = (runtime, left, top, clientX, clientY) => {
  byClass(runtime.tree, 'dsn-tab').props.onPointerDown({
    button: 0,
    clientX,
    clientY,
    preventDefault: () => {},
    currentTarget: { closest: () => ({ getBoundingClientRect: () => ({ left, top, width: 40, height: 40 }) }) },
  });
  void runtime.tree;
};

const drag = createRuntime(SEED);
const dragRoot = drag.mount();
assert(dragRoot.props.style === undefined, 'the panel starts at its default position');
// While dragging, the root carries `dsn-dragging`, so match on the prefix.
const rootOf = (runtime) => findAll(runtime.tree, (n) => String(n.props?.className || '').startsWith('dsn-root'))[0];
grab(drag, 90, 60, 100, 100);
[...drag.window.listeners.get('pointermove')][0]({ clientX: 180, clientY: 160 });
const moved = rootOf(drag);
assert(moved.props.style && moved.props.style.left === '170px', `drag moved to ${JSON.stringify(moved.props.style)}`);
[...drag.window.listeners.get('pointerup')][0]({});
assert(drag.disk.get('dsh-sticky-notes:pos') === '{"x":170,"y":120}', `position not saved (${drag.disk.get('dsh-sticky-notes:pos')})`);

// A click that follows a drag is the tail of the drag, not a request to open.
grab(drag, 170, 120, 200, 140);
[...drag.window.listeners.get('pointermove')][0]({ clientX: 260, clientY: 240 });
[...drag.window.listeners.get('pointerup')][0]({});
byClass(drag.tree, 'dsn-tab').props.onClick();
assert(!byClass(drag.tree, 'dsn-panel'), 'dragging the tab also opened the panel');

// A saved position comes back on the next visit.
const rePos = createRuntime(SEED);
rePos.disk.set('dsh-sticky-notes:pos', '{"x":40,"y":50}');
const rePosRoot = rePos.mount();
assert(rePosRoot.props.style.left === '40px', `saved position not restored (${JSON.stringify(rePosRoot.props.style)})`);
assert(!rePosRoot.props.className.includes('dsn-flip'), 'a tab near the left edge was flipped');

// Dragged near the right edge, the panel must open leftwards instead of off-screen.
const rightEdge = createRuntime(SEED);
rightEdge.disk.set('dsh-sticky-notes:pos', '{"x":1000,"y":50}');
assert(rootOf(rightEdge).props.className.includes('dsn-flip'), 'the panel still opens rightwards near the right edge');

// A position saved on a bigger screen must not strand the tab off-screen.
const offscreen = createRuntime(SEED);
offscreen.window.innerWidth = 300;
offscreen.window.innerHeight = 200;
offscreen.disk.set('dsh-sticky-notes:pos', '{"x":5000,"y":5000}');
assert(offscreen.mount().props.style.left === '300px', 'an off-screen position was not clamped');

// --- the boot guard: a broken mount must not take the Web UI down ----------
// This bundle sits in the fatal boot set, so apply() has to swallow every
// synchronous failure ("web boot: 1 entry did not activate" is what a throw
// costs the user). Forcing a throw from a service proves the guard holds.
const guarded = createRuntime(null);
guarded.face.apply({
  get: () => undefined,
  on: () => () => {},
  provide: () => () => {},
  effect: () => { throw new Error('styles exploded'); },
  slots: { inject: () => () => {}, register: () => () => {} },
});
console.log('apply() survived a throwing service');

// The register() call happens inside the slots generator, which runs long after
// apply() returned — the outer guard cannot see it. If this throw escaped it
// would still take the boot down.
const guardedSlot = createRuntime(null);
let slotThrew = false;
guardedSlot.face.apply({
  get: () => undefined,
  on: () => () => {},
  provide: () => () => {},
  effect: () => () => {},
  slots: {
    inject: (_name, gen) => {
      try {
        for (const _ of gen()) void _;
      } catch {
        slotThrew = true;
      }
    },
    register: () => { throw new Error('slot registry exploded'); },
  },
});
assert(!slotThrew, 'a failing slots.register escaped the guard');
console.log('apply() survived a throwing slot registration');

// --- pasted images: clipboard → data URL → gallery → disk -------------------
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const pasteInto = async (runtime, textArea, items) => {
  textArea.props.onPaste({
    preventDefault: () => {},
    clipboardData: { items },
  });
  // FileReader completes in a microtask, and React flushes after it — the same
  // ordering the browser gives. Let the microtask queue drain, then commit.
  await Promise.resolve();
  void runtime.tree;
};
const fileItem = (type, name, size, dataUrl) => ({
  kind: 'file',
  type,
  getAsFile: () => ({ type, name, size, dataUrl }),
});
const textItem = (text) => ({ kind: 'string', type: 'text/plain', getAsFile: () => null });

const paste = createRuntime(null);
paste.mount();
byClass(paste.tree, 'dsn-tab').props.onClick();
button(paste.tree, '新建便签').props.onClick();
// A clipboard carries text alongside the image: only the image is attached.
await pasteInto(paste, textareas(paste.tree)[0], [textItem('copied text'), fileItem('image/png', 'shot', 4096)]);
const pastedCard = findAll(paste.tree, (n) => n.props?.className === 'dsn-gallery');
assert(pastedCard.length === 1, 'the pasted image produced no gallery');
const pastedImg = findAll(pastedCard[0], (n) => n.type === 'img')[0];
assert(pastedImg && pastedImg.props.src === 'data:image/png;base64,STUB=shot', 'the attached image is not the file that was read');
assert(
  paste.disk.get('dsh-sticky-notes:v1')?.includes('STUB=shot'),
  `the pasted image was not persisted (${paste.disk.get('dsh-sticky-notes:v1')})`,
);
// The image alone keeps the note alive on blur: it IS content.
textareas(paste.tree)[0].props.onBlur();
void paste.tree;
assert(findAll(paste.tree, (n) => n.props?.className === 'dsn-gallery').length === 1, 'a note holding only an image was dropped on blur');

// Removing the image from a textless note leaves a blank, which closePanel
// housekeeping then drops — no orphan empty notes.
const removeBtn = findAll(paste.tree, (n) => n.props?.className === 'dsn-img-remove')[0];
assert(removeBtn && removeBtn.props['aria-label'] === '移除图片', 'the image remove button is missing or untranslated');
removeBtn.props.onClick();
void paste.tree;
assert(findAll(paste.tree, (n) => n.props?.className === 'dsn-gallery').length === 0, 'removing the image left it in the gallery');
assert(!paste.disk.get('dsh-sticky-notes:v1')?.includes('STUB=shot'), 'removing the image left it on disk');

// A second paste appends instead of replacing, and the cap is 8.
await pasteInto(paste, textareas(paste.tree)[0], [fileItem('image/png', 'b', 10)]);
await pasteInto(paste, textareas(paste.tree)[0], [fileItem('image/png', 'c', 10)]);
const twoImgs = JSON.parse(paste.disk.get('dsh-sticky-notes:v1'))[0].images;
assert(twoImgs.length === 2, `a second paste replaced the first (${twoImgs.length} images)`);
assert(twoImgs[1].includes('STUB=c'), 'the second pasted image did not land last');
const eightItems = Array.from({ length: 10 }, (_, i) => fileItem('image/png', `m${i}`, 10));
await pasteInto(paste, textareas(paste.tree)[0], eightItems);
const capped = JSON.parse(paste.disk.get('dsh-sticky-notes:v1'))[0].images;
assert(capped.length === 8, `the 8-image cap did not hold (${capped.length} images)`);

// Oversized files are refused before they can blow the storage quota.
const big = createRuntime(null);
big.mount();
byClass(big.tree, 'dsn-tab').props.onClick();
button(big.tree, '新建便签').props.onClick();
await pasteInto(big, textareas(big.tree)[0], [fileItem('image/png', 'huge', 700 * 1024 + 1)]);
assert(
  !(big.disk.get('dsh-sticky-notes:v1') || '').includes('huge'),
  'an oversized image was stored anyway',
);

// P0 regression: a pasted image must survive a reload. The cap used to be
// measured in file bytes on paste but in data-URL characters on read, so a
// mid-size image was written and then silently dropped on the next load.
const midSize = 600 * 1024;
const midUrl = 'data:image/png;base64,' + 'x'.repeat(Math.ceil(midSize / 3) * 4);
const midPaste = createRuntime(null);
midPaste.mount();
byClass(midPaste.tree, 'dsn-tab').props.onClick();
button(midPaste.tree, '新建便签').props.onClick();
await pasteInto(midPaste, textareas(midPaste.tree)[0], [fileItem('image/png', 'mid', midSize, midUrl)]);
assert(
  !(midPaste.disk.get('dsh-sticky-notes:v1') || '').includes(midUrl),
  'an image whose data URL exceeds the cap was pasted and would be lost on reload',
);

// An in-cap image is stored AND comes back after a reload.
const okUrl = 'data:image/png;base64,' + 'x'.repeat(500 * 1024);
const okPaste = createRuntime(null);
okPaste.mount();
byClass(okPaste.tree, 'dsn-tab').props.onClick();
button(okPaste.tree, '新建便签').props.onClick();
await pasteInto(okPaste, textareas(okPaste.tree)[0], [fileItem('image/png', 'ok', 300 * 1024, okUrl)]);
const okStored = JSON.parse(okPaste.disk.get('dsh-sticky-notes:v1') || '[]');
assert(okStored[0]?.images?.length === 1, 'an in-cap image was not stored');
const okReload = createRuntime(null, okPaste.disk.get('dsh-sticky-notes:v1'));
okReload.mount();
byClass(okReload.tree, 'dsn-tab').props.onClick();
assert(
  findAll(okReload.tree, (n) => n.type === 'img').length === 1,
  'an in-cap image was silently dropped on reload (paste/read cap mismatch)',
);

// Hostile stored data: a non-image or absurd "data URL" is cleaned on read and
// the cleaned value is what gets written back — the junk never comes back.
const dirtyImages = createRuntime(null, JSON.stringify([
  { id: 'i1', text: 'note', images: ['javascript:alert(1)', 'data:image/png;base64,ok', 'data:image/png;base64,' + 'x'.repeat(800 * 1024), { evil: true }], updatedAt: 1 },
  { id: 'i2', text: 'cap', images: Array.from({ length: 9 }, (_, i) => `data:image/png;base64,v${i}`), updatedAt: 2 },
]));
dirtyImages.mount();
byClass(dirtyImages.tree, 'dsn-tab').props.onClick();
// Reading alone must not overwrite; a user edit is what authorises the write,
// and the edited list has to carry the cleaned images, not the hostile ones.
textareas(dirtyImages.tree)[0].props.onChange({ target: { value: 'note' } });
const cleaned = JSON.parse(dirtyImages.disk.get('dsh-sticky-notes:v1') || 'null');
assert(Array.isArray(cleaned) && cleaned.length === 2, 'hostile image data broke the round trip');
assert(
  Array.isArray(cleaned) && cleaned.length === 2 && cleaned[0].images.length === 1 && cleaned[0].images[0] === 'data:image/png;base64,ok',
  'hostile image data was not cleaned down to the one valid data URL',
);
assert(
  cleaned[1].images.length === 8 && cleaned[1].images[7] === 'data:image/png;base64,v7',
  'a hand-edited 9-image note was not capped to 8 on read',
);

// The paste hint teaches the feature that has no button; it must actually render.
const hintTree = paste.mount();
assert(
  findAll(hintTree, (n) => n.props && n.props.className === 'dsn-hint' && String(n.props.children).includes('粘贴图片')).length === 1,
  'the paste hint did not render in the panel',
);

console.log('images=ok');
console.log('SMOKE OK: markdown preview, settings, images, storage and boot guards all pass');
