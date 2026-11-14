# AGENTS.md — pi-chafa-banner

给未来的 agent / 协作者看的项目手册。目标只有一句话：**把一张 GIF 用 chafa 渲染成终端字符画，放进 pi 的启动 header（顶部、随对话上滚、不干扰输入），左边图、右边 Context/Skills/Themes/Extensions。**

改代码前先读「硬性不变式」一节——违反那几条会直接破坏 pi 的渲染或用户终端。

---

## 1. 30 秒上手

```bash
cd ~/Work/Program/Project/pi-chafa-banner

bun install                     # 只有 typescript / @types/bun 两个 dev 依赖
bunx tsc --noEmit               # 类型检查（必须干净）
bun test                        # 145 个用例，必须全绿

# 不启动 pi，直接看排版（最快的调参回路）
bun run scripts/preview.ts --static --width 100
bun run scripts/preview.ts --width 60      # 堆叠布局
bun run scripts/preview.ts --size 60x30 --no-frames

# 真机验证（交互式，需人工看）
pi -e .                         # 临时加载扩展，不动 settings
bash scripts/demo.sh --static   # 同上 + 打印生效 env
```

**禁止**为了验证去启动交互式 pi 的自动化脚本：它会一直占住 TTY。非交互冒烟只能这样：

```bash
pi --list-models --offline -e .
# 注意：加载失败时 pi 仍返回 0，必须 grep 输出里的 "Failed to load extension"
```

## 2. 目录与职责（行号会漂，函数名为准）

```
src/index.ts      扩展入口：session_start 装 header、/splash 命令、事件接线、降级策略
src/banner.ts     Banner 组件：render(width) 合成整个 splash、动画定时器、pending 占位
src/layout.ts     纯排版函数：panel / infoBox / resourcePanel / twoColumn / centerBlock / compactSplash
src/text.ts       ANSI 感知的 visibleWidth / truncateToWidth（必须与 pi-tui 完全一致）
src/frames.ts     ffmpeg→chafa 帧管线、ANSI 清洗、磁盘缓存、preflight
src/resources.ts  采集 version/model/theme/context/skills/themes/extensions
src/config.ts     env 解析、默认值、limits、默认 gif 解析（含包内 assets）
assets/banner.gif 随包分发的默认图（源自 ~/Pictures/logo/v-1.gif）
scripts/preview.ts 无 pi 的预览器（唯一安全的排版调试入口）
scripts/demo.sh 用户级启动脚本（打印 env 后 exec pi -e .）
test/ tests/     bun test 用例（两个目录并存，见「已知问题」）
types/pi-host.d.ts  手写的 pi 宿主类型 shim（可能滞后于真实 API）
```

关键锚点：`src/config.ts:105 defaultGifPath`、`src/frames.ts:305 loadFrames`、`src/frames.ts:260 sanitizeFrame`、`src/layout.ts:269 twoColumn`、`src/layout.ts:282 centerBlock`、`src/banner.ts:212 render`、`src/banner.ts:145 start`、`src/index.ts:86 installHeader`、`src/index.ts:71 resolveRenderer`。

## 3. 硬性不变式（改任何东西都要守住）

1. **每行宽度 ≤ width。** `render(width)` 返回的每个字符串，用 `visibleWidth()` 量必须 ≤ width。pi 的 renderer 假定这一点；超宽会串行、把编辑器顶乱。`src/text.ts` 必须与 `@earendil-works/pi-tui` 的 `visibleWidth` 逐字对齐（含 East Asian Width、RGI emoji、VS16、ZWJ），改宽度表要同时在 `bun test` 里对比 pi-tui 的真实实现。
2. **一维字符串数组 = 一行。** 不许在单个元素里塞 `\n`；chafa 输出必须先 split。
3. **chafa 参数不能省 `--probe off`。** 否则 chafa 等终端 DA 应答最多 5s，并抢走 pi 的 stdin；`--animate off` 保证每次只出一帧；`--symbols solid` 只输出前景色块，不画背景（跨终端可对齐）。**不要加 `--clear`**，它产生的 `ESC[2J/ESC[0H` 必须被 `stripChafaControl()` 剥掉。
4. **`render()` 是同步的。** 所有帧必须预渲染并缓存在内存/磁盘，绝不在这里 spawn chafa。
5. **组件只做三件事：`render` / `invalidate` / `dispose`。** 不要实现 `handleInput`/`handleMouse`，不要抢焦点，不要做浮层——splash 必须是文档流里的一行，才能随对话滚走（pi 把 header 放在 `documentContainer` 里，位于 chat 之前）。
6. **定时器必须 `unref()` 且在 `dispose()` 里清掉**，还要在 `/splash off`、`session_shutdown`、会话切换时停。流式输出期间暂停（`agent_start` → pause，`agent_end` → resume）。
7. **不得写用户的 `~/.pi/agent/settings.json`**，也不得改 pi 的 dist。配置只走 `PI_BANNER_*` 环境变量 + `/splash` 命令。
8. **所有写盘只在** `~/.pi/agent/tmp/pi-chafa-banner/<sha1>/`（`PI_CODING_AGENT_DIR` 覆盖时跟随）。临时目录用显式路径清理，禁止通配符删除。
9. **降级优先于报错。** 缺 chafa/ffmpeg、gif 不存在、缓存损坏、终端过窄，都要回退到占位卡片 / 紧凑文本 / 内置 header，并只提示一次。

## 4. 帧管线（改渲染相关必读）

```
assets/banner.gif（或 PI_BANNER_GIF）
  → sha1(path + mtimeMs + size)                    缓存命名与失效依据
  → ffmpeg -i gif -vsync 0 <tmp>/f%03d.png         抽帧（最多 MAX_GIF_FRAMES=240）
  → chafa -f symbols --symbols solid --probe off --animate off -c full|256 -s WxH
  → stripChafaControl + sanitizeFrame(rows=H, cols=W)
  → <cacheRoot>/<hash>/frames-<WxH>-<colorMode>.json
```

- 缓存带 `CACHE_VERSION`；**改 JSON 结构就要 +1**，否则老缓存会被误判为有效。
- 色深来自 `theme.getColorMode()`：`truecolor → -c full`、`256color → -c 256`。
- 抽帧后按 `PI_BANNER_STRIDE`（默认 3）取样：57 帧 → 19 帧，16fps ≈ 原速 1.14s 循环。
- 冷启动约 300–500ms，异步进行；构建期间 header 显示占位卡片（`Banner.setFrames(undefined)` 状态）。

## 5. 数据来源（右侧面板）

| 区块 | 来源 | 备注 |
| --- | --- | --- |
| Context | `scanContextFiles()`：`AGENTS.override.md/AGENTS.md/AGENTS.MD/CLAUDE.md/CLAUDE.MD`（cwd 及祖先、agentDir）、`APPEND_SYSTEM.md`（`<cwd>/.pi/`、agentDir） | 无公开 API，只能扫盘 |
| Skills | `pi.getCommands()` 里 `name` 以 `skill:` 开头（`sourceInfo.path`），首轮后再用 `before_agent_start` 的 `event.systemPromptOptions.skills` 补全 | 首轮前可能不全 |
| Themes | `ctx.ui.getAllThemes()` | |
| Extensions | `pi.getCommands()` 的 `source:"extension"` + `settings.extensions` + `settings.packages` + `~/.pi/agent/extensions/*` | 无命令的扩展可能漏 |
| version/model/theme | pi 包版本探测、`ctx.model.{provider,id}`、`pi.getSettings().theme` | |

采集整体 `try/catch`，任何一块失败只影响该区块。

## 6. 尺寸与布局阈值

- 块宽 `min(terminalCols - 4, 108)`；≥76 列双列（左图 + 右侧资源面板），44 列图 + 4 列 gap。
- <76 列：上下堆叠（图 → 信息卡 → 资源面板），各自独立居中。
- <32 列：退化为 3 行文本 `compactSplash()`。
- 矮终端会从顶部裁剪图片行（`MIN_CROP_ROWS=10`）；`IMAGE unavailable` 卡片固定 5 行信息框。

## 7. 配置与命令

| env | 默认 | 说明 |
| --- | --- | --- |
| `PI_BANNER_GIF` | 包内 `assets/banner.gif` → `~/.pi/agent/banner.gif` → `~/Pictures/logo/v-1.gif` | 显式值即使不存在也优先（报错比换图好） |
| `PI_BANNER_SIZE` | `44x22` | 8–160 × 4–60 |
| `PI_BANNER_FPS` | `16` | 1–30 |
| `PI_BANNER_STRIDE` | `3` | 1–10 |
| `PI_BANNER_RENDERER` | `auto` | `auto/chars/kitty`；`kitty` 目前检测后回退 `chars` |
| `PI_BANNER_STATIC` / `PI_BANNER_DISABLED` | off | 单帧 / 完全不装 header |

`/splash on|off|freeze|rebuild|size <WxH>|status`。`off` 时用 `ctx.ui.setHeader(undefined)` 恢复内置 header。

## 8. 已知问题 / 路线图

1. **kitty 原生图像未实现**（PARTIAL）：`PI_BANNER_RENDERER=kitty` 只做检测与回退。接入点：`resolveRenderer()` + `Banner.render()` 里把某一帧替换为图像传输序列。难点是 kitty 图形是多行、无字符宽度，会破坏「一行一个字符串」的假设，需要单独的一行占位（每行返回空串或空格，再由上行传输），并与 pi 的差分渲染协调。参考 `pi-tui` 的 `Image` 组件协议。
2. **重复列表**：pi 内置的 `[Skills]/[Extensions]` 仍会显示在 splash 下方。彻底去重只能让用户设 `"quietStartup": true`（扩展无权改 settings）；或做 dist patch 把 `showLoadedResources` 短路（见历史方案，需 sudo）。
3. **矮终端裁剪**：块高固定 `图 + 1 + 5`，`MIN_TERMINAL_ROWS=24` 的判断曾与真实块高不一致；调整尺寸逻辑时同时用 `--rows 20` 验证。
4. **`test/` 与 `tests/` 并存**，`tests/*.test.ts` 与 `test/*.test.ts` 有重叠用例，`tsconfig.json` 的 `include` 只覆盖 `test`。清理前要征得用户同意（禁止批量删除）。
5. **`types/pi-host.d.ts`** 是手写 shim，`TUI.mode` 曾写成 `"inline"` 而真实值是 `"regular"`。改扩展 API 用法时对照 `dist/**/*.d.ts`。
6. **动画开销**：21KB/帧 × 16fps ≈ 340KB/s；长会话、全屏模式、慢终端下建议降 fps/stride 或 `PI_BANNER_STATIC=1`。

## 9. 常见改法

- **换默认图**：覆盖 `assets/banner.gif`（保持文件名），或改 `config.ts` 的 `BUNDLED_GIF_PATH`。缓存按 mtime 失效，无需清缓存。
- **换画布尺寸/宽高比**：改 `DEFAULTS.size`，并在 `banner.ts` 检查左边列宽与 `INFO_BOX_ROWS` 是否仍成立。
- **改边框/配色**：只动 `layout.ts` 的 `THIN_BOX` 与 `themePainter()` 的 token 映射；不要硬编码 RGB，主题切换要跟着变。
- **加资源区块**：`layout.ts resourcePanel()` 的 sections + `resources.ts collectResources()` + `banner.ts` 的 info 行预算；`distributeLines()` 负责各行高度分配。
- **改动画节奏**：`banner.ts start()` 的 interval、`frames.ts` 的 stride；保持 `unref()` 与暂停/恢复逻辑。

## 10. 外部参考

- `https://github.com/danielmrdev/beautiful-pi` —— 同为 setHeader splash，双栏 + `╭─ RESOURCES ─╮` 面板的画法。
- `https://github.com/mavam/pi-splash` —— 滚动行为（header 属于文档流）、`unref()` 定时器、窄终端处理。
- pi 文档：`/usr/lib/node_modules/pi/packages/coding-agent/docs/{extensions,tui,packages,cli}.md`；组件契约看 `packages/tui/dist/tui.d.ts`。
