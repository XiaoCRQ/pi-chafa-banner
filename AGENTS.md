# AGENTS.md — pi-chafa-banner

给未来的 agent / 协作者看的项目手册。一句话目标：**把一张 GIF 放进 pi 的启动 header
（顶部、随对话上滚、不抢输入）：图在上，coding-agent 信息与 resources 双栏在下。**
普通终端走 chafa 字符画，kitty 类终端走原生图片。

用户文档看 `README.md` / `README.zh-CN.md`；模块划分、数据流、协议细节与上游引用逐项说明
看 `docs/ARCHITECTURE.md`。本文件只记「怎么做对、哪里容易踩」。

---

## 1. 30 秒上手

```bash
bun install                 # 只有 typescript / @types/bun 两个 dev 依赖
bunx tsc --noEmit           # 类型检查（必须干净）
bun test                    # 全部用例必须绿

bun run scripts/preview.ts --width 100                 # 字符画排版
bun run scripts/preview.ts --image --width 100         # 图片带排版
bun run scripts/preview.ts --rows 24 --plain           # 矮终端（图片不裁，面板让位）
pi -e .                                                # 真机（交互式，人工看）
```

**禁止**写自动化脚本去启动交互式 pi（会占住 TTY）。非交互冒烟只能：

```bash
pi --list-models --offline -e . | grep -c "Failed to load extension"   # 必须是 0
```

加载失败时 pi 仍返回 0，只有 grep 能发现问题。

## 2. 目录（行号会漂，函数名为准）

```
src/index.ts              入口：pi 事件 → controllers，86 行
src/extension/state.ts    SessionState 持有者、渲染器选择、status 文案
src/extension/session.ts  bootstrap、后台构建、资源刷新、resize 重建
src/extension/header.ts   setHeader 接线、pi 资源列表摘除/恢复
src/extension/commands.ts /splash on|off|freeze|rebuild|reload|status
src/config/schema.ts      配置形状、默认值、limits、parseSize/paletteOf
src/config/validate.ts    宽容读取 JSON（缺键→默认，越界→clamp，错误→警告）
src/config/load.ts        文件发现、gif 解析、auto 高度、loadSessionConfig
src/banner/component.ts   Banner 组件本体（render/invalidate/dispose）
src/banner/band.ts        ImageFrameSet → kitty 序列行（WeakMap 记忆）
src/banner/panels.ts      info 卡、RESOURCES 分组、占位卡（纯函数）
src/layout/box.ts         主题化盒子、换行、distributeLines
src/layout/compose.ts     twoColumn / centerBlock / compactSplash
src/layout/metrics.ts     行列预算、splashRows、parseKittyRows
src/text/ansi.ts          转义识别、isImageLine、stripAnsi
src/text/width.ts         visibleWidth/padVisible/centerVisible（pi-tui 对等）
src/text/truncate.ts      truncateToWidth 等
src/pipeline/process.ts   无 tty spawn、preflight、gif 指纹
src/pipeline/cache.ts     缓存根、原子写 JSON、单文件删除
src/frames.ts             字符管线：gif → ffmpeg → chafa → 缓存
src/images.ts             图片管线：gif → ffmpeg → pal8 PNG → base64
src/kitty.ts              kitty 协议：编码、换 id、删除
src/resources.ts          采集 version/model/theme/context/skills/…
src/host.ts               从 pi 组件树摘除它自带的资源列表
src/{config,layout,text,banner}.ts   一层 barrel，保持旧导入路径不变
```

## 3. 硬性不变式（改任何东西都要守住）

1. **每行宽度 ≤ width**（`visibleWidth` 量），`text/width.ts` 必须与 pi-tui 对等
   （`test/text-parity.test.ts` 会拿真实实现比对）。
2. **一维字符串数组 = 一行**，元素内不许有 `\n`。
3. **chafa 参数不能省**：`--probe off`（否则等终端 DA 应答 5s 并抢 stdin）、
   `--animate off`、`--symbols solid`；**不要加 `--clear`**。
4. **`render()` 同步**：所有帧预渲染，绝不在这里 spawn。
5. **组件只做 `render`/`invalidate`/`dispose`**，不抢焦点、不做浮层。
6. **定时器 `unref()` 且 dispose 清理**；`agent_start` 暂停、`agent_end` 恢复。
7. **不写用户 settings、不改 pi dist**；配置只走 `pi-chafa-banner.json`。
7b. **对宿主组件树的改动必须纯内存、可逆、可降级**：只有 `host.ts` 摘除
   `loadedResourcesContainer` 一处，失配静默降级，`/splash off` 会 `restore()`。
8. **写盘只在 `<agent dir>/tmp/pi-chafa-banner/<sha1>/`**；临时目录按显式路径清理。
9. **降级优先于报错**：缺 chafa/ffmpeg、gif 不存在、缓存损坏、终端过窄，都退到占位卡 /
   紧凑文本 / 内置 header，并只提示一次。
10. **图片行 + 其后 `r-1` 行严格 `""` 是唯一豁免补齐/截断/居中的行组合。** 图片行尾部不许
    补空格（pi 的 `getKittyImageReservedRows` 遇 `visibleWidth > 0` 立即停止计数），续行必须是
    字面 `""`，序列必须走 `renderImage(..., { imageId, moveCursor: false })`。
11. **原生图片模式只能是「顶部整条图带 + 下方块」**，文字不能与图并排。
12. **图片永远不裁剪、不缩小**。矮终端下图片按 `images.columns x images.rows` 原样输出，让位的
    是下方 info/RESOURCES 面板（`lowerLines()` 在 `budget < MIN_BOX_ROWS` 时返回空）。原因有二：
    用户明确要求；且 `renderImage()` 注册的 placement rows 是整张图的行数，改小的 `r=`/`c=` 会让
    pi 的 reserved-row 计数与元数据失配，图片在轻微遮挡时被覆盖删除。占位卡只用于「还没有图」。
13. **resize 必须换新 `imageId` 重传**：`Banner.syncTerminalShape()` 记住 `${columns}x${rows}`，
    一变就 `fallbackImageId()` + `reassignKittyImageId()` 并清行缓存。原因：kitty 在视口变化时
    丢/挪 placement，而 pi 的 fullscreen 路径一旦认为 id 已上传就用 `a=p`（无 payload）替换我们的
    `a=T`（`tui-alt-screen.js prepareKittyScreen` + `terminal-image.js:353`）。
    换下来的旧 id **不要立刻删**：pi 的缓存仍可能对旧行发 `a=p`，数据被删就只剩空白且永不修复。
    旧 id 进 `retiredIds`，只淘汰第 4 个之前的老 id（`MAX_RETIRED_IDS = 3`）。
14. **拆卸必须释放图片**：`dispose()`/`/splash off` 遍历 `ownedIds` + `retiredIds` 逐个发
    `a=d,d=I,i=<id>,q=2`（`encodeKittyDelete()`），**禁止 `d=A`/`d=a`**。dispose 同步写，
    运行期淘汰 `setTimeout(…,0)`；宿主没有 `terminal.write` 时必须静默降级。

## 4. 两条管线

两条管线共用同一套时长计算（`pipeline/timing.ts`）：gif 没有全局帧率，每帧自带 delay，
所以 `probeGifTiming()`（ffprobe 取 pts + 容器时长）→ `aggregateDelays()`（stride 丢掉的帧，
把时长并给保留下来的那一帧，一圈总时长不变）→ `thinDelays()`（再被 maxFrames / 内存上限抽稀时
保持同样的映射）。**任何一次抽帧都必须同步抽 `delays`/`gapsMs`，否则画面会按 stride 倍速播放**。

字符画：

```
gif → sha1(path+mtime+size) → ffmpeg 抽帧（≤240）→ chafa（-c full|256 -s WxH）
    → stripChafaControl + sanitizeFrame → <cache>/<hash>/frames-<WxH>-<mode>.json
    （payload 里带 delays[]，供 component 的 setTimeout 链逐帧定时）
```

原生图片：

```
gif → preflight（只要 ffmpeg）→ 单遍抽取+scale+palettegen/paletteuse → pal8 PNG
    → stride 取样 → decimate(≤maxFrames) → base64 + gapsMs[]
    → <cache>/<hash>/images-b<cols>x<rows>-c<cellW>x<cellH>-p<palette>-s<stride>.json
    → allocateImageId() + renderImage(root, {imageId, moveCursor:false})
    → anim 模式：每个 `a=f` 用自己的 `z=<gap>`，终端按 gif 原速自播（稳态 0 B/s）
```

- 改 JSON 结构就要给 `CACHE_VERSION` / `IMAGE_CACHE_VERSION` +1。
- `imageId` **绝不落盘**（跨进程会撞）。
- 管线只按配置尺寸构建一次（高度永不随终端变化），所以矮终端/宽图都不会触发 re-encode 或缩小。
- `image.height: "auto"` 由 ffmpeg 探测真实宽高比得到——chafa 需要固定画布，kitty 网格按像素
  算，不统一两边行数就会不同。

## 5. 配置（`pi-chafa-banner.json`）

放在**扩展所在目录**（全局安装 `~/.pi/agent/`，项目内 `<project>/.pi/`）。读取顺序：只读这一
个文件，缺失键用默认值，非法值丢弃并记警告。关键键：`image.{path,width,height,fps,stride,
renderer,native.*}`（`fps` 默认 `"auto"` = 按 gif 每帧自己的 delay；写数字才会覆盖成固定帧率）、`layout.{width,gap,twoColumnMinWidth,compactMinWidth,maxWidth,lowerRows}`、
`panels.{info,resources}`、`behavior.{enabled,static,hidePiResourceList}`。完整表见 README，
schema 见 `pi-chafa-banner.schema.json`。

**不要**再加 `PI_BANNER_*` 环境变量（v2 已全部移除；只剩 `PI_CODING_AGENT_DIR` 与
`PI_IMAGE_PROTOCOL`，二者属于 pi 本身）。

## 6. 尺寸与布局阈值

- 块宽 = `min(cols - 4, min(layout.maxWidth, layout.width))`（默认 88）。
- 文档行数 = `terminalRows - CHROME_ROWS(7)`（editor 3 + footer 2 + header 上下 Spacer）。
- 双栏阈值 `layout.twoColumnMinWidth`(76)，紧凑阈值 `layout.compactMinWidth`(32)。
- 图片带：`images.rows` 行 + `IMAGE_GAP_ROWS` 个空行，恒原样；`body = splashRows(rows) - status`，
  剩余空间 `< MIN_BOX_ROWS`(5) 时面板整块略去，图片仍然完整，因此 splash 可能比 body 更高（pi 会滚动）。
- 回归办法：`preview --rows 18|20|24|30|40|50`，检查 `total-rows + CHROME_ROWS ≤ rows`。
  超出会触发 pi 的 `fullRender(true)`（清 scrollback）。

## 7. 常见改法

- **换默认图**：覆盖 `assets/banner.gif`，或改 JSON 的 `image.path`（缓存按 mtime 失效）。
- **改画布比例**：`layout.width` / `image.width`；height auto 会跟着推。
- **改边框/配色**：只动 `layout/box.ts` 的 `THIN_BOX` 与 `themePainter()` 的 token 映射。
- **加资源区块**：`layout/box.ts resourcePanel()` + `resources.ts collectResources()` +
  `config/schema.ts` 的 `RESOURCE_SECTIONS` + `banner/panels.ts sections()`。
- **加配置项**：`schema.ts`（类型+默认+limits）→ `validate.ts`（读取+警告）→
  `pi-chafa-banner.schema.json` → `test/config.test.ts`。
- **改动画节奏**：`pipeline/timing.ts`（`probeGifTiming`/`aggregateDelays`/`thinDelays`）决定每帧时长，
  `banner/component.ts frameDelay()+scheduleTick()` 按帧自调度；`image.fps` 是覆盖用的固定速率。
  保持 `unref()` 与暂停/恢复逻辑。

## 8. 已知问题 / 盲区

1. **kitty 只在真机能验收**。`PI_TUI_DEBUG_REDRAW=1 pi -e .` 看 `pi-tui-debug.log`，anim 模式下
   **不应**出现 `fullRender: first changed < viewportTop`。resize/拆卸的字节级证据用
   `/tmp/pcb-probe/pty2.py`（pty.fork + TIOCSWINSZ + SIGWINCH，分阶段抓原始流）：resize 应看到
   新 id 的 `a=T…x=0,y=…,w=…,h=…,c=…,r=…`，shutdown 应看到 `a=d,d=I`。
2. **iTerm2 未实现**（`caps.images === "iterm2"` 回退 chars）。
3. **终端忽略 `a=f/a=a`**（Ghostty 等）时只剩根帧静态图，属预期降级；
   `image.native.mode: "frames"` 是逃生阀，但每 tick 改图片行，长会话请配
   `behavior.static` 或 `animSeconds`。
4. **`types/pi-host.d.ts` / `types/pi-tui.d.ts` 是手写 shim**，会滞后于真实 API；改用法时对照
   `pi` 包的 `dist/**/*.d.ts`。`TerminalLike.write` 是可选方法。
5. **动画开销**：字符画约 21KB/帧 × 每秒帧数；图片 `anim` 稳态 0 B/s，`frames` 约 1.3MB/s。
   长会话、全屏模式、慢终端建议加大 stride（`image.stride`）或 `behavior.static: true`。
   注意**不要**用 `image.fps` 降速：它会覆盖 gif 自带时长，配合 stride 会让画面比原速快/慢。

## 9. 外部参考

- `https://github.com/danielmrdev/beautiful-pi` —— 灵感（双栏 setHeader + RESOURCES 面板）
- `https://github.com/mavam/pi-splash` —— 滚动行为、`unref()` 定时器、窄终端降级
- pi 文档：`/usr/lib/node_modules/pi/packages/coding-agent/docs/{extensions,tui,packages,cli}.md`
- pi-tui 源码：`packages/tui/dist/{tui-main-screen,tui-alt-screen,terminal-image,terminal}.js`
