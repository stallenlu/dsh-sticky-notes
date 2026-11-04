# dsh-sticky-notes

DSH（DeepSeek Harness）桌面端的便签插件：一个可拖动的浮动便签窗，外加侧边栏完整页面、Markdown 预览和设置项。数据存于浏览器 `localStorage`，纯前端实现，无 Host 侧逻辑。

## 功能

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

## 设置项

| 设置 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| 浮动面板 | 开关 | 开 | 是否显示屏幕右侧的浮动标签 |
| 侧边栏入口 | 开关 | 开 | 是否在左侧边栏显示便签图标（设置页始终可达） |
| Markdown 预览 | 开关 | 开 | 关闭后所有便签退回纯文本编辑框 |
| 计数徽章 | 开关 | 开 | 浮动标签上的便签数量 |
| 面板宽度 | 数字 | 320 | 240–560 像素，越界自动收拢 |
| 便签排序 | 下拉 | 最新的在前 | `最新的在前` / `最旧的在前`，浮窗与页面共享 |
| 删除全部便签 | 按钮 | — | 需二次确认 |

## 存储与限制

| 键 | 内容 |
| --- | --- |
| `dsh-sticky-notes:v1` | 便签列表（`[{id, text, images, updatedAt}]`） |
| `dsh-sticky-notes:settings` | 设置项 |
| `dsh-sticky-notes:pos` | 浮窗位置 |

图片限制：每条便签最多 8 张，单张 ≤700KB（data URL，最坏总量约 5.6MB）；读取时清洗非 `data:image/` 的值并截断到 8 张。数据不跨设备同步。

## 架构

```
┌─ package.json        dsh.client = { platform: "web", inject: [] }
├─ cordis.patch.yml    - insert:  id: ui-sticky-notes
├─ index.js            Host 半面（空实现，数据全在浏览器端）
├─ client.js           Client 半面（window.__ModuleLoader__ 静态 bundle）
├─ locale/{en,zh}.json 展示元数据（meta.title / meta.description）
├─ icon.svg            插件图标
└─ smoke.mjs           冒烟测试（147 条断言，零依赖，node smoke.mjs 直跑）
```

Client 半面注册三个 slot：

- `shell.overlay` — 浮动标签 + 面板（order 900）
- `sidebar.panellist` — 侧边栏图标（order 60，按设置注册/注销）
- `main` — 完整页面
- `settings.section` — 设置区

关键实现约束（静态 bundle 与动态 runner 的差异，详见 MEMORY）：

- 工厂只收到 `require`，没有 `styles`/`host`/`harness` 参数 —— 样式自建 `<style>` 元素插入 `document.head`。
- 样式只用 `--dsw-alias-*` 主题 token，不写死颜色。
- `apply()` 整体与生成器内 `slots.register` 都包 try/catch —— boot 期每个 manifest 插件都会被宿主审计，一条未 active 就会让整个 Web UI 拒绝启动，装饰性组件必须降级为「不显示」而不是「崩宿主」。
- `MarkdownText` 来自平台 seed 表 `require('@deepseek-ai/dsh-client-ui-primitives')`，取不到时优雅退回纯文本。

## 开发

```bash
node smoke.mjs        # 147 条断言；stderr 里的 guard 日志是预期输出
node --check client.js
```

反向对照（验证断言有约束力）：临时删掉 `client.js` 中某段逻辑（如 `|| n.images.length > 0`、`.slice(0, MAX_IMAGES)`、`dsn-hint` 渲染行），对应断言应失败；测完恢复。

## 安装

本包以 symlink 方式装入 profile（`link:` 依赖），改代码即时生效，但 loader roster 在进程启动时构建——改完代码后刷新页面即可，改 manifest（package.json / cordis.patch.yml）才需要重启 DSH。

`plugin_manager` 操作注意：`set_bundle` 在 HMR 事务嵌套时会报 `HMR transactions cannot be nested`，此时直接编辑 `$DSH_PROFILE_DIR/package.json` 的 `dsh.profile.bundles` 数组即可。
