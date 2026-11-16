# AGENTS.md — pi-chafa-banner

给未来的 agent / 协作者看的项目手册。目标一句话：**把一张 GIF 用 chafa 渲染成
字符画，放进 pi 的启动 header —— 默认排成「左上图片、左下 coding-agent 信息卡、
右侧 resources 面板」，随对话上滚，不干扰输入。**

排版本身是一棵递归布局树（`layout` / `window` / `chafa` 三种节点），默认树就是上面
这个形状；结构错误或空间不足会画出 `LAYOUT ERROR` 卡片，而不是悄悄换一套布局。

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
bun run scripts/preview.ts --width 60            # 窄终端
bun run scripts/preview.ts --static --theme tokyonight   # 换配色
bun run scripts/preview.ts --static --color border=#ff0000

# 真机验证（交互式，需人工看）
pi -e .                         # 临时加载扩展，不动 settings
bash scripts/demo.sh --preview  # 同上，打印生效配置后再预览
bash scripts/demo.sh            # 真机：pi --no-extensions -e .（只加载本插件）
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
src/banner/component.ts   Banner 类：render / invalidate / dispose + 帧定时器（只索引预渲染帧）
src/banner/panels.ts      contentContext / buildStatusLine（resources → ContentContext）
src/layout/tree.ts        节点类型、assertTree、proportionalShares、planChafaNodes、LayoutError
src/layout/measure.ts     measureTree / distribute / allocate：按 weight 分格子，放不下抛 LayoutError
src/layout/render-tree.ts renderSplash / renderNode / cropFrame / placeholderCard / renderLayoutError
src/layout/palette.ts     resolvePalette / hexToRgb / rgbTo256 / foregroundCode / paintForeground
src/layout/box.ts         panel / formatInfoRow / resourceSection / wrapNames / stackNames / themePainter
                          （infoBox / resourcePanel / distributeLines 是 v1 面板的老帮手，只剩测试在用）
src/layout/compose.ts     centerBlock / compactSplash / clampLines（twoColumn 同属 v1，仅测试引用）
src/layout/metrics.ts     CHROME_ROWS / splashRows（blockWidthFor 同属 v1，仅镜像配置时用）
src/text/ansi.ts          ANSI_RE / isImageLine / stripAnsi
src/text/width.ts         grapheme 与东亚宽度、visibleWidth、padVisible、centerVisible
src/text/truncate.ts      truncateToWidth / truncateEllipsis / sliceVisible
src/frames.ts             ffmpeg→chafa 帧管线、sanitizeFrame、磁盘缓存
src/pipeline/process.ts   run（无 tty、超时）/ preflight / gifHash / probeSourceSize
src/pipeline/timing.ts    每帧延时：probeGifTiming / aggregateDelays / thinDelays / describeTiming
src/pipeline/args.ts      image.chafa 的 splitArgs / sanitizeChafaArgs / parseChafaArgs / argsDigest
src/pipeline/cache.ts     cacheRoot / cacheFilePath / 原子写 / 单文件删除
src/content.ts            内容层 barrel（`export * from "./content/index.ts"`），src 内部统一从这里 import
src/content/providers.ts  PROVIDERS（version/model/context/skills/extensions）/ resolveContent / registerProvider / SECTION_STYLE
src/config/schema.ts      类型、DEFAULT_FILE、DEFAULT_LAYOUT、LIMITS、parseSize、palette 常量
src/config/tree.ts        `layout` 子树解析：parseLayoutTree / hasLayoutTree（结构错 → error 字符串）
src/config/legacy.ts      v1（扁平 layout/panels）→ 等价 v2 布局树的翻译
src/config/validate.ts    宽容解析：逐键警告，永不抛
src/config/load.ts        pluginRoot / configPath / loadConfig / applyPlanSources / 测试缝
src/resources.ts          采集 version/model/thinking/context/skills/extensions
src/host.ts               从 pi 组件树里纯内存摘除 loadedResourcesContainer
```

关键锚点：`src/banner/component.ts` 的 `render` / `frameDelay` / `scheduleTick` /
`start` / `dispose`；`src/layout/render-tree.ts` 的 `renderSplash` / `renderNode` /
`measureContent` / `cropFrame`；`src/layout/measure.ts` 的 `distribute` / `allocate`；
`src/layout/tree.ts` 的 `planChafaNodes` / `proportionalShares`；`src/layout/metrics.ts splashRows`；
`src/config/load.ts loadConfig`；`src/frames.ts loadPlanFrames`；
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
4. **`render()` 是同步的，而且只读预渲染缓存。** 所有帧必须在异步阶段
   （`loadPlanFrames()`、session 的刷新流程）渲染完，按 `ChafaPlan.key` 落进
   `Banner` 的 `Map<string, FrameSet>`；`render()` 只做索引、裁剪与拼行，绝不在这里
   spawn 子进程或读盘。异步采集（`pi -v`、chafa、ffmpeg）的结果必须先写进 state
   再 `requestRender()`。
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
9. **运行时降级优先于报错，配置结构错误例外。** 缺 chafa/ffmpeg、gif 不存在、
   缓存损坏、终端过窄，都要回退到占位卡 / 紧凑文本 / 内置 header，并且只提示一次。
   但结构错误（未知 `type`、空 `children`、`window` 没有 `content`、`weight <= 0`）
   和「盒子小于节点最小尺寸」必须渲染 `LAYOUT ERROR` 卡片，不能静默换成默认布局。
10. **chafa 画布只由配置（+终端宽度）推导，不在 `render()` 里重跑 chafa。**
    `planChafaNodes()` 在 `loadConfig()` 阶段用 `width` / `gap` / `weight` 算好每个画布的
    `WxH`，帧在终端尺寸未知时就预渲染完。终端比配置窄时：`measureTree()` 按
    `min(width, cols)` 重新量一次盒子，`renderSplash()` 用 `plansForWidth()` 按新宽度重算
    画布（高度沿用已探到的宽高比，图片等比缩小而不是被横切），并回调一次
    `onWidthChange(width)` → `resizeSplash()` 去防抖重建帧（按键含 `WxH`，缩回去命中缓存）。
    重建落地前先用旧帧居中裁剪兜底；帧没到手时绝不改配置，所以不会出现'占位闪一下'。
11. **默认树保持「左上图片、左下信息卡、右 resources」。** `DEFAULT_LAYOUT` 的两列
    等权（5/5）：左列 `chafa` 在上、`CODING AGENT` 在下，右列 `RESOURCES` 跨满高度。
    用户可以写任意树，但改默认值时别退化成整条图带或把面板塞进图片右边（pi 的
    `visibleWidth` 记账、用户的截图都按这个来）。
12. **结构错误与尺寸不足必须画出错误卡。** `renderSplash()` 捕获 `LayoutError`
    和解析期的 `layoutError`，统一交给 `renderLayoutError()`；错误信息用
    `configPathOf()` 把 `root.0.1` 翻成 `layout.children[0].children[1]`，让用户知道
    该改文件里的哪一行。错误卡每一行也被 `truncateToWidth` 裁到 `width` 内。
13. **帧的时间来自 GIF，不来自 fps。** `image.fps: "auto"`（默认）时用
    `frames.delays[]`，`stride` 丢掉的帧时长要累加给保留帧（`aggregateDelays`），
    这样一圈总时长不变；写数字才覆盖成固定帧率。

## 4. 帧管线（改渲染相关必读）

```
assets/banner.gif（或 image.path / chafa 节点的 img）
  → sha1(path + mtimeMs + size)                   缓存命名与失效依据
  → ffprobe pts_time + format=duration            每帧延迟（每张图各 probe 一次）
  → planChafaNodes()：width + gap + weight → 每个 chafa 节点的 WxH
  → applyPlanSources()：用每张图真实宽高比覆盖计划高度
  → ffmpeg -vsync 0 <cache>/work-*/f%03d.png      抽帧（最多 MAX_GIF_FRAMES=240）
  → 每 image.stride 取一帧，被丢帧时长并给保留帧
  → chafa -f symbols --symbols solid --probe off --animate off -c full|256 \
          <image.chafa + 节点 args> -s WxH
  → stripChafaControl + sanitizeFrame(rows=H, cols=W)
  → <cache>/<hash>/frames-<WxH>-<color>[-<argsDigest>].json
  → loadPlanFrames()：按 plan.key（节点路径）装进 Map<string, FrameSet>
```

- 缓存带 `CACHE_VERSION`（现在是 2）；**改 JSON 结构就要 +1**，否则老缓存会被误判有效。
- 色深来自 `theme.getColorMode()`：`truecolor → -c full`、`256color → -c 256`。
- `image.chafa` 与节点 `args` 同时进缓存文件名（8 位 digest）与 payload，两套参数不会串图。
- 同一张图 + 同尺寸 + 同参数的多个 chafa 节点共用一份缓存文件（`groupPlans()`）。
- 某个画布失败只影响它自己的节点：占位卡显示错误，其余画布照常渲染。
- 冷启动约 300–500ms，异步进行；构建期间对应节点显示 `IMAGE` 占位卡。

## 5. 数据来源（右侧面板）

| 区块 | 来源 | 备注 |
| --- | --- | --- |
| Context | `scanContextFiles()`：`AGENTS.override.md/AGENTS.md/AGENTS.MD/CLAUDE.md/CLAUDE.MD`（cwd 及祖先、agentDir）、`APPEND_SYSTEM.md`（`<cwd>/.pi/`、agentDir） | 无公开 API，只能扫盘 |
| Skills | `pi.getCommands()` 里 `name` 以 `skill:` 开头；首轮后用 `before_agent_start` 的 `event.systemPromptOptions.skills` 补全 | 首轮前可能不全 |
| Extensions | `settings.packages` 的 `npm:` 包（读 `~/.pi/agent/npm/node_modules/<pkg>/package.json` 的 `pi.extensions[0]`，用 `packageEntryLabel()` 按 pi 的 `getCompactExtensionLabel` 规则拼成 `包名:入口`：去 `./`、去开头 `extensions/`、`index.*` 折叠成所在目录、包根只剩包名、其它保留相对路径）+ `settings.extensions` 路径与扩展目录（`compactPathLabels()` 取最短唯一路径后缀，`foo/index.ts` → `foo`）+ `pi.getCommands()` 里 `source:"extension"` 的兜底：标签由命令的 `sourceInfo` 反推（`labelFromSourceInfo()`，npm 源走 `packageEntryLabel`、本地源走 `compactPathLabels`），**绝不用命令名**——`acp`/`acp-cache` 都是 `billion-context` 的命令，pi 只列扩展一次；`builtin:`/`<...>` 这类合成路径（pi 自带的 `llama.cpp`、`mcp` 等 `hidden` 扩展）直接跳过 | 目标是与 pi 启动时的 `[Extensions]` 列表逐字一致（含 `@scope`）；同名目录条目和同一扩展的多个命令都会去重；`hidden` 扩展无法感知；没有命令又没有目录的扩展可能漏 |
| version/model/thinking | `pi -v`（`getPiVersion()`，每进程只 spawn 一次并缓存，失败退化成 `?.?.?`）、`ctx.model.{name,provider,id}`、`ctx.thinkingLevel`（`model_select` / `thinking_level_select` 事件里用事件值，避免晚一拍） | 信息卡标题是 `CODING AGENT` |

采集整体 `try/catch`，任何一块失败只影响该区块。

窗口里的值走 `src/content/providers.ts`：`window.content[].content` 先当 provider
名查表，查不到就当字面量渲染。5 个内置 provider 是 `version`、`model`（带
`· high` 尾缀）、`context`、`skills`、`extensions`；列表类返回字符串数组，
`stacked: true` 时一行一个，否则逗号换行（默认树里 `Extensions` 竖排，`Context`/`Skills` 逗号换行，和 pi 的
启动列表排版一致）。`SECTION_STYLE` 是 `outline` 的默认标题。

## 6. 尺寸与布局

根盒子只由配置决定，终端列数/行数只负责封顶（`src/layout/render-tree.ts renderSplash`）：

```
W = variableWidth  ? min(max(width,  prefWidth ), cols)   : min(width,  cols)
H = variableHeight ? min(max(height, prefHeight), budget) : min(height, budget)
budget = splashRows(rows) - (status 行 ? 1 : 0)
splashRows(rows) = max(10, rows - CHROME_ROWS)          // CHROME_ROWS = 7
```

- **`height` 是目标高度。** 内容不足 `height` 时保留空白行（盒子就这么高）；
  `variableHeight: false`（默认）时盒高恒为 `height`，放不下的行被标记成 `...`/`  ...`；
  `true` 时盒子继续长高直到内容放得下（上限 `budget`）且不写标记。
  `width` 同理：`variableWidth: false` 时根宽恒为 `width`，更宽的行以 `...` 结尾；
  `true` 时按内容的 `prefWidth` 长到 `cols` 为止。
- **溢出标记看被截掉的那一行是什么。** 行太宽 → 该行以 `...` 结尾；行数不够 →
  最后一行变成标记，缩进**沿用被截掉的那一行**（`overflowMark()` 从 `leadingSpaces(stripAnsi(text))`
  取）：标题（`[Xxx]`）和 inline 字段顶格写 `...`，条目写 `  ...`。这样截断处不会错开一列。
  `variableHeight: true` 时完全不写标记。
- 低于 `compactWidth`（32）直接退化成 `compactSplash()` 三行，不进布局树。
- 分配算法（`src/layout/measure.ts`）：同一组里按 `weight` 用最大余数法
  （`proportionalShares`）分格子；低于 `min` 的孩子从「最富余」的兄弟那里拿；
  刚性节点（`chafa`）停在自然尺寸，剩格先补 preference 缺口，再按 weight 给
  可伸缩节点（`window`）。**第 3b 步（仅高度轴）**：格子被 min 吃光、还有可伸缩
  节点欠 preference 时，一次一格地从「仍高于自身 min（刚性）或高于自身 pref（可伸缩）」
  的兄弟那里借，直到补上或没人能借。宽度轴不借——借来的列会让画布盒与 plan 失配、
  破坏 5/5 分栏。`layout` 组的 min/pref 由孩子求和（横向）或取最大（纵向），并计入 `gap`。
- 节点最小尺寸 `NODE_MIN`：`chafa` 8x2、`window` 12x3。任一孩子分到的格子低于
  最小值（含交叉轴）就抛 `LayoutError` → `LAYOUT ERROR` 卡片，不会悄悄压小。
  `chafa` 的高度下限只有 2 是有意的：矮终端上先裁字符画，把行让给信息卡。
- 画布推导：`planChafaNodes()` 只在 `horizontal` 组里按 weight 切宽度，`vertical`
  组把宽度原样传下去；高度先取 `autoHeightFor(width) = clamp(round(width/2), 4, 80)`，
  ffprobe 拿到真实宽高比后由 `applyPlanSources()` 覆盖成
  `round(width * srcH / srcW / 2)`（同样 clamp）。所以同一份配置下画布尺寸与终端
  无关；窄终端只让它被裁（`cropFrame` 从顶部裁 + 居中）。
- 窗口内容尺寸：`measureContent()` 用 `[Title] value` 的自然宽度（+边框 4 列）
  给 `prefWidth`、正文行数 + 2 给 `prefHeight`，参与上述分配；放不下的正文末行
  显示 `…`。
- 回归方式：`preview --width 60|100|140`、`preview --rows 18|24|30|40|50` 目视
  + `bun test` 的宽度/布局契约用例。

## 7. 配置与命令

`pi-chafa-banner.json` 放在**扩展旁边**（`configPath(pluginRoot())`）：全局安装是
`~/.pi/agent/pi-chafa-banner.json`，项目安装是 `<project>/.pi/pi-chafa-banner.json`。

| 组 / 键 | 默认 | 说明 |
| --- | --- | --- |
| `version` | `2` | 当前是 v2（树形布局） |
| `image.path` / `fps` / `stride` / `chafa` | 见 §4 | `path` 缺省先找 `~/Pictures/logo/v-3.gif`，再找 `~/Pictures/logo/v-1.gif`，最后退包内 `assets/banner.gif` |
| `width` / `height` | 88 / `"auto"` | 根盒子；`height` 写数字是下限（内容更多就长高，`variableHeight: false` 时才是硬上限），写 `"auto"` 则恰好等于内容自然高度 |
| `gap` | `{width: 2, height: 1}` | 每个 `layout` 组里兄弟之间的空列/空行，按轴分开（字符格约两倍高） |
| `variableWidth` / `variableHeight` | false / false | 是否允许根盒子超过 `width`/`height` 去容纳内容（`false` 时用 `...` 标记溢出） |
| `compactWidth` | 32 | 窄于此直接三行紧凑模式 |
| `layout` | `DEFAULT_LAYOUT` | 递归树；省略即用默认树（默认形状见 §3 不变式 11） |
| `theme.preset` / `windowTitle` / `sectionTitle` / `border` / `content` | `"tokyonight"`，四色默认 `#7aa2f7`/`#bb9af7`/`#3b4261`/`#a9b1d6` | `preset: "pi"` 改为跟随 pi 主题 token |
| `behavior.enabled` / `static` / `hidePiResourceList` | true / false / true | 总开关、冻结静图、摘掉 pi 自带的资源列表 |

`layout` 子树的节点：

| 节点 | 字段 | 说明 |
| --- | --- | --- |
| `layout` | `mode: "horizontal"\|"vertical"`、`children[]`、`weight` | 分组：横向按 weight 切宽，纵向切高；省略 `mode` 按 `vertical` |
| `window` | `title?`、`content[]`、`weight` | 带边框的盒子；标题缺省用 `WINDOW` |
| `chafa` | `img?`、`args?`、`weight` | 一个字符画画布；`img` 覆盖 `image.path`（原样使用，不展开 `~`），`args` 追加到 `image.chafa` |
| `content` 项 | `type: "inline"\|"outline"`、`title?`、`content`、`stacked?` | `inline` 一行 `[Title] value`；`outline` 标题单独一行；`stacked` 列表一行一个 |

`weight` 默认 1，相对兄弟分配父节点的格子（最大余数法，余数相同靠前的孩子优先）。
`content` 先按 provider 名解析（`src/content/providers.ts` 的 5 个：`version`、
`model`、`context`、`skills`、`extensions`），未注册的名字按字面量渲染；`model`
自带 `· high` 尾缀（思考强度未知时省略）。

v1 兼容：`layout` 不是树（没有 `type`/`children`）且文件里出现 `layout`/`panels` 时，
`src/config/legacy.ts` 会翻译成等价树。`layout.width`/`gap`/`compactMinWidth`、
`panels.info.fields`、`panels.resources.sections` 会被采用（`fields`/`sections` 映射到
对应 `window.content`）；`panels.info.enabled: false` / `panels.resources.enabled: false`
会真正去掉对应窗口（v1 的渲染器就是省略它），各给一条 warning；
`layout.maxWidth`/`twoColumnMinWidth`/`lowerRows`、`panels.resources.width`/`height`、
`maxLinesPerSection` 以及 panels 里不认识的字段在 v2 没有一等配置键
（`src/config/load.ts` 只保留 `mirrorLayout`/`mirrorPanels` 的兼容镜像），每一项都给一条
warning，不静默丢弃。

宽容策略：缺文件/缺键 → 默认值；类型或枚举错 → 默认值 + `source.warnings`；
数值越界 → clamp + 警告；未知键静默忽略。**唯一的例外是 `layout` 结构错误**：
返回 `layoutError` 并渲染错误卡，绝不回退成默认树；同时往 `source.warnings` 里塞一条
`layout: <message>`，因为 `/splash reload` 和 `/splash status` 只打印 warnings。
`/splash status` 打印生效配置、缓存、工具检测与全部警告（结构错误时报 `layout=error`）。

配色：四个角色（`windowTitle` 窗口标题、`sectionTitle` 标签标题、`border` 边框、
`content` 窗口内容）由 `src/layout/palette.ts` 的 `resolvePalette()` 解析——默认
`preset: "tokyonight"` 把四色全部钉死，`preset: "pi"` 返回空 palette，此时
`themePainter(theme, settings)` 回落到 pi 的 `borderMuted`/`mdHeading`/`text`；
写了 `content` 就一并顶掉 `text`/`muted`/`dim` 三档。
选色按 `theme.getColorMode()` 走 `truecolor`（24 位 SGR）或 `256color`（最近
调色板项），复位用 `ESC[39m` 而不是 `ESC[0m`，不能踩掉外层 bold。

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
3. **矮终端**：splash 只能用「文档视口」= `rows - CHROME_ROWS`。`height` 是下限、
   `variableHeight` 默认关闭（盒高钉在 `height`），内容放不下时先从顶部裁 chafa 画布（`cropFrame`）；
   分配算法的 3b 步再让 chafa 把行借给欠 preference 的信息卡，所以 16 行终端 + 状态行
   也还能看到 `[Version]`/`[Model]`。连 min 都塞不进 `budget` 时 `distribute()` 抛
   `LayoutError`，显示 `LAYOUT ERROR` 卡片。改尺寸逻辑时用
   `preview --rows 12|16|18|24|40` 回归。
4. **`types/pi-host.d.ts`** 是手写 shim（`TUI.mode` 的真实值是 `"regular"`）。
   改扩展 API 用法时对照 `pi-coding-agent` 的 `dist/**/*.d.ts`。
5. **动画开销**：字符画约 21KB/帧、`fps` 按 GIF 原生（示例 8 帧 2.4s）。长会话、
   全屏模式、慢终端下建议 `behavior.static: true` 或调大 `stride`。
6. **`fps` 写死数字会加速**：`stride` 丢掉帧后固定 fps 不等于原速，这正是默认
   `"auto"` 的原因。
7. **缓存目录会积累**：每次改 gif / 尺寸 / chafa 参数都会产生新 `<sha1>` 目录，
   旧目录不自动清理（禁止批量删除，需要时手动删具体路径）。

## 9. 常见改法

- **改布局**：改 `layout` 树（默认值在 `src/config/schema.ts` 的 `DEFAULT_LAYOUT`），
  加 `window`/`chafa` 节点或调 `weight`、`gap`、`width`/`height`；画布与两列宽度
  会一起重算。不要在渲染器里另写一套硬编码分栏。
- **换默认图**：改 `~/Pictures/logo/v-3.gif` 的内容，或设 `image.path`，或覆盖
  `assets/banner.gif`（缓存按 mtime 失效，无需清缓存）；单个 `chafa` 节点可用 `img` 覆盖。
- **换画布尺寸/宽高比**：改 `layout` 里的 `weight` / 根 `width` / `gap`。画布是
  `planChafaNodes()` 推导出来的，没有 `size` 配置项；高度最终由 gif 宽高比决定
  （clamp 到 4..80 行）。
- **改边框/配色**：字符形状只动 `src/layout/box.ts` 的 `THIN_BOX`；颜色走
  `src/config/schema.ts` 的 `TOKYONIGHT_PALETTE` + `src/layout/palette.ts` 的
  `resolvePalette()`，token 映射在 `themePainter()` 里。四个角色之外的颜色（例如
  状态行）仍用 pi token，不要为新硬编码 RGB 开例外——`theme.preset: "tokyonight"`
  是默认，`"pi"` 那条路径必须保住浅色终端可读性。加角色要同步 `THEME_ROLES`、`ThemeSettings`、schema.json、
  `README.md` 的配色表与 `test/theme.test.ts`。
- **加内容字段/资源区块**：在 `src/content/providers.ts` 注册 provider（或直接用
  返回字符串/字符串数组的函数），再在某个 `window.content` 里引用名字；
  `SECTION_STYLE` 决定 `outline` 的默认标题与是否 `stacked`。加资源还得让
  `src/resources.ts collectResources()` 采集对应数据。
- **改动画节奏**：`src/banner/component.ts` 的 `frameDelay()`/`scheduleTick()`、
  `src/frames.ts` 的 stride 与 `src/pipeline/timing.ts` 的聚合；保持 `unref()` 与
  暂停/恢复逻辑。
- **调性能**：`image.stride`（少渲染）、根 `width`（小画布）、
  `image.chafa` 或节点 `args`（例如 `--symbols block` 让每格用一个全块字符）。

## 10. 外部参考

- `https://github.com/danielmrdev/beautiful-pi` —— 同为 setHeader splash、
  `╭─ RESOURCES ─╮` 面板的画法（灵感，无代码）。
- pi 文档：`/usr/lib/node_modules/pi/packages/coding-agent/docs/{extensions,tui,packages,cli}.md`；
  组件契约看 `packages/tui/dist/tui.d.ts`。
