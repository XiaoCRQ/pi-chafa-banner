# pi-chafa-banner

给 [pi](https://github.com/earendil-works/pi) 用的动画启动图：调用 **chafa** 把 GIF 渲染成终端字符画，塞进 pi 的启动
header —— 不是浮层，也不是聊天消息。

> 英文原版见 [README.md](README.md)，以英文为准；本文件为中文翻译，内容同步。

```
  ╭──────────────╮    ╭───────────────────── RESOURCES ─────────────────────╮
  │█▀▀▀▀█▄  ▄▀▀▀▀█│    │ [Context]                                           │
  │█ ▄▀▄ █  █ ▄▀▄ █│    │   AGENTS.md, ~/.pi/agent/AGENTS.md                   │
  │█▄▀▀▀▄█  █▄▀▀▀▄█│    │ [Skills]                                            │
  │ ▀▀▀▀▀    ▀▀▀▀▀ │    │   btw, workflow-authoring, workflow-patterns         │
  │                │    │ [Themes]                                            │
  │ (image frames) │    │   dark, light                                       │
  │                │    │ [Extensions]                                        │
  │                │    │   pi-btw, pi-chafa-banner                           │
  │                │    │                                                     │
  │                │    │                                                     │
  ╭─ (pi) CODING ─╮    │                                                     │
  │ version  1.5.2 │    │                                                     │
  │ model    claude│    │                                                     │
  │ theme    dark  │    │                                                     │
  ╰────────────────╯    ╰─────────────────────────────────────────────────────╯
```

左列是由 `chafa` 把 GIF 逐帧转成的字符画（每个 tick 换一帧），下方是一张小的信息卡；右列列出上下文文件、skills、
themes 与 extensions。启动画面下方**没有** pi 自己那份重复的 `[Context]/[Skills]/…` 列表——已被摘掉（见下节）。

## 只显示一份资源列表

pi 会在 header 下面再打印一份自己的 `[Context] / [Skills] / [Themes] / [Extensions]` 摘要，它位于
`documentContainer` 中紧跟 `headerContainer` 的 `loadedResourcesContainer` 里。splash 已经把这些信息都画出来了，所以扩展在
header 挂载时把这个容器从运行时组件树里摘掉：

- **只在内存里做**：不写任何文件、不打 dist 补丁、不留任何持久状态；重启 pi 即恢复原样；
- `/splash off` 会把它按原索引插回去，pi 的原始启动画面完整还原；
- `PI_BANNER_HIDE_RESOURCES=0` 则完全不动 pi 的列表；
- 如果将来 pi 改了内部结构导致摘除失败，也只是静默降级（列表继续显示），`/splash status` 会报告
  `listing visible — detach failed; set "quietStartup": true in pi settings instead`。

定位原理：`ctx.ui.setHeader()` 会把真实的 `tui` 根节点交给工厂函数，pi-tui 的容器都暴露 `children` / `removeChild`，而
`documentContainer` 里 header 容器后面紧跟的就是资源列表容器。`src/host.ts` 全部用 duck-typing，结构不符时降级而不抛错。

## 为什么用 header？

`ctx.ui.setHeader()` 替换的是 `headerContainer` 里的内置 header，而它本身就是文档流的一个普通子节点。因此可以白拿这些好处：

- splash 待在**对话记录的最顶部**，随对话增长自然滚入 scrollback（没有浮层、不抢输入、永不阻塞发消息）；
- 重载/退出时 pi 会自动 dispose 旧 header，不会漏定时器；
- `quietStartup` 隐藏默认 logo 时，splash 依然工作。

## 依赖

| 工具 | 用途 | 版本 |
| --- | --- | --- |
| `chafa` | GIF 帧 → ANSI 字符画 | ≥ 1.10（需要 `--symbols solid`、`--probe`） |
| `ffmpeg` | GIF → PNG 帧 | 任意较新版本（`-fps_mode` 或 `-vsync`） |
| `pi` | 宿主 | 1.5.x |

两个二进制在启动时都会探测。缺任意一个时 splash 降级成带边框的 `IMAGE unavailable: …` 卡片 + 一次警告，pi 本身照常工作。

## 安装 / 试用

```bash
# 不安装，直接试用
cd /home/XiaoCRQ/Work/Program/Project/pi-chafa-banner
pi -e .

# 或者把 pi 指向任意 checkout
pi -e /path/to/pi-chafa-banner
```

图片随包分发在 `assets/banner.gif`（来源是 `~/Pictures/logo/v-1.gif` 的一份拷贝），所以 clone 下来就能出图。想换成自己的图：
覆盖 `assets/banner.gif`，或用 `PI_BANNER_GIF` 指向任意 `.gif`（见[配置](#配置)）；路径是每个进程解析的，无需重新构建或安装。

仓库里还有一个给用户用的测试脚本：设置环境变量、打印生效的开关，然后从仓库根目录启动 pi：

```bash
cd /home/XiaoCRQ/Work/Program/Project/pi-chafa-banner
bash scripts/demo.sh                 # 默认参数，带动画
bash scripts/demo.sh --static        # 单帧，不启动定时器
bash scripts/demo.sh --fps 12        # 慢一点
bash scripts/demo.sh --size 60x30    # 更大的画布
bash scripts/demo.sh --gif ~/Pictures/logo/v-1.gif   # 换一张 gif
```

`demo.sh` 只启动交互式 pi（用 `/exit` 或 Ctrl-C 退出），从不安装任何东西。`pi` 不在 `PATH` 上时会以 127 退出并给出提示。

作为包分发（参见 pi 的 `docs/packages.md`），manifest 已经是正确的：

```json
{ "pi": { "extensions": ["./src/index.ts"] } }
```

没有构建步骤：pi 用 jiti 直接加载 TypeScript。

## 不启动 pi 也能预览

`scripts/preview.ts` 是调参用的快速回路。它跑真实的 gif → ffmpeg → chafa → ANSI → layout 管线，但把 `TUI` 和 `Theme`
替换成桩对象，所以不涉及 pi 进程，也不调模型：

```bash
bun run scripts/preview.ts                        # 单帧，100 列
bun run scripts/preview.ts --static --width 100   # CI 冒烟测试
bun run scripts/preview.ts --width 60             # 窄屏/堆叠布局
bun run scripts/preview.ts --frames 5             # 打印 5 帧动画
bun run scripts/preview.ts --anim --fps 12        # 原地循环，Ctrl-C 停止
bun run scripts/preview.ts --size 30x15           # 更小的 chafa 画布
bun run scripts/preview.ts --no-frames            # 占位/降级卡片
bun run scripts/preview.ts --plain                # 无色输出（可 diff）
PI_IMAGE_PROTOCOL=kitty bun run scripts/preview.ts --static   # 走原生 kitty 图带（隐含 --image）
bun run scripts/preview.ts --image --size 44x22   # 同上，显式 flag
```

字符画写 stdout，诊断信息（帧数、缓存命中、耗时）写 stderr，所以 `bun run scripts/preview.ts > preview.txt` 的输出是干净的。
缺 `chafa`/`ffmpeg` 时以 `2` 退出并给出安装提示，gif 读不了时以 `1` 退出；`--no-frames` 可以绕开这两个工具。资源信息默认是确定性
桩数据，除非传 `--real-resources`，这样预览在不同机器间可 diff。

## 配置

全部走环境变量 —— 不写、不读任何 settings 文件。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PI_BANNER_GIF` | 包内 `assets/banner.gif`，否则 `~/.pi/agent/banner.gif`，否则 `~/Pictures/logo/v-1.gif` | 要动画的 GIF（绝对路径，或相对当前目录） |
| `PI_BANNER_SIZE` | `44x22` | 画布上限，`宽x高`（宽 8–160，高 4–60）；图片模式下它是字符网格的上限 |
| `PI_BANNER_FPS` | `16` | 动画帧率（1–30） |
| `PI_BANNER_STRIDE` | `3` | 每 N 帧 GIF 取一帧（1–10）；57 帧 ÷ 3 = 保留 19 帧 |
| `PI_BANNER_RENDERER` | `auto` | `auto` \| `chars` \| `kitty`；`auto` 在终端支持时用原生图带，显式 `kitty` 用不了时会解释一次 |
| `PI_BANNER_STATIC` | 关 | `1` = 只渲染一帧，不启动定时器 |
| `PI_BANNER_KITTY_MODE` | `anim` | `anim` = 终端自己循环播放（稳态 0 B/s）；`frames` = 每 tick 重传一帧（≈1.3 MB/s，给忽略动画的终端用；header 滚出视口后代价极高，见「实现要点」） |
| `PI_BANNER_PALETTE` | `128` | PNG 调色板：16 / 32 / 64 / 128 / 256 色（向下取整到允许值） |
| `PI_BANNER_MAX_PX` | `640000` | 单帧像素上限，超出则缩小网格（10 000–4 000 000） |
| `PI_BANNER_MAX_FRAMES` | `24` | 抽稀后保留的帧数（1–120） |
| `PI_BANNER_ANIM_SECONDS` | `0` | `0` = 永久循环；`>0` = N 秒后冻结成静图（`anim` 模式下这会付出一次重传代价） |
| `PI_BANNER_HIDE_RESOURCES` | 开 | `0` = 保留 pi 自己的 `[Context]/[Skills]/…` 列表 |
| `PI_BANNER_DISABLED` | 关 | `1` = 完全不安装 header |

尺寸计算：整块宽度是 `min(终端列数 - 4, 108)`。双列需要 ≥ 76 列且右侧面板至少剩 28 列；低于该宽度改为上下堆叠（图、信息卡、
资源面板），低于 32 列则退化成三行文本 splash。

可用高度是 `终端行数 - CHROME_ROWS`（`CHROME_ROWS = 7`：editor 3 行 + footer 2 行 + header 上下各 1 个空行），不是整屏高度；
超出这个预算会让图片顶部滚出视口，进而触发 pi 的全屏重绘（连 scrollback 一起清）。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/splash on` | 安装/重新显示 header（缺帧时自动重建） |
| `/splash off` | 恢复 pi 的内置 header 和它的资源列表 |
| `/splash freeze` | 冻结当前帧（开关） |
| `/splash rebuild` | 丢弃帧缓存并重跑 ffmpeg + chafa |
| `/splash size 60x30` | 改画布，清掉该尺寸的缓存并重建 |
| `/splash status` | 生效配置、帧数、缓存命中、工具版本、pi 列表是否已摘除 |

## 工作原理

```
src/
  index.ts      扩展入口：session_start → setHeader，/splash，agent_start/end 暂停，
                before_agent_start → 用解析后的 system prompt 刷新资源
  host.ts       定位并摘除 pi 的 loadedResourcesContainer，避免资源列表显示两遍
  banner.ts     组件本体：render(width) 用缓存的字符串拼出 splash；
                setInterval 推进帧号 → invalidate() + tui.requestRender()
  layout.ts     纯排版：panel()、infoBox()、resourcePanel()、twoColumn()、居中，
                名字按 ", ..." 溢出的折行；无 I/O，可用桩 Painter 单测
  frames.ts     preflight(chafa, ffmpeg)、gif 哈希、ffmpeg 抽帧、chafa 渲染、
                ANSI 清洗、磁盘缓存读写、帧取样
  resources.ts  采集 version / model / theme / context / skills / themes / extensions
  text.ts       ANSI 感知的 visibleWidth / truncateToWidth / padVisible / centerVisible
types/
  pi-host.d.ts  pi 宿主 API 的环境声明 shim（见「备注」）
```

几个不明显但重要的点：

- **chafa 参数。** `-f symbols --symbols solid --probe off --animate off -c full|256 -s WxH`。`--probe off` 是必需的：
  否则 chafa 会等终端 DA 应答最多 5 秒，并抢走 pi 的 stdin。`--symbols solid` 只输出前景色块，因此 header 不会绘制背景，
  图片周围的主题色保持不变。
- **ANSI 清洗。** chafa 会用 `ESC[?25l`/`ESC[?25h` 包裹输出，（带 `--clear` 时）还有 `ESC[2J`/`ESC[0H`。这些会和 pi 的渲染器
  打架，所以全部剥掉——SGR 颜色序列（也就是图像本身）保留。
- **异步构建 + 占位。** `render()` 是同步的，所以帧只构建一次、在事件循环之外完成，并缓存在内存里。在帧到达之前，用同样高度的
  `IMAGE` 卡片占位。
- **流式期间暂停。** `agent_start` 停表，`agent_end` 恢复；pi 每来一个 token 都要重绘文档，再叠加 16fps 的 splash 只会卡。
- **磁盘缓存。** `~/.pi/agent/tmp/pi-chafa-banner/<sha1(gif 路径 + mtime + size)>/frames-<WxH>-<颜色模式>.json`，
  原子写入（临时文件 + rename）。读缓存失败时静默重建。`PI_CODING_AGENT_DIR` 会被尊重。
- **ffmpeg 兼容。** ffmpeg 8 用 `-fps_mode passthrough` 取代了 `-vsync 0`；抽帧逻辑依次尝试新写法、旧写法、不带参数。
- **不重复资源列表。** `render()` 不绘制 pi 的 `[Context]/[Skills]/…` 区块；由 `host.ts` 在运行时把 pi 自己那份摘掉，
  `/splash off` 时再插回来。
- **资源刷新。** `before_agent_start` 会给我们解析后的 `contextFiles` 与 `skills`，这是它们唯一权威的时点；面板在下一轮更新，
  无需重启 pi。

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `IMAGE unavailable: missing chafa, ffmpeg on PATH` | 两个都装上：`apt install chafa ffmpeg` / `brew install chafa ffmpeg`，然后 `/splash rebuild` |
| `IMAGE unavailable: cannot read <path>: ENOENT` | `PI_BANNER_GIF` 指向不存在的文件，或包内 `assets/banner.gif` 被删了：恢复它，或把 gif 放到 `~/.pi/agent/banner.gif` |
| `preview: missing required tool …`（退出码 2） | 同上；或用 `--no-frames` 预览降级画面 |
| 改了 gif 但字符画没变 | 缓存键是 `sha1(path + mtime + size)`；`/splash rebuild` 或 touch 该文件 |
| 图太大 / 被裁 | 调小 `PI_BANNER_SIZE`（例如 `40x18`）或把终端拉高；矮终端会从顶部裁剪 |
| 动画卡顿 | 调低 `PI_BANNER_FPS`（16 → 8）或调大 `PI_BANNER_STRIDE`；agent 流式输出期间定时器本来就会暂停 |
| 完全没有 splash | 确认 `PI_BANNER_DISABLED` 未设置、`ctx.mode === "tui"`，并运行 `/splash status` |
| 预览指定首帧 | `--frame N`，或 `--frames N` 看一组 |

### 降级策略

| 情况 | 行为 |
| --- | --- |
| 缺 `chafa`/`ffmpeg` | 信息卡 + 资源面板，`IMAGE unavailable: missing … on PATH`，一次警告 |
| GIF 缺失/不可读 | 同上，错误文本为 `cannot read <path>: ENOENT` |
| 终端 < 32 列 | 三行文本 splash（`π pi 1.5.2` / model / theme） |
| 终端 < 76 列 | 竖向堆叠：图、信息卡、资源面板 |
| 终端矮到 `行数 - CHROME_ROWS` 装不下「图 + gap + 下块」 | 先把下块缩成信息卡，再退化为 `IMAGE` 卡 |
| `PI_BANNER_STATIC=1` | 单帧，无 interval，不调用 `requestRender` |
| 图带装不下（终端太矮/太窄） | 5 行 `IMAGE` 卡，信息卡与面板照常显示，并做一次防抖重编码 |
| 图片模式缺 `ffmpeg` | `IMAGE unavailable: …` 卡 + 一次警告，不会退回字符帧 |
| 非 TUI 模式（`pi -p`、RPC） | 扩展什么都不做（`ctx.mode !== "tui"`） |

## 原生图像（kitty）

`PI_BANNER_RENDERER=auto`（默认）在 `getCapabilities().images === "kitty"` 时切到原生像素；`chars` 永远可用，且与加图之前的版本逐字节一致。

它是怎么塞进 pi 的「一行一个字符串」模型的 —— 这段约束决定了其它一切：

- 图片独占顶部整条**图带**。旁边不能放任何东西：pi 的 `getKittyImageReservedRows` 遇到第一条 `visibleWidth > 0` 的行立刻停止计数，
  而一个空格就已经 > 0。
- 只有一行携带转义序列：`padding + <kitty 序列>`。其后**恰好 `rows - 1` 行必须是字面空串 `""`**，然后一行空 gap，再是信息卡与
  RESOURCES 面板。
- 序列来自 pi-tui 的 `renderImage(..., { imageId, moveCursor: false })`：`imageId` 打开 placement 元数据（全屏裁剪才有效），
  `moveCursor: false`（`C=1`）表示光标由我们自己挪，也就是那 `rows - 1` 个空行。
- 帧是量化后的 PNG（ffmpeg → `palettegen`/`paletteuse`），编码一次后写入
  `~/.pi/agent/tmp/pi-chafa-banner/<sha1>/images-*.json`。kitty image id **从不落盘**，每个进程重新分配。
- `anim` 模式只发一条恒定行（根帧 + 各帧 `a=a` 数据 + 启动指令），终端自己播，pi 看不到 diff；`frames` 模式是逃生阀。
- **`frames` 模式在 header 滚出视口后代价极高。** 每 tick 都会改 image 行，`firstChanged` 落在 header 里；一旦图片锚点位于
  `viewportTop` 之上，pi 的 main-screen renderer 就走 `fullRender(true)`（`\x1b[2J\x1b[3J`，连 scrollback 一起清）并重传整帧。
  只在终端确实忽略动画时开它，长会话请配 `PI_BANNER_STATIC=1` 或 `PI_BANNER_ANIM_SECONDS`。
- **帧头必须带 `f=100`。** kitty 的 `a=f` 不继承根图格式（`uint32_t fmt = g->format ? g->format : RGBA;`），缺了会把 PNG
  按 raw RGBA 校验并整帧丢弃，`q=2` 把错误吞掉，表现为「只有静止首帧」。
- **矮终端只裁剪，不降级。** `planImageBand()`（`src/layout.ts`）把源矩形（`x=/y=/w=/h=`）与字符网格（`c=/r=`）一起缩小，
  向上偏 1/3（避免居中裁切断人脸），所以窗口再小也能看到真实像素；`IMAGE` 占位卡只用于「还没有图」。
- **resize 会换新 image id 重传。** kitty 在视口变化时可能丢/挪 placement，而 pi 的 fullscreen 路径只要认为该 id 已上传，就会用
  `a=p`（只放置、不带 payload）顶掉我们的 `a=T`；`Banner.syncTerminalShape()` 因此在每次尺寸变化时把序列重定向到新 id，
  强制完整重传，随后释放旧 id。
- **拆卸会删除图片。** `dispose()` / `/splash off` / 重建换 id 都发 `a=d,d=I,i=<id>,q=2`（只针对自己的 id，绝不用 `d=A`）：
  kitty 图片的生命周期比 pi 进程长，不删就会在退出后继续在 shell 上动。

图片模式下 `PI_BANNER_SIZE` 限制的是字符网格而不是像素：PNG 按 `列数 × cellWidth` × `行数 × cellHeight` 编码，再经 `renderImage`
回读，保证预留行数与终端实际绘制一致。

## 测试

```bash
bun install
bunx tsc --noEmit                # 严格类型检查
bun test                         # 所有用例必须绿（不写死数字，看输出）
bun run preview:static --width 100
bun run preview --width 60 --plain
bun run preview --no-frames
bash scripts/demo.sh --static    # 真实 pi，交互式
```

`tests/layout.test.ts` 在 40/60/80/100/140 列下合成整块 splash，断言每行都不超宽、块的包围盒居中（误差 1 列以内）、窄宽度会堆叠、
框标题居中。`tests/frames.test.ts` 覆盖 ANSI 清洗（控制序列被剥掉、SGR 保留）、精确的 WxH 规范化，以及缓存键随 gif mtime、
画布尺寸、色深变化。旧的 `test/` 套件覆盖文本工具、配置解析、帧管线、Banner 组件、扩展接线，以及 `host.ts` 的组件树手术
（在类 `tui` 的根上找到 header 容器、摘除/恢复列表、敌意输入不抛错）。

`preview.ts` 会伪造 `TUI` 和 `Theme`，并且（除非 `--no-frames`）把真实的 ffmpeg/chafa 管线跑进一个临时 `PI_CODING_AGENT_DIR`。
真实管线也由 `test/frames.test.ts` 覆盖（16x8、stride 30 → 两次 chafa 调用；工具或演示 GIF 缺失时跳过）。

扩展能不能被 pi 加载？非交互式检查（pi 即使扩展加载失败也返回 0，所以要 grep 输出）：

```bash
pi --list-models --offline -e . | grep -E "Failed to load extension|Extension package"
```

没有输出 = 加载干净。

## 备注

- **`types/pi-host.d.ts`。** pi 在运行时把 `@earendil-works/pi-coding-agent` 和 `-pi-tui` 别名到它自己的副本，而本包不能依赖它们。
  为了让 `tsc --noEmit` 和裸 `bun test` 在不安装宿主的情况下也能跑，我们用到的少量 API 以环境声明的方式写在这个文件里。升级 pi 后
  需要更多 API 时，扩展这个文件，而不是新增依赖。
- **`src/text.ts` 而不是 `@earendil-works/pi-tui`。** 契约相同（`visibleWidth`、`truncateToWidth`），但能在 pi 进程之外 import，
  让布局测试和 `preview.ts` 保持零依赖。
- **不碰 `quietStartup`。** 扩展从不修改 `~/.pi/agent/settings.json`；如果你更想用 pi 自己的开关关掉启动输出，可以自己设
  `"quietStartup": true`（同时去掉 header 与资源列表）或 `"header"`（保留 header、去掉列表）。
- **万一摘除失败**（pi 改了组件树），也不会坏：splash 照常渲染，pi 的列表在下面显示，`/splash status` 会告诉你属于哪种情况。
  设置 `PI_BANNER_HIDE_RESOURCES=0` 可整体关掉这套机制。
- **不会写到**缓存目录和 `mkdtemp` 工作区之外（两者都按显式路径清理）。
