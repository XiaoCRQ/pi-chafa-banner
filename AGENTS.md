# AGENTS.md — pi-chafa-banner

给未来的 agent / 协作者看的项目手册。目标只有一句话：**把一张 GIF 用 chafa 渲染成终端字符画，放进 pi 的启动 header（顶部、随对话上滚、不干扰输入），左边图、右边 Context/Skills/Themes/Extensions。**

改代码前先读「硬性不变式」一节——违反那几条会直接破坏 pi 的渲染或用户终端。

---

## 1. 30 秒上手

```bash
cd ~/Work/Program/Project/pi-chafa-banner

bun install                     # 只有 typescript / @types/bun 两个 dev 依赖
bunx tsc --noEmit               # 类型检查（必须干净）
bun test                        # 全部用例必须绿（不写死数字，看输出）

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
src/host.ts       从 pi 运行时组件树里摘除 loadedResourcesContainer（去重资源列表），可 restore
src/banner.ts     Banner 组件：render(width) 合成整个 splash、动画定时器、pending 占位
src/layout.ts     纯排版函数：panel / infoBox / resourcePanel / twoColumn / centerBlock / compactSplash
src/text.ts       ANSI 感知的 visibleWidth / truncateToWidth（必须与 pi-tui 完全一致）
src/frames.ts     ffmpeg→chafa 帧管线、ANSI 清洗、磁盘缓存、preflight
src/images.ts     ffmpeg→PNG 图片管线（kitty 原生图带）、图片缓存、抽稀、网格规划
src/kitty.ts      kitty 图形协议编码（分块、动画 a=f/a=a）+ pi-tui renderImage 桥
src/resources.ts  采集 version/model/theme/context/skills/themes/extensions
src/config.ts     env 解析、默认值、limits、默认 gif 解析（含包内 assets）
assets/banner.gif 随包分发的默认图（源自 ~/Pictures/logo/v-1.gif）
scripts/preview.ts 无 pi 的预览器（唯一安全的排版调试入口）
scripts/demo.sh 用户级启动脚本（打印 env 后 exec pi -e .）
test/ tests/     bun test 用例（两个目录并存，见「已知问题」）
types/pi-host.d.ts  手写的 pi 宿主类型 shim（可能滞后于真实 API）
types/pi-tui.d.ts   @earendil-works/pi-tui 的 4 个导出 shim（renderImage/caps/cell/id）
```

关键锚点：`src/host.ts detachResourceListing`、`src/config.ts defaultGifPath`、`src/frames.ts loadFrames`、`src/frames.ts sanitizeFrame`、`src/layout.ts twoColumn`、`src/layout.ts centerBlock`、`src/layout.ts splashRows`、`src/layout.ts imageBandBudget`、`src/banner.ts render（分派）/ renderChars / renderImage / renderLower / imageLine / preloadImageLines`、`src/banner.ts start`、`src/banner.ts syncTerminalShape`、`src/banner.ts releaseImage`、`src/images.ts loadImageFrames`、`src/kitty.ts buildKittyLine`、`src/kitty.ts cropKittyRoot`、`src/kitty.ts encodeKittyDelete`、`src/layout.ts parseKittyRows`、`src/layout.ts planImageBand`、`src/index.ts installHeader`、`src/index.ts resolveRenderer`、`src/index.ts buildContent`。

## 3. 硬性不变式（改任何东西都要守住）

1. **每行宽度 ≤ width。** `render(width)` 返回的每个字符串，用 `visibleWidth()` 量必须 ≤ width。pi 的 renderer 假定这一点；超宽会串行、把编辑器顶乱。`src/text.ts` 必须与 `@earendil-works/pi-tui` 的 `visibleWidth` 逐字对齐（含 East Asian Width、RGI emoji、VS16、ZWJ），改宽度表要同时在 `bun test` 里对比 pi-tui 的真实实现。
2. **一维字符串数组 = 一行。** 不许在单个元素里塞 `\n`；chafa 输出必须先 split。
3. **chafa 参数不能省 `--probe off`。** 否则 chafa 等终端 DA 应答最多 5s，并抢走 pi 的 stdin；`--animate off` 保证每次只出一帧；`--symbols solid` 只输出前景色块，不画背景（跨终端可对齐）。**不要加 `--clear`**，它产生的 `ESC[2J/ESC[0H` 必须被 `stripChafaControl()` 剥掉。
4. **`render()` 是同步的。** 所有帧必须预渲染并缓存在内存/磁盘，绝不在这里 spawn chafa。
5. **组件只做三件事：`render` / `invalidate` / `dispose`。** 不要实现 `handleInput`/`handleMouse`，不要抢焦点，不要做浮层——splash 必须是文档流里的一行，才能随对话滚走（pi 把 header 放在 `documentContainer` 里，位于 chat 之前）。
6. **定时器必须 `unref()` 且在 `dispose()` 里清掉**，还要在 `/splash off`、`session_shutdown`、会话切换时停。流式输出期间暂停（`agent_start` → pause，`agent_end` → resume）。
7. **不得写用户的 `~/.pi/agent/settings.json`**，也不得改 pi 的 dist。配置只走 `PI_BANNER_*` 环境变量 + `/splash` 命令。
7b. **对宿主组件树的改动必须是纯内存、可逆、可降级。** 目前只有 `src/host.ts` 摘除 `loadedResourcesContainer` 这一处：位置假设是「`headerContainer` 之后紧跟 list 容器」，只认 duck-typed 容器（`children` 数组 + `removeChild`），失配就返回 undefined 静默降级；`/splash off` 必须 `restore()` 插回原索引。不要在 render 期间直接改树（用 `queueMicrotask`），不要写盘、不要打补丁。
8. **所有写盘只在** `~/.pi/agent/tmp/pi-chafa-banner/<sha1>/`（`PI_CODING_AGENT_DIR` 覆盖时跟随）。临时目录用显式路径清理，禁止通配符删除。
9. **降级优先于报错。** 缺 chafa/ffmpeg、gif 不存在、缓存损坏、终端过窄，都要回退到占位卡片 / 紧凑文本 / 内置 header，并只提示一次。
10. **图片行与其后 `r-1` 行严格 `""` 是唯一豁免 `padVisible/truncateToWidth/twoColumn/centerBlock/clampLines` 的行组合。** 禁止在图片行尾部补空格（pi 的 `getKittyImageReservedRows` 遇到 `visibleWidth > 0` 立刻停止计数，一个空格也算），禁止在续行放任何可见字符（必须是字面 `""`，不是 `" "`），禁止手写 `\x1b_G`——必须走 `renderImage(..., { imageId, moveCursor: false })`，`imageId` 才会触发 `registerKittyImageMetadata`（全屏裁剪/placement 复用依赖它），`C=1` 才意味着续行由我们补。
11. **图片模式只能「顶部整条图带 + 下方块」。** 图和 info/资源面板并排是不可行的：`r=` 的续行必须全空，因此图右侧不可能有任何文本。
12. **矮终端只许裁剪，不许把图换成占位卡。** 裁剪走 `layout.ts planImageBand()`（算 `rows/columns/hiddenRows/hiddenColumns/sourceRect`）+ `kitty.ts cropKittyRoot()`（改写根帧 head 的 `x=/y=/w=/h=/c=/r=`，不重编码、不上传新数据）；`IMAGE` 占位卡只用于「还没有图」（构建中/构建失败/无图）。裁剪偏上 1/3（`Math.floor((rows-hidden)*1/3)`），居中裁剪会切断人物脸。
13. **resize 必须换新 `imageId` 重传。** `Banner.syncTerminalShape()` 记住上次 `${columns}x${rows}`，一变就用 `fallbackImageId()` + `reassignKittyImageId()` 重定位整条序列并清缓存：kitty 会在视口变化时丢/挪 placement，而 pi 的 fullscreen 路径只要认为 id 已上传，就会用 `a=p`（只放置、不带 payload）替换掉我们的 `a=T`，导致「预留行空白、永不恢复」。同一 id 重传无法绕过该缓存。
14. **拆卸必须释放图片。** `dispose()` / `/splash off` / 重建换 id 都要发 `a=d,d=I,i=<id>,q=2`（`kitty.ts encodeKittyDelete()`），**禁止 `d=A`/`d=a`**（会清掉别的扩展的图）。kitty 图的生命周期比 pi 进程长：不删就会在退出后继续动。dispose 同步写（进程可能立刻退出），其余走 `setTimeout(…,0)` 延后到本帧写完，绝不在 `render()` 里直接写终端（宿主可能没有 `terminal.write`，必须有降级）。

## 4. 帧管线（改渲染相关必读）

```
assets/banner.gif（或 PI_BANNER_GIF）
  → sha1(path + mtimeMs + size)                    缓存命名与失效依据
  → ffmpeg -i gif -vsync 0 <tmp>/f%03d.png         抽帧（最多 MAX_GIF_FRAMES=240）
  → chafa -f symbols --symbols solid --probe off --animate off -c full|256 -s WxH
  → stripChafaControl + sanitizeFrame(rows=H, cols=W)
  → <cacheRoot>/<hash>/frames-<WxH>-<colorMode>.json
```

图片（kitty 原生）管线：

```
assets/banner.gif（或 PI_BANNER_GIF）
  → preflight（图片模式只查 ffmpeg，不需要 chafa）
  → ffmpeg 单遍：抽帧 + scale=W:H + palettegen/paletteuse → pal8 PNG（失败退 rgb24，再退单帧）
  → 按 PI_BANNER_STRIDE 取样 → decimate 到 MAX_FRAMES(=config.maxFrames) → base64
  → <cacheRoot>/<sha1>/images-b<cols>x<rows>-c<cellW>x<cellH>-p<palette>-s<stride>.json
  → 运行期 allocateImageId() + renderImage(root, {imageId, moveCursor:false}) → ImageFrameSet
```

- 图片缓存有独立版本号 `IMAGE_CACHE_VERSION`（与 `CACHE_VERSION` 无关）；**`imageId` 绝不落盘**，否则跨进程 id 冲突。
- 网格来自 PNG 宽高比：先算 cells，再按 `cells*cellW × cells*cellH` 编码，最后以 `renderImage` 回读的 `{columns, rows}` 为准。
- 裁剪发生在 render 期，不在管线里：`planImageBand()` 给源矩形，`cropKittyRoot()` 只改 head，所以矮终端/宽图不触发任何 re-encode。侧证：88x24 终端 → `x=0,y=90,w=360,h=90,c=40,r=5`，无占位卡。

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
- 矮终端会从顶部裁剪图片行（`MIN_CROP_ROWS=10`）；字符画模式的 `IMAGE unavailable` 卡片固定 5 行信息框。
- 图片模式的裁剪规则（`planImageBand()`）：`available = totalRows - statusRows - IMAGE_GAP_ROWS`；能整张放下就原样（`whole=true`），否则 `rows = max(MIN_IMAGE_ROWS, available - MIN_LOWER_ROWS)`，列不够则 `columns = min(image.columns, availableColumns)`；只有 `availableColumns < min(MIN_IMAGE_COLUMNS, image.columns)` 或 `available < 1` 才返回 `undefined`（退到占位卡）。

## 7. 配置与命令

| env | 默认 | 说明 |
| --- | --- | --- |
| `PI_BANNER_GIF` | 包内 `assets/banner.gif` → `~/.pi/agent/banner.gif` → `~/Pictures/logo/v-1.gif` | 显式值即使不存在也优先（报错比换图好） |
| `PI_BANNER_SIZE` | `44x22` | 8–160 × 4–60 |
| `PI_BANNER_FPS` | `16` | 1–30 |
| `PI_BANNER_STRIDE` | `3` | 1–10 |
| `PI_BANNER_RENDERER` | `auto` | `auto/chars/kitty`；`auto` 在 `getCapabilities().images==="kitty"` 时用原生图带，显式 `kitty` 不可用时提示一次并回退 |
| `PI_BANNER_STATIC` / `PI_BANNER_DISABLED` | off | 单帧 / 完全不装 header |
| `PI_BANNER_KITTY_MODE` | `anim` | `anim`（终端自播，稳态 0 B/s）/ `frames`（每 tick 重传，逃生阀） |
| `PI_BANNER_PALETTE` | `128` | 16/32/64/128/256（`paletteOf()` 向下取整） |
| `PI_BANNER_MAX_PX` | `640000` | 单帧像素上限 |
| `PI_BANNER_MAX_FRAMES` | `24` | 抽稀后帧数上限 |
| `PI_BANNER_ANIM_SECONDS` | `0` | `>0` = N 秒后冻结成静图 |
| `PI_BANNER_HIDE_RESOURCES` | on（默认摘） | `0` = 保留 pi 自己那份 `[Context]/[Skills]/…` 列表 |

`/splash on|off|freeze|rebuild|size <WxH>|status`。`off` 时用 `ctx.ui.setHeader(undefined)` 恢复内置 header。

## 8. 已知问题 / 路线图

1. **kitty 原生图像已实现（v1.1）**，但只在真机能验收：`src/images.ts` + `src/kitty.ts` + `Banner.renderImage()`。要点：图带独占顶部、续行严格 `""`、`anim` 模式行恒定（pi 看不到 diff → 不触发 `fullRender(true)`）。协议细节：`a=f` 帧头**必须**带 `f=100`（kitty 不继承根图格式，`graphics.c` 里 `uint32_t fmt = g->format ? g->format : RGBA;`，缺了会按 raw RGBA 校验 PNG 而整帧丢弃，`q=2` 把错误吞掉，表现为「只有静止首帧」）；所有命令头都要 `q=2`（否则 kitty 回 `OK` 到 tty，可能被当成按键）。**尚未验证/未实现**：iTerm2 inline images（`caps.images==="iterm2"` 仍回退 chars）；终端忽略 `a=f/a=a`（Ghostty 等）时只剩根帧静态图，属预期降级；`PI_BANNER_KITTY_MODE=frames` 的滚动代价见 §8.7。真机验收看 `PI_TUI_DEBUG_REDRAW=1 pi -e .` 生成的 `pi-tui-debug.log`，anim 模式下**不应**出现 `fullRender: firstChanged < viewportTop`。裁剪、resize 重传、拆卸删除见 §3.12–3.14 与 §8.8。
2. **重复列表（已解决，v1.0）**：pi 内置的 `[Context]/[Skills]/[Extensions]` 原本会显示在 splash 下方。现在 `src/host.ts` 在挂载时把 `loadedResourcesContainer` 从 `tui` 组件树里摘掉（纯内存、`/splash off` 会插回、失败静默降级），`/splash status` 会报 `listing hidden|visible`。兜底仍是让用户设 `"quietStartup": true`（扩展无权改 settings），dist patch 方案已废弃。**注意**：位置假设依赖 pi 的 `documentContainer.children = [headerContainer, loadedResourcesContainer, chatContainer, …]`；升级 pi 后先跑 `pi -e .` 目视确认，再看 `/splash status`。
3. **矮终端裁剪**：splash 只能用「文档视口」= `terminalRows - CHROME_ROWS`（`CHROME_ROWS=7`：editor 3 行 + footer 2 行 + headerContainer 上下各 1 个 `Spacer(1)`），`layout.ts splashRows()` 与 `imageBandBudget()` 共用这个常量。改尺寸逻辑时用 `preview --rows 18|20|24|30|40|50` 回归 `total-rows`：必须满足 `total-rows + CHROME_ROWS ≤ rows`。超出的后果不是简单裁剪——图片锚点滚出视口会让 pi 每帧 `fullRender(true)`。
4. **`test/` 与 `tests/` 并存**，`tests/*.test.ts` 与 `test/*.test.ts` 有重叠用例，`tsconfig.json` 的 `include` 只覆盖 `test`。清理前要征得用户同意（禁止批量删除）。
5. **`types/pi-host.d.ts`** 是手写 shim，`TUI.mode` 曾写成 `"inline"` 而真实值是 `"regular"`。`TerminalLike.write` 是可选方法（pi-tui `terminal.js:436 write(data){process.stdout.write(data)}`），宿主不提供时必须静默降级。改扩展 API 用法时对照 `dist/**/*.d.ts`。
6. **动画开销**：字符画 21KB/帧 × 16fps ≈ 340KB/s；图片 `anim` 模式稳态 0 B/s（一次传输后终端自播，缓存文件约 2–3 MB base64），`frames` 模式约 1.3 MB/s。长会话、全屏模式、慢终端下建议降 fps/stride 或 `PI_BANNER_STATIC=1`。
7. **`frames` 模式代价极高**：每 tick 改一次 image 行 ⇒ `firstChanged` 落在 header 里；一旦 splash 高度 ≥ 文档视口，图片锚点滚出 `viewportTop`，pi 的 `tui-main-screen.js` 会走 `fullRender(true)`（`\x1b[2J\x1b[3J`，连 scrollback 一起清）并把整帧重新传输。`anim` 模式行恒定、无 diff，不受影响。所以 `frames` 只作为「终端忽略动画」的逃生口：长会话请配 `PI_BANNER_STATIC=1` 或 `PI_BANNER_ANIM_SECONDS`，不要长期开着。TUI 没有公开 viewport API（`previousViewportTop` 是 private），无法加守卫，只能文档约定。
8. **resize / 退出残留（v1.2 修复，pty 实证）**：用户报的两个症状——「调窗口后图片不见」与「退出 pi 后图还在原位置继续动」——已用 `syncTerminalShape()`（换新 imageId 重传）+ `encodeKittyDelete()`（`a=d,d=I`）修复。机理与证据：
   - fullscreen 模式下 pi 的 `tui-alt-screen.js prepareKittyScreen()` 会把我们的 `a=T` 换成 `a=p`（`terminal-image.js:353`，只放置不带 payload），条件是 `uploadedKittyImages.get(imageId)` 存在且 `transmissionGeneration` 未变 → 终端一旦丢掉数据就永久空白，且同一 id 重传也救不回来。
   - regular 模式本来每次都 `a=d,d=I` + 完整 `a=T` 重传，所以看起来是自愈的。
   - 复现/验收脚本：`/tmp/pcb-probe/pty_pi.py`、`/tmp/pcb-probe/pty2.py`（pty.fork + TIOCSWINSZ + SIGWINCH 分阶段抓原始字节）。实测 `pty2.py`（默认 fullscreen）：startup `a=T…c=44,r=22,i=A`；resize-100x40 → 新 id 的 `a=T…x=0,y=0,w=396,h=378,c=44,r=21`；resize-88x24 → `x=0,y=90,w=396,h=90,c=44,r=5`（满宽裁剪、无占位卡、无二次重建）；shutdown → `d=I=1`（我们的删除）+ `d=A=1`（pi 自己退出时的清理）。`pi --tui-mode regular -e .` 同样正常：每次 resize 新 id + 裁剪 root，shutdown 仅 118 字节（`a=d` + `d=I`），动画立即停止。
   - 仍有理论盲区：若某终端在 resize 时连 `a=p` 的 placement 也不重建（kitty 之外），目前只能靠「换 id 重传」覆盖，未做逐终端验证。

## 9. 常见改法

- **换默认图**：覆盖 `assets/banner.gif`（保持文件名），或改 `config.ts` 的 `BUNDLED_GIF_PATH`。缓存按 mtime 失效，无需清缓存。
- **换画布尺寸/宽高比**：改 `DEFAULTS.size`，并在 `banner.ts` 检查左边列宽与 `INFO_BOX_ROWS` 是否仍成立。
- **改边框/配色**：只动 `layout.ts` 的 `THIN_BOX` 与 `themePainter()` 的 token 映射；不要硬编码 RGB，主题切换要跟着变。
- **加资源区块**：`layout.ts resourcePanel()` 的 sections + `resources.ts collectResources()` + `banner.ts` 的 info 行预算；`distributeLines()` 负责各行高度分配。
- **改动画节奏**：`banner.ts start()` 的 interval、`frames.ts` 的 stride；保持 `unref()` 与暂停/恢复逻辑。
- **调图片观感/体积**：`PI_BANNER_PALETTE`（颜色数→每帧字节）、`PI_BANNER_MAX_PX`（网格缩放）、`PI_BANNER_MAX_FRAMES`（抽稀）。改缓存键字段时同时改 `imageCachePath()` 与 `IMAGE_CACHE_VERSION`。图片行只能经 `Banner.imageLine()` 生成，永远不要在外面拼 `\x1b_G`。

## 10. 外部参考

- `https://github.com/danielmrdev/beautiful-pi` —— 同为 setHeader splash，双栏 + `╭─ RESOURCES ─╮` 面板的画法。
- `https://github.com/mavam/pi-splash` —— 滚动行为（header 属于文档流）、`unref()` 定时器、窄终端处理。
- pi 文档：`/usr/lib/node_modules/pi/packages/coding-agent/docs/{extensions,tui,packages,cli}.md`；组件契约看 `packages/tui/dist/tui.d.ts`。
