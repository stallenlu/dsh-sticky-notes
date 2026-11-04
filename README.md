# dsh-sticky-notes

[English](#english) | [中文](#中文)

<!-- badges -->
| | |
| --- | --- |
| **version** | `1.0.0` |
| **DSH** | `>= 0.2.0-rc.1`（在 0.2.1-rc.5 桌面版开发与实测） |
| **license** | [MIT](LICENSE) |
| **Node** | `>= 22`（仅运行冒烟测试需要） |

<a id="english"></a>
## English

**dsh-sticky-notes** is a sticky-notes plugin for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH): a draggable floating panel beside the conversation, a full page in the sidebar, Markdown preview, image paste, and settings. All data lives in the browser's `localStorage`; there is no host-side logic.

### Features

| Feature | Description |
| --- | --- |
| Floating panel | A tab on the right edge of the screen with a note-count badge; the panel opens on click, its title bar drags, and the position persists (re-clamped to the viewport on smaller screens) |
| Full page | A sidebar icon opens the full page; it shares the same data as the floating panel, and edits sync instantly in both directions |
| Settings | Both the panel (⚙) and the page carry a settings area with 7 options (below) |
| Markdown preview | Notes render through the host's `MarkdownText`; click a rendered note to edit it as plain text, blur to return to preview |
| Paste images | Ctrl+V an image into a note to attach it; each thumbnail has its own × remove button |
| Bilingual | Follows the host locale service; falls back to the browser language, so Chinese users see Chinese even when the host locale service is unavailable |
| Cross-window sync | Notes and settings both listen to the `storage` event, so every window stays in step |
| Data robustness | Corrupted storage is never overwritten (a warning shows; the write-back is authorized only by a real edit); failed writes show a "kept only until you close this page" warning |

### Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| Floating panel | switch | on | Whether the floating tab shows on the right edge |
| Sidebar entry | switch | on | Whether the notes icon shows in the left sidebar (the settings page stays reachable either way) |
| Markdown preview | switch | on | Off = every note is a plain text field |
| Count badge | switch | on | The number on the floating tab |
| Panel width | number | 320 | 240–560 pixels, clamped |
| Note order | select | newest first | `Newest first` / `Oldest first`, shared by panel and page |
| Delete all notes | button | — | Requires an explicit confirmation |

### Storage and limits

| Key | Content |
| --- | --- |
| `dsh-sticky-notes:v1` | Note list (`[{id, text, images, updatedAt}]`) |
| `dsh-sticky-notes:settings` | Settings |
| `dsh-sticky-notes:pos` | Floating-panel position |

Image limits: at most 8 images per note, each ≤700KB (data URLs; worst case ≈5.6MB per note). On read, values that are not `data:image/` are dropped and the list is capped at 8. Data does not sync across devices.

### Install

Copy or clone this package anywhere, then add it to a DSH profile, e.g. in `$DSH_PROFILE_DIR/package.json`:

```json
{
  "dependencies": {
    "dsh-sticky-notes": "link:C:/path/to/dsh-sticky-notes"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-sticky-notes"]
    }
  }
}
```

The bundle's own `cordis.patch.yml` inserts the plugin row (`ui-sticky-notes`); no profile patch edit is needed. A `link:` dependency is a symlink, so code changes take effect after a page refresh; manifest changes (`package.json` / `cordis.patch.yml`) need a DSH restart.

### Development

```bash
node smoke.mjs        # 147 assertions; the guard lines on stderr are expected
node --check client.js
```

Negative controls (to prove the assertions bite): temporarily remove a piece of logic in `client.js` (e.g. the `|| n.images.length > 0` persistence condition, the `.slice(0, MAX_IMAGES)` read cap, or the `.dsn-hint` render line) — the matching assertion must fail; then restore.

### Implementation notes

- Client halves of static boot bundles receive only `require` in their factory — `styles`/`host`/`harness` do not exist there. Styles are installed by hand as a `<style>` element appended to `document.head`.
- All colors go through `--dsw-alias-*` theme tokens; no literal colors in CSS.
- `apply()` and the inner `slots.register` are both wrapped in try/catch: during boot the host audits every manifest plugin, and one non-active entry blocks the whole Web UI. A decorative panel must degrade to "not shown", never to "no app".
- `MarkdownText` comes from the platform seed table via `require('@deepseek-ai/dsh-client-ui-primitives')`; when unavailable the note degrades to plain text.

### Architecture

```
├─ package.json        dsh.client = { platform: "web", inject: [] }
├─ cordis.patch.yml    - insert:  id: ui-sticky-notes
├─ index.js            Host half (empty; all data is browser-side)
├─ client.js           Client half (window.__ModuleLoader__ static bundle)
├─ locale/{en,zh}.json Display metadata (meta.title / meta.description)
├─ icon.svg            Plugin icon
└─ smoke.mjs           Smoke test (147 assertions, zero deps, run with node)
```

Client-half slots: `shell.overlay` (floating tab + panel, order 900), `sidebar.panellist` (sidebar icon, order 60, registered/unregistered per setting), `main` (full page), `settings.section` (settings area).

<a id="中文"></a>
## 中文

**dsh-sticky-notes** 是 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的便签插件：对话旁一个可拖动的浮动便签窗，外加侧边栏完整页面、Markdown 预览、粘贴图片和设置项。数据全部存在浏览器 `localStorage`，无 Host 侧逻辑。

### 功能

| 功能 | 说明 |
| --- | --- |
| 浮动便签窗 | 屏幕右侧中部悬浮标签，显示便签计数徽章；点击展开面板，标题栏可拖动，位置持久化（换分辨率后自动收回视口内） |
| 完整页面 | 左侧边栏便签图标进入完整页面，与浮窗共享同一份数据，改一处另一处即时同步 |
| 设置页 | 浮窗 ⚙ 与完整页面均有设置区，共 7 项（见下） |
| Markdown 预览 | 使用宿主 `MarkdownText` 渲染；点击预览区切回纯文本编辑，失焦后回到预览 |
| 粘贴图片 | 在便签文本框内 Ctrl+V 粘贴图片即附加；缩略图右上角 × 单独移除 |
| 双语 | 跟随宿主语言服务；宿主未提供时回退浏览器语言，中文环境显示中文 |
| 跨窗口同步 | 便签与设置都监听 `storage` 事件，多窗口各视图实时一致 |
| 数据健壮性 | 存储损坏不覆盖原数据（给出警示，用户编辑后才授权写回）；写失败显示「仅保留到关闭页面」警告 |

### 设置项

| 设置 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| 浮动面板 | 开关 | 开 | 是否显示屏幕右侧的浮动标签 |
| 侧边栏入口 | 开关 | 开 | 是否在左侧边栏显示便签图标（设置页始终可达） |
| Markdown 预览 | 开关 | 开 | 关闭后所有便签退回纯文本编辑框 |
| 计数徽章 | 开关 | 开 | 浮动标签上的便签数量 |
| 面板宽度 | 数字 | 320 | 240–560 像素，越界自动收拢 |
| 便签排序 | 下拉 | 最新的在前 | `最新的在前` / `最旧的在前`，浮窗与页面共享 |
| 删除全部便签 | 按钮 | — | 需二次确认 |

### 存储与限制

| 键 | 内容 |
| --- | --- |
| `dsh-sticky-notes:v1` | 便签列表（`[{id, text, images, updatedAt}]`） |
| `dsh-sticky-notes:settings` | 设置项 |
| `dsh-sticky-notes:pos` | 浮窗位置 |

图片限制：每条便签最多 8 张，单张 ≤700KB（data URL，最坏总量约 5.6MB）；读取时清洗非 `data:image/` 的值并截断到 8 张。数据不跨设备同步。

### 安装

把本包克隆或复制到任意位置，然后加入 DSH profile，例如在 `$DSH_PROFILE_DIR/package.json`：

```json
{
  "dependencies": {
    "dsh-sticky-notes": "link:C:/path/to/dsh-sticky-notes"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-sticky-notes"]
    }
  }
}
```

bundle 自带的 `cordis.patch.yml` 会插入插件行（`ui-sticky-notes`），无需改 profile 的 patch 文件。`link:` 依赖是符号链接，改代码刷新页面即生效；改 manifest（`package.json` / `cordis.patch.yml`）才需要重启 DSH。

### 开发

```bash
node smoke.mjs        # 147 条断言；stderr 里的 guard 日志是预期输出
node --check client.js
```

反向对照（验证断言有约束力）：临时删掉 `client.js` 中某段逻辑（如 `|| n.images.length > 0`、`.slice(0, MAX_IMAGES)`、`.dsn-hint` 渲染行），对应断言应失败；测完恢复。

### 实现要点

- 静态 boot bundle 的 client 半面工厂只收到 `require`——`styles`/`host`/`harness` 在这里不存在。样式自建 `<style>` 元素插入 `document.head`。
- 颜色全部走 `--dsw-alias-*` 主题 token，CSS 不写死颜色。
- `apply()` 整体与生成器内 `slots.register` 都包 try/catch：boot 期宿主会审计每个 manifest 插件，一条未 active 就让整个 Web UI 拒绝启动。装饰性组件必须降级为「不显示」，而不是「崩宿主」。
- `MarkdownText` 来自平台 seed 表 `require('@deepseek-ai/dsh-client-ui-primitives')`，取不到时优雅退回纯文本。

### 架构

```
├─ package.json        dsh.client = { platform: "web", inject: [] }
├─ cordis.patch.yml    - insert:  id: ui-sticky-notes
├─ index.js            Host 半面（空实现，数据全在浏览器端）
├─ client.js           Client 半面（window.__ModuleLoader__ 静态 bundle）
├─ locale/{en,zh}.json 展示元数据（meta.title / meta.description）
├─ icon.svg            插件图标
└─ smoke.mjs           冒烟测试（147 条断言，零依赖，node 直跑）
```

Client 半面注册的 slot：`shell.overlay`（浮动标签 + 面板，order 900）、`sidebar.panellist`（侧边栏图标，order 60，按设置注册/注销）、`main`（完整页面）、`settings.section`（设置区）。

## License

[MIT](LICENSE)
