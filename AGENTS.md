# AGENTS.md — pi-chafa-banner

给未来的 agent / 协作者看的项目手册。目标一句话：**把一张 GIF 用 chafa 渲染成
字符画，放进 pi 的启动 header —— 左上图片、左下 coding-agent 信息卡、右侧
resources 面板，随对话上滚，不干扰输入。**

改代码前先读「硬性不变式」——违反那条会直接破坏 pi 的渲染或用户终端。

---

## 1. 30 秒上手

```bash
cd ~/Work/Program/Project/pi-chafa-banner

bun install                     # 只有 typescript / @types/bun
bunx tsc --noEmit               # 类型检查（必须干净）
bun test                        # 全部用例必须绿（不写死数字，看输出）

# 不启动 pi，直接看排版（最快的调参回路）
bun run scripts/preview.ts --static --width 100
bun run scripts/preview.ts --width 60            # 堆叠布局
bun run scripts/preview.ts --static --chafa "--symbols block"

# 真机验证（交互式，需人工看）
pi -e .                         # 临时加载扩展，不动 settings
bash scripts/demo.sh --preview  # 同上，打印生效配置后再预览
```

**禁止**为了验证而写自动化脚本去启动交互式 pi（它会一直占住 TTY）。非交互冒烟只能：

```bash
pi --list-models --offline -e .
# 加载失败时 pi 仍返回 0，必须 grep 输出里的 "Failed to load extension"
```

## 2. 目录与职责（行号会漂，函数名为准）

```
src/index.ts              入口：pi.on 接线、/splash 注册、re-export
src/extension/state.ts    SessionState、`session.current`、errorText、contentSummary
src/extension/session.ts  bootstrap / buildContent / refreshResources / scheduleRebuild
src/extension/header.ts   installHeader（setHeader + 摘除 pi 的资源列表）/ restore / describeListing
src/extension/commands.ts USAGE、SUBCOMMANDS、handleSplashCommand
src/banner/component.ts   Banner 类：render / invalidate / dispose + 帧定时器
src/banner/panels.ts      infoRows / sections / 状态行 / 占位卡 / describeConfig
src/layout/box.ts         panel / infoBox / resourcePanel / wrapNames / distributeLines / themePainter
src/layout/compose.ts     twoColumn / centerBlock / clampLines / compactSplash
src/layout/metrics.ts     CHROME_ROWS / splashRows / blockWidthFor
src/text/ansi.ts          ANSI_RE / isImageLine / stripAnsi
src/text/width.ts         grapheme 与东亚宽度、visibleWidth、padVisible、centerVisible
src/text/truncate.ts      truncateToWidth / truncateEllipsis / sliceVisible
src/frames.ts             ffmpeg→chafa 帧管线、sanitizeFrame、磁盘缓存
src/pipeline/process.ts   run（无 tty、超时）/ preflight / gifHash / probeSourceSize
src/pipeline/timing.ts    每帧延时：probeGifTiming / aggregateDelays / thinDelays / describeTiming
src/pipeline/args.ts      image.chafa 的 splitArgs / sanitizeChafaArgs / parseChafaArgs / argsDigest
src/pipeline/cache.ts     cacheRoot / cacheFilePath / 原子写 / 单文件删除
src/config/schema.ts      类型、DEFAULT_FILE、LIMITS、parseSize、palette 常量
src/config/validate.ts    宽容解析：逐键警告，永不抛
src/config/load.ts        pluginRoot / configPath / loadConfig / applySourceSize / 测试缝
src/resources.ts          采集 version/model/theme/context/skills/themes/extensions
src/host.ts               从 pi 组件树里纯内存摘除 loadedResourcesContainer
```

关键锚点：`src/banner/component.ts` 的 `render` / `imageBudget` / `cropFrame` /
`frameDelay` / `scheduleTick` / `start` / `dispose`；`src/layout/metrics.ts splashRows`；
`src/layout/box.ts distributeLines`；`src/config/load.ts loadConfig`；`src/frames.ts loadFrames`；
`src/pipeline/timing.ts aggregateDelays`；`src/host.ts detachResourceListing`。

## 3. 硬性不变式

1. **每行宽度 ≤ width。** `render(width)` 每个字符串用 `visibleWidth()` 量必须 ≤ width；
   `src/text/width.ts` 必须与 `@earendil-works/pi-tui` 的 `visibleWidth` 逐字对齐
   （`test/text-parity.test.ts` 会拿真实实现对比）。
2. **一维字符串数组 = 一行。** 不许在元素里塞 `\n`；chafa 输出必须先 split。
3. **chafa 必须带 `--probe off` 和 `--animate off`。** 前者防止 chafa 等终端 DA 应答
   （最多 5s）并抢走 pi 的 stdin，后者保证一次一帧。`--symbols solid` 只输出前景色块，
   跨终端可对齐。**不要加 `--clear`**，它的 `ESC[2J/ESC[0H` 必须被 `stripChafaControl()`
   剥掉。用户在 `image.chafa` 里写这三个参数会被 `sanitizeChafaArgs()` 丢弃。
4. **`render()` 是同步的。** 所有帧必须预渲染并缓存在内存/磁盘，绝不在这里 spawn。
5. **组件只做三件事：`render` / `invalidate` / `dispose`。** 不实现 `handleInput` /
   `handleMouse`，不抢焦点、不做浮层——splash 必须是文档流里的一行才能随对话滚走。
6. **定时器必须 `unref()` 且在 `dispose()` 里清掉**，`/splash off`、`session_shutdown`、
   agent 流式输出期间（`agent_start` pause / `agent_end` resume）都要停。
7. **不得写 `~/.pi/agent/settings.json`**，也不得改 pi 的 dist。配置只走
   `pi-chafa-banner.json` + `/splash` 命令。
7b. **对宿主组件树的改动必须是纯内存、可逆、可降级。** 目前只有 `src/host.ts` 摘除
   `loadedResourcesContainer` 一例：位置假设是 `headerContainer` 之后紧跟 list 容器，
   只认 duck-typed 容器（`children` + `removeChild`），失配就静默返回 undefined；
   `/splash off` 必须 `restore()` 插回原索引。不要在 `render` 期间改树（用
   `queueMicrotask`），不要写盘、不要打补丁。
8. **所有写盘只在** `~/.pi/agent/tmp/pi-chafa-banner/<sha1>/`（跟随
   `PI_CODING_AGENT_DIR`）。临时目录用显式路径清理，禁止通配符删除。
9. **降级优先于报错。** 缺 chafa/ffmpeg、gif 不存在、缓存损坏、终端过窄，都要回退到
   占位卡 / 紧凑文本 / 内置 header，并且只提示一次。
10. **图片只在左列顶部、信息卡在它下面。** 图片宽度决定左列宽度，右侧 resources 与
    左列底部对齐；这是「左上图片、左下 coding、右 resources」的唯一布局，不要改成
    整条图带或把面板塞到图片右边（pi 的 `visibleWidth` 记账、用户的截图都按这个来）。
11. **矮终端裁图片，不裁信息卡。** `imageBudget()` 从顶部裁剪字符画（`cropFrame`），
    保证信息卡 + 状态行 + 堆叠面板始终完整；`IMAGE` 占位卡只用于「还没有图」
    （构建中 / 构建失败 / 无图）。
12. **帧的时间来自 GIF，不来自 fps。** `image.fps: "auto"`（默认）时用
    `frames.delays[]`，`stride` 丢掉的帧时长要累加给保留帧（`aggregateDelays`），
    这样一圈总时长不变；写数字才覆盖成固定帧率。

## 4. 帧管线（改渲染相关必读）

```
assets/banner.gif（或 image.path）
  → sha1(path + mtimeMs + size)                   缓存命名与失效依据
  → ffprobe pts_time + format=duration            每帧延迟
  → ffmpeg -vsync 0 <cache>/work-*/f%03d.png      抽帧（最多 MAX_GIF_FRAMES=240）
  → 每 image.stride 取一帧，被丢帧时长并给保留帧
  → chafa -f symbols --symbols solid --probe off --animate off -c full|256 \
          <image.chafa> -s WxH
  → stripChafaControl + sanitizeFrame(rows=H, cols=W)
  → <cache>/<hash>/frames-<WxH>-<color>[-<argsDigest>].json
```

- 缓存带 `CACHE_VERSION`；**改 JSON 结构就要 +1**，否则老缓存会被误判有效。
- 色深来自 `theme.getColorMode()`：`truecolor → -c full`、`256color → -c 256`。
- `image.chafa` 同时进缓存文件名（8 位 digest）与 payload，两套配置不会串图。
- 冷启动约 300–500ms，异步进行；构建期间 header 显示占位卡。

## 5. 数据来源（右侧面板）

| 区块 | 来源 | 备注 |
| --- | --- | --- |
| Context | `scanContextFiles()`：`AGENTS.override.md/AGENTS.md/AGENTS.MD/CLAUDE.md/CLAUDE.MD`（cwd 及祖先、agentDir）、`APPEND_SYSTEM.md`（`<cwd>/.pi/`、agentDir） | 无公开 API，只能扫盘 |
| Skills | `pi.getCommands()` 里 `name` 以 `skill:` 开头；首轮后用 `before_agent_start` 的 `event.systemPromptOptions.skills` 补全 | 首轮前可能不全 |
| Themes | `ctx.ui.getAllThemes()` | |
| Extensions | `pi.getCommands()` 的 `source:"extension"` + `settings.extensions` + `settings.packages` + `~/.pi/agent/extensions/*` | 无命令的扩展可能漏 |
| version/model/theme | pi 包版本探测、`ctx.model.{provider,id}`、`pi.getSettings().theme` | |

采集整体 `try/catch`，任何一块失败只影响该区块。

## 6. 尺寸与布局阈值

- 块宽 `blockWidthFor(cols, layout)`：`ceiling = min(layout.maxWidth, layout.width)`（默认 88、上限 108）；
  `cols >= ceiling` 时直接取 `ceiling`（画布因此逐列对齐），否则取 `max(20, cols-4)` 留 4 列余量。
- 两列恒等宽：`column = columnWidthFor(block, layout.gap) = floor((block - gap) / 2)`，
  左右都用 `column`；chafa 画布就是 `column × autoHeightFor(column)`（高度再按 gif
  宽高比重算），所以**图片尺寸没有任何配置项，全由 `layout.width`/`gap` 推导**。
- 双列条件：`block >= layout.twoColumnMinWidth`（默认 76）且 `column >= MIN_PANEL_WIDTH`（28）。
- 低于 `layout.compactMinWidth`（32）退化成 3 行 `compactSplash()`。
- 可用行数 `splashRows(rows) = max(10, rows - CHROME_ROWS)`，`CHROME_ROWS = 7`
  （editor 3 + footer 2 + header 上下各一个 Spacer）。`imageBudget()` 从这份预算里
  先扣 info 卡（`INFO_BOX_ROWS=5` + 1 空行）、状态行、堆叠面板，剩下的给图片。
- 回归方式：`preview --rows 18|24|30|40|50` 目视 + `bun test` 的宽度契约用例。

## 7. 配置与命令

`pi-chafa-banner.json` 放在**扩展旁边**（`configPath(pluginRoot())`）：全局安装是
`~/.pi/agent/pi-chafa-banner.json`，项目安装是 `<project>/.pi/pi-chafa-banner.json`。

| 组 | 键（默认） |
| --- | --- |
| image | `path`（`~/Pictures/logo/v-3.gif` → 包内图）、`fps` `"auto"`、`stride` 3、`chafa` `""` |
| layout | `width` 88、`gap` 2、`twoColumnMinWidth` 76、`compactMinWidth` 32、`maxWidth` 108、`lowerRows` 12 |
| panels.info | `enabled` true、`fields` `["version","model","theme"]`（可选 `gif`/`frames`） |
| panels.resources | `enabled` true、`sections` 全部、`maxLinesPerSection` 6（`width`/`height` 仅堆叠时用） |
| behavior | `enabled` true、`static` false、`hidePiResourceList` true |

宽容策略：缺文件/缺键 → 默认值；类型或枚举错 → 默认值 + `source.warnings`；
数值越界 → clamp + 警告；未知键静默忽略。`/splash status` 打印生效配置、缓存、
工具检测与全部警告。

命令：`/splash on|off|freeze|rebuild|reload|status`。`off` 用
`ctx.ui.setHeader(undefined)` 恢复内置 header 并 `restore()` pi 的资源列表。

## 8. 已知问题 / 路线图

1. **kitty 原生图片已归档**：`archive/kitty-native-images` 分支（父提交 `ede1a32`）。
   当时已实现：`planImageBand()` 裁剪 + `cropKittyRoot()` 改写根帧、`syncTerminalShape()`
   换新 imageId 重传、`releaseImage()`/`encodeKittyDelete()` 拆卸删除，并在真机 pty 上
   验证过（88x24 → `x=0,y=90,w=396,h=90,c=44,r=5`；shutdown `d=I`）。放弃原因：
   pi 主屏 `tui-main-screen.js getKittyImageReservedRows()` 遇到非空单元格即停止计数，
   图片右侧不可能放文字，因此两种模式风格无法统一；且 resize 后轻微遮挡会导致图片
   被删且不再放回。**主分支不要再引入 `\x1b_G`。**
2. **重复列表**：pi 内置的 `[Context]/[Skills]/[Extensions]` 由 `src/host.ts` 在挂载时
   从 `tui` 组件树摘掉（纯内存、`/splash off` 插回、失配静默降级）；`/splash status`
   报 `listing hidden|visible`。兜底是用户自己设 `"quietStartup": true`。
3. **矮终端**：splash 只能用「文档视口」= `rows - CHROME_ROWS`。当前策略是裁字符画、
   保信息卡；改尺寸逻辑时用 `preview --rows 18|20|24|30|40|50` 回归。
4. **`types/pi-host.d.ts`** 是手写 shim（`TUI.mode` 的真实值是 `"regular"`）。
   改扩展 API 用法时对照 `pi-coding-agent` 的 `dist/**/*.d.ts`。
5. **动画开销**：字符画约 21KB/帧、`fps` 按 GIF 原生（示例 8 帧 2.4s）。长会话、
   全屏模式、慢终端下建议 `behavior.static: true` 或调大 `stride`。
6. **`fps` 写死数字会加速**：`stride` 丢掉帧后固定 fps 不等于原速，这正是默认
   `"auto"` 的原因。
7. **缓存目录会积累**：每次改 gif / 尺寸 / chafa 参数都会产生新 `<sha1>` 目录，
   旧目录不自动清理（禁止批量删除，需要时手动删具体路径）。

## 9. 常见改法

- **换默认图**：改 `~/Pictures/logo/v-3.gif` 的内容，或设 `image.path`，或覆盖
  `assets/banner.gif`（缓存按 mtime 失效，无需清缓存）。
- **换画布尺寸/宽高比**：改 `layout.width`（两列与画布一起变，高度按 gif 宽高比
  自动推算，下限 4 行、上限 60 行）；然后确认 `INFO_BOX_ROWS` 是否仍成立。
- **改边框/配色**：只动 `src/layout/box.ts` 的 `THIN_BOX` 与 `themePainter()` 的
  token 映射；不要硬编码 RGB，主题切换要跟着变。
- **加资源区块**：`src/banner/panels.ts sections()` + `src/resources.ts collectResources()`
  + `src/config/schema.ts` 的 `RESOURCE_SECTIONS`；`distributeLines()` 负责高度分配。
- **改动画节奏**：`src/banner/component.ts` 的 `frameDelay()`/`scheduleTick()`、
  `src/frames.ts` 的 stride 与 `src/pipeline/timing.ts` 的聚合；保持 `unref()` 与
  暂停/恢复逻辑。
- **调性能**：`image.stride`（少渲染）、`layout.width`（小画布）、
  `image.chafa`（例如 `--symbols block` 让每格用一个全块字符）。

## 10. 外部参考

- `https://github.com/danielmrdev/beautiful-pi` —— 同为 setHeader splash、
  `╭─ RESOURCES ─╮` 面板的画法（灵感，无代码）。
- pi 文档：`/usr/lib/node_modules/pi/packages/coding-agent/docs/{extensions,tui,packages,cli}.md`；
  组件契约看 `packages/tui/dist/tui.d.ts`。
