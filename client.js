window.__ModuleLoader__.load({
  id: 'dsh-sticky-note-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect } = React;

    // `MarkdownText` is the Harness renderer, so notes look like the rest of the
    // app instead of a second markdown implementation. It comes from the platform
    // seed table, which a static bundle may require even when the package never
    // appears in the served graph. A missing one degrades to plain text rather
    // than taking the panel down.
    let MarkdownText = null;
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
      // It is a `React.memo(...)` result, i.e. an object, not a function — testing
      // for "function" here silently disabled every preview.
      const candidate = primitives && primitives.MarkdownText;
      if (typeof candidate === 'function' || (typeof candidate === 'object' && candidate !== null)) {
        MarkdownText = candidate;
      }
    } catch {
      MarkdownText = null;
    }

    const STORAGE_KEY = 'dsh-sticky-notes:v1';
    const STYLE_ATTR = 'dsh-sticky-notes';
    // Images ride along as data URLs inside the same localStorage value, so each
    // one is capped: 8 images × ~700 KB of data URL ≈ 5.6 MB worst case, and the
    // quota failure already surfaces as the "storage unavailable" warning.
    const MAX_IMAGES = 8;
    // The cap is on the stored data URL (a string), not on the source file.
    // Base64 expands a file by 4/3, so measuring the file in bytes let a
    // ~525-700 KB image pass the paste guard while its data URL was rejected
    // by the read filter: pasted, saved, then silently lost on the next load.
    // Both guards now use the same unit (data URL characters).
    const MAX_IMAGE_DATA = 700 * 1024;
    // Headroom for the data: prefix and longer image subtypes.
    const MAX_DATA_PREFIX = 64;

    // A boot-time client half runs as a static bundle: its factory only receives
    // `require`. `styles`/`host` are dynamic-runner parameters and are undefined
    // here, so the stylesheet is installed by hand (same as dsh-disk-cleaner).
    function insertStyles(css) {
      const el = document.createElement('style');
      el.dataset.plugin = STYLE_ATTR;
      el.textContent = css;
      document.head.appendChild(el);
      return () => {
        if (el.parentNode) el.parentNode.removeChild(el);
      };
    }

    const CSS = `
      .dsn-root { position: fixed; left: 16px; top: 50%; transform: translateY(-50%); z-index: 2147482000; pointer-events: none; font-size: 13px; color: var(--dsw-alias-label-primary); }
      .dsn-tab { pointer-events: auto; display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 10px 7px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); cursor: grab; box-shadow: 0 2px 10px rgba(0,0,0,.12); touch-action: none; user-select: none; }
      .dsn-dragging .dsn-tab { cursor: grabbing; }
      .dsn-tab:hover { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-border-l2); }
      .dsn-badge { min-width: 16px; padding: 0 4px; border-radius: 8px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-size: 10px; line-height: 16px; text-align: center; }
      .dsn-panel { position: absolute; top: 0; left: calc(100% + 10px); pointer-events: auto; width: 320px; max-width: calc(100vw - 48px); max-height: calc(50vh - 12px); display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.18); overflow: hidden; }
      .dsn-head { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
      .dsn-title { flex: 1; font-size: 12px; font-weight: 600; letter-spacing: .02em; }
      .dsn-list { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
      .dsn-root.dsn-flip .dsn-panel { left: auto; right: calc(100% + 10px); }
      .dsn-note { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; padding: 8px; display: flex; flex-direction: column; gap: 5px; }
      .dsn-note-head { display: flex; align-items: center; justify-content: flex-end; margin: -4px -4px -2px 0; }
      .dsn-toggle { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); border-radius: 6px; font: inherit; font-size: 10px; line-height: 14px; padding: 0 5px; cursor: pointer; }
      .dsn-toggle:hover { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-border-l2); }
      .dsn-note textarea { width: 100%; box-sizing: border-box; resize: none; border: none; outline: none; background: transparent; color: inherit; font: inherit; line-height: 1.5; padding: 0; }
      .dsn-preview { line-height: 1.55; min-height: 1.55em; overflow-wrap: anywhere; }
      .dsn-preview > div > :first-child { margin-top: 0; }
      .dsn-preview > div > :last-child { margin-bottom: 0; }
      .dsn-meta { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 10px; color: var(--dsw-alias-label-secondary); }
      .dsn-actions { display: flex; gap: 4px; }
      .dsn-btn { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); border-radius: 7px; font: inherit; font-size: 11px; padding: 2px 8px; cursor: pointer; }
      .dsn-btn:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
      .dsn-btn.dsn-danger:hover { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .dsn-empty { padding: 22px 10px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.8; }
      .dsn-hint { padding: 2px 10px 6px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.6; }
      .dsn-warn { padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-state-warn-primary); font-size: 11px; line-height: 1.5; }
      .dsn-page { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; }
      .dsn-page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .dsn-page-title { margin: 0; font-size: 16px; font-weight: 600; }
      .dsn-page-sub { margin: 2px 0 0; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .dsn-page-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 20px; }
      .dsn-page-body .dsn-list { overflow: visible; padding: 0; }
      .dsn-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
      .dsn-btn-primary:hover { color: var(--dsw-alias-bg-base); opacity: .9; }
      .dsn-btn[disabled] { opacity: .45; cursor: default; }
      .dsn-settings { display: flex; flex-direction: column; gap: 4px; padding: 4px 0; color: var(--dsw-alias-label-primary); font-size: 13px; }
      .dsn-settings-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 2px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .dsn-settings-text { display: flex; flex-direction: column; gap: 3px; }
      .dsn-settings-label { font-weight: 500; }
      .dsn-settings-hint { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
      .dsn-check { width: 16px; height: 16px; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
      .dsn-width { width: 72px; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; padding: 3px 6px; }
      .dsn-segment { display: inline-flex; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; overflow: hidden; }
      .dsn-seg { border: none; border-radius: 0; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; padding: 3px 9px; cursor: pointer; }
      .dsn-seg + .dsn-seg { border-left: 1px solid var(--dsw-alias-border-l1); }
      .dsn-seg:hover { color: var(--dsw-alias-label-primary); }
      .dsn-seg[aria-pressed="true"] { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
      .dsn-gallery { display: flex; flex-wrap: wrap; gap: 6px; }
      .dsn-img { position: relative; display: inline-block; }
      .dsn-img img { display: block; max-width: 100%; max-height: 120px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); }
      .dsn-img-remove { position: absolute; top: -6px; right: -6px; width: 16px; height: 16px; padding: 0; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); font: inherit; font-size: 10px; line-height: 14px; cursor: pointer; }
      .dsn-img-remove:hover { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
    `;

    const DICT = {
      en: {
        open: 'Sticky notes',
        title: 'Sticky notes',
        add: 'New note',
        empty: 'No notes yet.\nPress “New note” to write one.',
        placeholder: 'Write something…',
        remove: 'Delete',
        removeConfirm: 'Delete this note?',
        removeSure: 'Confirm',
        close: 'Close',
        note: 'Note',
        unsaved: 'Storage is unavailable — these notes live only until you close this page.',
        unreadable: 'Saved notes could not be read. They are left untouched on disk; notes you add will replace them.',
        countUnit: 'notes',
        overlayLabel: 'Floating panel',
        overlayHint: 'Show the quick panel beside the conversation. Turn it off to use the full page only.',
        sidebarLabel: 'Sidebar entry',
        sidebarHint: 'Show the notes icon in the left sidebar. The settings page below stays reachable either way.',
        markdownLabel: 'Markdown preview',
        markdownHint: 'Show a Markdown / plain-text switch on each note. Turned off, every note is a plain text field.',
        badgeLabel: 'Count badge',
        badgeHint: 'Show how many notes you have on the floating tab.',
        widthLabel: 'Panel width',
        widthHint: 'Width of the floating panel, 240–560 pixels.',
        orderLabel: 'Note order',
        orderHint: 'Which end of the list the newest note sits at.',
        orderNewest: 'Newest first',
        orderOldest: 'Oldest first',
        clearAll: 'Delete all notes',
        clearConfirm: 'Delete all',
        countLabel: 'Notes',
        removeImage: 'Remove image',
        pasteHint: 'Paste an image into a note to attach it (up to 8).',
        viewMarkdown: 'Markdown',
        viewPlain: 'Plain text',
      },
      zh: {
        open: '便签',
        title: '便签',
        add: '新建便签',
        empty: '还没有便签。\n点「新建便签」写一条。',
        placeholder: '随手记点什么…',
        remove: '删除',
        removeConfirm: '删除这条便签？',
        removeSure: '确认删除',
        close: '关闭',
        note: '便签',
        unsaved: '存储不可用——这些便签只保留到关闭页面为止。',
        unreadable: '已保存的便签读不出来。原始内容没有被动过；你新增便签时才会覆盖它。',
        countUnit: '条便签',
        overlayLabel: '浮动面板',
        overlayHint: '在对话旁显示快捷面板。关掉后只使用完整页面。',
        sidebarLabel: '侧边栏入口',
        sidebarHint: '在左侧边栏显示便签图标。关掉后仍可从设置进入。',
        markdownLabel: 'Markdown 预览',
        markdownHint: '在每张便签右上角显示 Markdown / 纯文本切换按钮。关掉后所有便签都是纯文本输入框。',
        badgeLabel: '计数徽章',
        badgeHint: '在浮动标签上显示便签数量。',
        widthLabel: '面板宽度',
        widthHint: '浮动面板的宽度，240–560 像素。',
        orderLabel: '便签排序',
        orderHint: '最新的便签排在列表哪一端。',
        orderNewest: '最新的在前',
        orderOldest: '最旧的在前',
        clearAll: '删除全部便签',
        clearConfirm: '确认全部删除',
        countLabel: '便签数',
        removeImage: '移除图片',
        pasteHint: '在便签里粘贴图片即可附加（最多 8 张）。',
        viewMarkdown: 'Markdown',
        viewPlain: '纯文本',
      },
    };

    function newId() {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    // Set when stored content exists but cannot be parsed. The panel must not
    // then write back the empty list it fell back to — that turns a corrupt
    // value the user might still salvage into permanent data loss.
    let readFailed = false;

    function readNotes() {
      readFailed = false;
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) throw new Error('stored notes are not a list');
        const kept = parsed.filter((n) => n && typeof n.text === 'string');
        // Dropping entries silently is data loss too: treat a partial read as a
        // failed read so the panel refuses to write over the original value.
        if (kept.length !== parsed.length) readFailed = true;
        // ids key the React list and select what editNote/removeNote touch, so a
        // duplicate id makes one note edit or delete another. newId() can collide
        // (timestamp + 5 random chars) and stored data can be hand-edited.
        const seen = new Set();
        let reassigned = 0;
        const notes = kept.map((n) => {
          let id = typeof n.id === 'string' && n.id !== '' ? n.id : newId();
          if (seen.has(id)) {
            id = newId();
            reassigned += 1;
          }
          seen.add(id);
          // An image list is only data URLs this bundle would have written; a
          // hand-edited store gets cleaned rather than trusted.
          const images = Array.isArray(n.images)
            ? n.images.filter((src) => typeof src === 'string' && src.startsWith('data:image/') && src.length <= MAX_IMAGE_DATA).slice(0, MAX_IMAGES)
            : [];
          return {
            id,
            text: n.text,
            images,
            // Number.isFinite, not typeof: `1e999` parses to Infinity and
            // `NaN` survives a hand-edited store, and both render as
            // "Invalid Date" in every note's header.
            updatedAt: Number.isFinite(n.updatedAt) ? n.updatedAt : Date.now(),
          };
        });
        // A repaired id is not a user edit: it must not by itself authorise a
        // write over the original value.
        if (reassigned > 0) readFailed = true;
        return notes;
      } catch {
        readFailed = true;
        return [];
      }
    }

    function writeNotes(notes) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
        return true;
      } catch {
        // Storage disabled or full. The note stays on screen for this page only,
        // so the panel has to say so — a silent failure reads as "saved".
        return false;
      }
    }

    // One in-memory source of truth. The floating panel, the full page, and the
    // settings section are separate slot registrations, but they must show the
    // same notes. A `storage` event only fires in OTHER windows, so letting each
    // surface read localStorage on its own would let them drift apart inside this
    // one window — two views of the same list, editing different copies.
    function createNotesStore() {
      let state = { notes: readNotes(), unreadable: readFailed, unsaved: false };
      const listeners = new Set();
      const emit = () => {
        for (const listener of [...listeners]) listener();
      };

      const persist = (notes, explicit) => {
        // An image is content even with no text, so the blank-drop filter has to
        // count it — otherwise a pasted screenshot alone would never reach disk.
        const kept = notes.filter((n) => n.text.trim() !== '' || n.images.length > 0);
        // Writing `[]` over a value we could not read is the same data loss as
        // writing the salvaged subset: both erase what was there. Only an
        // explicit delete outranks the promise to leave the original alone.
        if (state.unreadable && kept.length === 0 && !explicit) {
          state = { notes, unreadable: state.unreadable, unsaved: false };
          emit();
          return;
        }
        const ok = writeNotes(kept);
        state = { notes, unreadable: ok ? false : state.unreadable, unsaved: !ok };
        emit();
      };

      // Another window writing the same key fires `storage` here (never in the
      // window that wrote it), so following it keeps two open windows from
      // silently overwriting each other's notes.
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('storage', (event) => {
          if (event.key !== null && event.key !== STORAGE_KEY) return;
          // This window could not write, so the text it shows exists nowhere
          // else. Adopting a remote value would destroy the only copy of work
          // already flagged as unsaved.
          // ponytail: last-write-wins for work that did reach disk; merging two
          // windows' edits needs a baseline this bundle does not keep.
          if (state.unsaved) return;
          state = { notes: readNotes(), unreadable: readFailed, unsaved: false };
          emit();
        });
      }

      return {
        get: () => state,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        create() {
          persist([{ id: newId(), text: '', images: [], updatedAt: Date.now() }, ...state.notes], false);
        },
        edit(id, text) {
          persist(
            state.notes.map((n) => (n.id === id ? { ...n, text, updatedAt: Date.now() } : n)),
            false,
          );
        },
        attach(id, image) {
          // One event can paste several items; each accepted image lands here.
          persist(
            state.notes.map((n) => (n.id === id ? { ...n, images: [...n.images, image].slice(-MAX_IMAGES), updatedAt: Date.now() } : n)),
            false,
          );
        },
        detach(id, image) {
          persist(
            state.notes.map((n) => (n.id === id ? { ...n, images: n.images.filter((src) => src !== image), updatedAt: Date.now() } : n)),
            false,
          );
        },
        remove(id, explicit) {
          persist(
            state.notes.filter((n) => n.id !== id),
            explicit,
          );
        },
        // Closing drops notes the user never wrote in. Reading the list through
        // the store keeps this correct wherever it is called from.
        dropBlanks() {
          const kept = state.notes.filter((n) => n.text.trim() !== '' || n.images.length > 0);
          if (kept.length === state.notes.length) return;
          persist(kept, false);
        },
        // Clearing is a deliberate act, so it outranks the promise to leave
        // unreadable storage alone — otherwise the button would do nothing.
        clear() {
          persist([], true);
        },
      };
    }

    const notesStore = createNotesStore();

    function useNotes() {
      const [snapshot, setSnapshot] = useState(notesStore.get);
      // Re-read on mount: the store outlives this component, so a surface that
      // mounts after an edit elsewhere would otherwise show stale notes.
      useEffect(() => {
        setSnapshot(notesStore.get());
        return notesStore.subscribe(() => setSnapshot(notesStore.get()));
      }, []);
      return snapshot;
    }

    // Preferences live under their own key: they describe how notes are shown,
    // not what is in them, so clearing notes must not reset the display.
    const SETTINGS_KEY = 'dsh-sticky-notes:settings';

    function readSettings() {
      try {
        const raw = window.localStorage.getItem(SETTINGS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return {
          overlay: parsed.overlay !== false,
          sidebar: parsed.sidebar !== false,
          markdown: parsed.markdown !== false,
          badge: parsed.badge !== false,
          // 240–560px: narrow enough to hug the edge, wide enough to read. A
          // hand-edited or stale value is clamped, not rejected.
          width: Number.isFinite(parsed.width) ? Math.min(560, Math.max(240, Math.round(parsed.width))) : 320,
          order: parsed.order === 'oldest' ? 'oldest' : 'newest',
        };
      } catch {
        return { overlay: true, sidebar: true, markdown: true, badge: true, width: 320, order: 'newest' };
      }
    }

    function createSettingsStore() {
      let state = readSettings();
      const listeners = new Set();
      return {
        get: () => state,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        set(patch) {
          state = { ...state, ...patch };
          // readSettings clamps stale disk values; clamp the live path too, or
          // typing 9999 into the width field blows the panel up until reload.
          if (Number.isFinite(state.width)) state.width = Math.min(560, Math.max(240, Math.round(state.width)));
          try {
            window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(state));
          } catch {
            // A preference that cannot persist still applies to this page; that
            // beats ignoring the switch the user just flipped.
          }
          for (const listener of [...listeners]) listener();
        },
        // Re-read from disk: another window changed the switches (see the
        // `storage` listener below). The re-read cannot loop, because a
        // `storage` event never fires in the window that wrote the value.
        reload() {
          state = readSettings();
          for (const listener of [...listeners]) listener();
        },
      };
    }

    const settingsStore = createSettingsStore();

    // The `storage` event fires only in windows that did NOT write, so following
    // it is how two open windows agree on the same switches. The settings page
    // here is a place where that matters: toggling the panel off in one window
    // must not leave the other window's panel still on screen.
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('storage', (event) => {
        if (event.key !== null && event.key !== SETTINGS_KEY) return;
        settingsStore.reload();
      });
    }

    function useSettings() {
      const [snapshot, setSnapshot] = useState(settingsStore.get);
      // Same reason as useNotes: the store is module-level, so a surface mounted
      // after the switch was flipped has to pick up the current value.
      useEffect(() => {
        setSnapshot(settingsStore.get());
        return settingsStore.subscribe(() => setSnapshot(settingsStore.get()));
      }, []);
      return snapshot;
    }

    // Where the panel sits is a property of this browser, not of the notes, so it
    // lives next to the notes rather than inside them.
    const POS_KEY = 'dsh-sticky-notes:pos';

    function clampPos(pos, width, height) {
      if (!pos) return null;
      const viewWidth = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 0;
      const viewHeight = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 0;
      const x = Math.min(Math.max(0, pos.x), Math.max(0, viewWidth - (width || 0)));
      const y = Math.min(Math.max(0, pos.y), Math.max(0, viewHeight - (height || 0)));
      return { x, y };
    }

    function readPos() {
      try {
        const raw = window.localStorage.getItem(POS_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        // A position saved on a bigger screen can land off-screen later, so it is
        // re-clamped against the viewport instead of trusted as-is.
        return Number.isFinite(parsed && parsed.x) && Number.isFinite(parsed && parsed.y)
          ? clampPos(parsed)
          : null;
      } catch {
        return null;
      }
    }

    function writePos(pos) {
      try {
        window.localStorage.setItem(POS_KEY, JSON.stringify(pos));
      } catch {
        // Losing the position is cosmetic; the notes themselves matter more.
      }
    }

    function pickDict(tag) {
      return String(tag || '').toLowerCase().startsWith('zh') ? DICT.zh : DICT.en;
    }

    function browserLocale() {
      return typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en';
    }

    // The locale service may be absent (this face only injects `slots`), so fall
    // back to the browser language instead of silently showing English to a
    // Chinese user. A present-but-unusable service must fall back too: reading
    // `.active` off an unexpected snapshot would blank the whole panel.
    function localeTag(locale) {
      try {
        const active = locale && locale.getSnapshot && locale.getSnapshot();
        return active && typeof active.active === 'string' ? active.active : browserLocale();
      } catch {
        return browserLocale();
      }
    }

    function useDict(locale) {
      const [active, setActive] = useState(() => localeTag(locale));
      useEffect(() => {
        if (!locale || typeof locale.subscribe !== 'function') return undefined;
        const sync = () => setActive(localeTag(locale));
        sync();
        return locale.subscribe(sync);
      }, [locale]);
      return pickDict(active);
    }

    function NoteCard({ note, t, index, preview, onChange, onAttach, onDetach, onRemove }) {
      // ponytail: inline two-step confirm instead of window.confirm — Electron's
      // confirm() blocks the whole renderer, and a decorative panel must not.
      const [confirming, setConfirming] = useState(false);
      // A note is a text field until the user asks to see it rendered; editing
      // stays plain text so markdown syntax is editable rather than hidden.
      const [editing, setEditing] = useState(note.text === '');
      const lines = Math.min(12, Math.max(2, note.text.split('\n').length + Math.floor(note.text.length / 34)));
      // The mode is switched by this card's own button, top right. Clicking the
      // rendered text used to edit it, which made a stray click in the panel put
      // a note into edit mode with no obvious way back.
      const canPreview = preview && note.text.trim() !== '';
      const rendered = canPreview && !editing;
      // Pasting is the whole point: an image on the clipboard becomes part of the
      // note without a file picker. Rejected items are skipped, never an error —
      // a clipboard often carries text alongside the image.
      const paste = (event) => {
        const items = event.clipboardData && event.clipboardData.items ? [...event.clipboardData.items] : [];
        const files = items
          .filter((item) => item.kind === 'file' && typeof item.getAsFile === 'function' && item.type.startsWith('image/'))
          .map((item) => item.getAsFile())
          .filter(Boolean);
        if (!files.length) return;
        event.preventDefault();
        for (const file of files) {
          // Reject before decoding when the expanded data URL cannot fit: the
          // read filter measures that string, so this guard must too.
          if (Math.ceil(file.size / 3) * 4 + MAX_DATA_PREFIX > MAX_IMAGE_DATA) continue;
          const reader = new FileReader();
          reader.onload = () => {
            if (
              typeof reader.result === 'string'
              && reader.result.startsWith('data:image/')
              && reader.result.length <= MAX_IMAGE_DATA
            ) onAttach(note.id, reader.result);
          };
          reader.readAsDataURL(file);
        }
      };
      const gallery = note.images.map((src, i) =>
        h(
          'span',
          { key: `${i}:${src.slice(-24)}`, className: 'dsn-img' },
          h('img', { src, alt: '' }),
          h('button', {
            type: 'button',
            className: 'dsn-img-remove',
            'aria-label': t.removeImage,
            onClick: () => onDetach(note.id, src),
          }, '×'),
        ),
      );
      return h(
        'div',
        { className: 'dsn-note' },
        canPreview
          ? h(
              'div',
              { className: 'dsn-note-head' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsn-toggle',
                  'aria-pressed': rendered,
                  'aria-label': rendered ? t.viewPlain : t.viewMarkdown,
                  title: rendered ? t.viewPlain : t.viewMarkdown,
                  onClick: () => setEditing((current) => !current),
                },
                rendered ? t.viewPlain : t.viewMarkdown,
              ),
            )
          : null,
        rendered
          ? h('div', { className: 'dsn-preview' }, h(MarkdownText, { text: note.text, variant: 'compact' }))
          : h('textarea', {
              value: note.text,
              rows: lines,
              placeholder: t.placeholder,
              'aria-label': `${t.note} ${index + 1}`,
              spellCheck: false,
              autoFocus: index === 0 && note.text === '',
              onChange: (event) => onChange(note.id, event.target.value),
              onPaste: paste,
              onBlur: () => {
                // An empty note the user never wrote in is noise, not content, so
                // it is discarded without claiming to be a deliberate delete.
                // A pasted image counts as content even with no text yet.
                // Blur does not switch modes: the button owns that, so leaving a
                // note to click it cannot race the toggle.
                if (note.text.trim() === '' && note.images.length === 0) onRemove(note.id, false);
              },
            }),
        gallery.length ? h('div', { className: 'dsn-gallery' }, gallery) : null,
        h(
          'div',
          { className: 'dsn-meta' },
          h('span', null, new Date(note.updatedAt).toLocaleString()),
          confirming
            ? h(
                'span',
                { className: 'dsn-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsn-btn dsn-danger',
                    onClick: () => onRemove(note.id, true),
                  },
                  t.removeSure,
                ),
                h('button', { type: 'button', className: 'dsn-btn', onClick: () => setConfirming(false) }, t.close),
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: 'dsn-btn dsn-danger',
                  'aria-label': t.removeConfirm,
                  onClick: () => setConfirming(true),
                },
                t.remove,
              ),
        ),
      );
    }

    // The drag origin is not rendered, so it needs no hook state of its own.
    // A module-level slot also survives the re-render that starts the drag.
    const dragState = { current: null };

    // Both surfaces show the same two warnings, so they are rendered in one place
    // and cannot drift apart.
    function Warnings({ t, unreadable, unsaved }) {
      const out = [];
      if (unreadable) out.push(h('div', { key: 'unreadable', className: 'dsn-warn', role: 'status' }, t.unreadable));
      if (unsaved) out.push(h('div', { key: 'unsaved', className: 'dsn-warn', role: 'status' }, t.unsaved));
      return out;
    }

    // Reading the list through the store is what keeps the page, the panel and
    // the settings count showing the same notes.
    function NoteList({ t }) {
      const { notes } = useNotes();
      const settings = useSettings();
      // No renderer available means no preview: better a text field than a crash
      // or a blank card.
      const preview = settings.markdown && MarkdownText !== null;
      if (!notes.length) {
        return h(
          'div',
          { className: 'dsn-empty' },
          t.empty.split('\n').map((line, i) => h('div', { key: i }, line)),
        );
      }
      return h(
        'div',
        { className: 'dsn-list' },
        // `newest` is how the store writes, so that order is a no-op slice.
        (settings.order === 'oldest' ? [...notes].reverse() : notes).map((note, index) =>
          h(NoteCard, {
            key: note.id,
            note,
            t,
            index,
            preview,
            // Text first, then content: this list has one order, and the page and
            // the panel share it.
            onChange: (id, text) => notesStore.edit(id, text),
            onAttach: (id, image) => notesStore.attach(id, image),
            onDetach: (id, image) => notesStore.detach(id, image),
            // `explicit` is what lets a real delete overwrite unreadable storage;
            // discarding a blank note must not.
            onRemove: (id, explicit) => notesStore.remove(id, explicit),
          }),
        ),
        h('div', { className: 'dsn-hint' }, t.pasteHint),
      );
    }

    function StickyNotes({ locale }) {
      const t = useDict(locale);
      // One store backs every surface, so a note written here is the note the page
      // shows. Each component reading localStorage on its own would give the
      // views separate copies, and a `storage` event never fires for the window
      // that wrote it.
      const { notes, unreadable, unsaved } = useNotes();
      const settings = useSettings();
      const [open, setOpen] = useState(false);
      const [pos, setPos] = useState(readPos);

      // Closing drops notes the user never wrote in. The store holds the live
      // list, so this reads the current one instead of a stale closure.
      const closePanel = () => {
        setOpen(false);
        notesStore.dropBlanks();
      };

      const toggle = () => (open ? closePanel() : setOpen(true));

      // Escape closes the panel from anywhere inside it. A floating panel that
      // can only be dismissed by re-clicking its own tab is a trap for keyboard
      // users.
      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') closePanel();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [open]);

      // Dragging is pointer-driven: capture on the handle so the panel keeps
      // following even when the cursor outruns it, and store only the final
      // position — writing on every move would hammer localStorage.
      const dragRef = dragState;
      const [dragging, setDragging] = useState(false);

      const startDrag = (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        const root = event.currentTarget.closest ? event.currentTarget.closest('.dsn-root') : null;
        const box = root && root.getBoundingClientRect ? root.getBoundingClientRect() : null;
        if (!box) return;
        dragRef.current = {
          dx: event.clientX - box.left,
          dy: event.clientY - box.top,
          width: box.width,
          height: box.height,
          fromX: event.clientX,
          fromY: event.clientY,
          moved: false,
        };
        setDragging(true);
        if (event.currentTarget.setPointerCapture && event.pointerId !== undefined) {
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // Capture is an optimisation; the window listeners still work.
          }
        }
        event.preventDefault();
      };

      useEffect(() => {
        if (!dragging) return undefined;
        const onMove = (event) => {
          const start = dragRef.current;
          if (!start) return;
          if (!start.moved) {
            if (Math.abs(event.clientX - start.fromX) + Math.abs(event.clientY - start.fromY) < 4) return;
            start.moved = true;
          }
          setPos(clampPos({ x: event.clientX - start.dx, y: event.clientY - start.dy }, start.width, start.height));
        };
        const onUp = () => {
          setDragging(false);
          setPos((current) => {
            if (current) writePos(current);
            return current;
          });
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
        };
      }, [dragging]);

      // A window resize can leave a saved position off-screen; nudging it back
      // is cheaper than explaining why the tab disappeared.
      useEffect(() => {
        if (typeof window === 'undefined' || !window.addEventListener) return undefined;
        const onResize = () => setPos((current) => clampPos(current));
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);

      // All hooks are above this line, so turning the panel off cannot change the
      // hook order. The full page still shows every note.
      if (!settings.overlay) return null;

      const rootStyle = pos ? { left: `${pos.x}px`, top: `${pos.y}px`, right: 'auto', bottom: 'auto', transform: 'none' } : undefined;
      // The panel opens away from the nearest screen edge, so a tab dragged over
      // to the right half does not push its own panel off-screen.
      const panelWidth = settings.width || 320;
      const flipped = pos && typeof window !== 'undefined' && window.innerWidth > 0
        ? pos.x + 40 + panelWidth > window.innerWidth - 16
        : false;
      const rootClass = ['dsn-root', dragging ? 'dsn-dragging' : '', flipped ? 'dsn-flip' : ''].filter(Boolean).join(' ');

      return h(
        'div',
        { className: rootClass, style: rootStyle },
        h(
          'div',
          {
            className: 'dsn-tab',
            role: 'button',
            tabIndex: 0,
            title: t.open,
            'aria-label': t.open,
            'aria-expanded': open,
            onPointerDown: startDrag,
            onClick: () => {
              // A drag ends with a click on the element it started from. Hiding
              // the panel after moving the tab would look like the drag failed.
              const drag = dragState.current;
              if (drag && drag.moved) {
                drag.moved = false;
                return;
              }
              toggle();
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle();
              }
            },
          },
          h(
            'svg',
            {
              viewBox: '0 0 24 24',
              width: 16,
              height: 16,
              'aria-hidden': true,
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.8,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            },
            h('path', { d: 'M20 4H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h4l3 4 3-4h6a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1Z' }),
            h('path', { d: 'M8 9h8M8 12.5h5' }),
          ),
          notes.length && settings.badge
            ? h('span', { className: 'dsn-badge' }, notes.length > 99 ? '99+' : String(notes.length))
            : null,
        ),
        open
          ? h(
              'div',
              // The width is a preference; max-width still protects narrow windows.
              { className: 'dsn-panel', role: 'region', 'aria-label': t.title, style: { width: `${settings.width}px` } },
              h(
                'div',
                { className: 'dsn-head' },
                h('span', { className: 'dsn-title' }, t.title),
                h('button', { type: 'button', className: 'dsn-btn', onClick: () => notesStore.create() }, t.add),
                h('button', { type: 'button', className: 'dsn-btn', onClick: closePanel, 'aria-label': t.close }, '×'),
              ),
              Warnings({ t, unreadable, unsaved }),
              h(NoteList, { t }),
            )
          : null,
      );
    }

    // The full page. Same store, so a note written here is the note the floating
    // panel shows: two views of one list rather than two lists.
    function NotesPage({ locale }) {
      const t = useDict(locale);
      const { notes, unreadable, unsaved } = useNotes();
      return h(
        'div',
        { className: 'dsn-page' },
        h(
          'div',
          { className: 'dsn-page-head' },
          h(
            'div',
            { className: 'dsn-page-text' },
            h('h1', { className: 'dsn-page-title' }, t.title),
            h('p', { className: 'dsn-page-sub' }, `${notes.length} ${t.countUnit}`),
          ),
          h('button', { type: 'button', className: 'dsn-btn dsn-btn-primary', onClick: () => notesStore.create() }, t.add),
        ),
        Warnings({ t, unreadable, unsaved }),
        h('div', { className: 'dsn-page-body' }, h(NoteList, { t })),
      );
    }

    function NotesSettings({ locale }) {
      const t = useDict(locale);
      const { notes } = useNotes();
      const settings = useSettings();
      const [confirming, setConfirming] = useState(false);
      return h(
        'div',
        { className: 'dsn-settings' },
        h(
          'div',
          { className: 'dsn-settings-row' },
          h(
            'div',
            { className: 'dsn-settings-text' },
            h('div', { className: 'dsn-settings-label' }, t.overlayLabel),
            h('div', { className: 'dsn-settings-hint' }, t.overlayHint),
          ),
          h('input', {
            type: 'checkbox',
            className: 'dsn-check',
            checked: settings.overlay,
            'aria-label': t.overlayLabel,
            onChange: (event) => settingsStore.set({ overlay: event.target.checked }),
          }),
        ),
        h(
          'div',
          { className: 'dsn-settings-row' },
          h(
            'div',
            { className: 'dsn-settings-text' },
            h('div', { className: 'dsn-settings-label' }, t.sidebarLabel),
            h('div', { className: 'dsn-settings-hint' }, t.sidebarHint),
          ),
          h('input', {
            type: 'checkbox',
            className: 'dsn-check',
            checked: settings.sidebar,
            'aria-label': t.sidebarLabel,
            onChange: (event) => settingsStore.set({ sidebar: event.target.checked }),
          }),
        ),
        h(
          'div',
          { className: 'dsn-settings-row' },
          h(
            'div',
            { className: 'dsn-settings-text' },
            h('div', { className: 'dsn-settings-label' }, t.markdownLabel),
            h('div', { className: 'dsn-settings-hint' }, t.markdownHint),
          ),
          h('input', {
            type: 'checkbox',
            className: 'dsn-check',
            checked: settings.markdown,
            'aria-label': t.markdownLabel,
            onChange: (event) => settingsStore.set({ markdown: event.target.checked }),
          }),
        ),
        h(
          'div',
          { className: 'dsn-settings-row' },
          h(
            'div',
            { className: 'dsn-settings-text' },
            h('div', { className: 'dsn-settings-label' }, t.badgeLabel),
            h('div', { className: 'dsn-settings-hint' }, t.badgeHint),
          ),
          h('input', {
            type: 'checkbox',
            className: 'dsn-check',
            checked: settings.badge,
            'aria-label': t.badgeLabel,
            onChange: (event) => settingsStore.set({ badge: event.target.checked }),
          }),
        ),
        h(
          'div',
          { className: 'dsn-settings-row' },
          h(
            'div',
            { className: 'dsn-settings-text' },
            h('div', { className: 'dsn-settings-label' }, t.widthLabel),
            h('div', { className: 'dsn-settings-hint' }, t.widthHint),
          ),
          h('input', {
            type: 'number',
            className: 'dsn-width',
            min: 240,
            max: 560,
            step: 20,
            value: settings.width,
            'aria-label': t.widthLabel,
            onChange: (event) => {
              const width = Number.parseInt(event.target.value, 10);
              // Empty or partial input stays put until it parses as a number;
              // readSettings clamps the stored value either way.
              if (Number.isFinite(width)) settingsStore.set({ width });
            },
          }),
        ),
        h(
          'div',
          { className: 'dsn-settings-row' },
          h(
            'div',
            { className: 'dsn-settings-text' },
            h('div', { className: 'dsn-settings-label' }, t.orderLabel),
            h('div', { className: 'dsn-settings-hint' }, t.orderHint),
          ),
          h(
            'div',
            { className: 'dsn-segment', role: 'group', 'aria-label': t.orderLabel },
            ...[
              ['newest', t.orderNewest],
              ['oldest', t.orderOldest],
            ].map(([value, label]) =>
              h(
                'button',
                {
                  key: value,
                  type: 'button',
                  className: 'dsn-seg',
                  'aria-pressed': settings.order === value,
                  onClick: () => settingsStore.set({ order: value }),
                },
                label,
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dsn-settings-row' },
          h(
            'div',
            { className: 'dsn-settings-text' },
            h('div', { className: 'dsn-settings-label' }, t.clearAll),
            h('div', { className: 'dsn-settings-hint' }, `${t.countLabel}: ${notes.length}`),
          ),
          confirming
            ? h(
                'div',
                { className: 'dsn-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsn-btn dsn-danger',
                    onClick: () => {
                      notesStore.clear();
                      setConfirming(false);
                    },
                  },
                  t.clearConfirm,
                ),
                h('button', { type: 'button', className: 'dsn-btn', onClick: () => setConfirming(false) }, t.close),
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: 'dsn-btn dsn-danger',
                  disabled: notes.length === 0,
                  onClick: () => setConfirming(true),
                },
                t.clearAll,
              ),
        ),
      );
    }

    // The sidebar list owns the button and passes its own props, not the page's.
    function NotesIcon({ size, active }) {
      const edge = size || 18;
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: edge,
          height: edge,
          'aria-hidden': true,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: { display: 'block' },
        },
        h('path', { d: 'M20 4H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h4l3 4 3-4h6a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1Z' }),
        h('path', { d: 'M8 9h8M8 12.5h5' }),
      );
    }

    const PANEL_ID = 'sticky-notes';

    return {
      inject: ['slots'],
      apply(ctx) {
        // This bundle is in the fatal boot set: a throw here stops the whole Web
        // UI from starting ("web boot: 1 entry did not activate"). A decorative
        // panel must degrade to "no notes tab", never to "no app".
        try {
          const locale = ctx.get('locale');
          ctx.effect(() => insertStyles(CSS), 'dsh-sticky-notes: styles');

          // The generator body runs later, when the slots service is ready, so
          // the outer guard cannot see a failure inside it. Each surface gets its
          // own guard.
          const register = (slot, options, component, label) =>
            ctx.slots.inject(slot, function* () {
              try {
                yield ctx.slots.register(options, component);
              } catch (error) {
                console.error(`dsh-sticky-notes: failed to register ${label}`, error);
              }
            });

          register('shell.overlay', { name: 'shell.overlay', id: PANEL_ID, order: 900 }, () => h(StickyNotes, { locale }), 'the overlay');
          // A thunk so the sidebar and settings labels follow a language change
          // without the entry being re-registered.
          const label = () => pickDict(localeTag(locale)).title;
          // The sidebar list resolves its own label from list metadata and
          // dispatches the main panel by the same id. It subscribes to entry
          // changes, so dropping the registration removes the button live — which
          // is the only way to hide it, since a component that renders null still
          // leaves an empty slot in the sidebar.
          ctx.slots.inject('sidebar.panellist', function* () {
            let stop = null;
            const sync = () => {
              const want = settingsStore.get().sidebar;
              if (want && !stop) {
                try {
                  stop = ctx.slots.register(
                    { name: 'sidebar.panellist', id: PANEL_ID, order: 60, label },
                    (props) => h(NotesIcon, { size: props && props.size, active: props && props.active }),
                  );
                } catch (error) {
                  stop = null;
                  console.error('dsh-sticky-notes: failed to register the sidebar entry', error);
                }
              } else if (!want && stop) {
                stop();
                stop = null;
              }
            };
            sync();
            const unsubscribe = settingsStore.subscribe(sync);
            yield () => {
              unsubscribe();
              if (stop) stop();
            };
          });
          register('main', { name: 'main', key: PANEL_ID }, () => h(NotesPage, { locale }), 'the page');
          register('settings.section', { name: 'settings.section', id: PANEL_ID, order: 70, label }, () => h(NotesSettings, { locale }), 'the settings page');
        } catch (error) {
          console.error('dsh-sticky-notes: failed to mount', error);
        }
      },
    };
  },
});
