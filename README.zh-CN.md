# pi-chafa-banner

给 [pi](https://github.com/earendil-works/pi) 的启动 header 加一张会动的图：左边是你的
GIF，右边是模型 / 上下文 / Skills。普通终端用 [chafa](https://hpjansson.org/chafa/)
渲染成字符画，支持 kitty 图形协议的终端直接显示**原图**。

```
╭──────────────── (pi) CODING AGENT ────────────────╮╭──────────────── RESOURCES ────────────────╮
│ version  2.0.0                                    ││ [Context]                                 │
│ model    claude-sonnet-4.5                        ││   ~/work/app/AGENTS.md                    │
│ theme    system/dark                              ││ [Skills]                                  │
╰───────────────────────────────────────────────────╯╰───────────────────────────────────────────╯
```

它是用 `ctx.ui.setHeader()` 装上去的，所以图属于文档流：随对话往上滚，不抢焦点、不盖住
编辑器，会话结束时和 pi 自带 header 一起消失。

## 快速开始

```bash
cd ~/.pi/agent                       # pi 查找包的目录
git clone <本仓库> pi-chafa-banner
# 在 pi 的 settings 里加：
#   { "extensions": ["~/.pi/agent/pi-chafa-banner/src/index.ts"] }

pi                                    # 启动即可在 header 看到 splash
```

依赖：两种渲染器都需要 `ffmpeg`；不在 kitty 类终端时还需要 `chafa`（`/splash status`
会打印检测结果）。支持的终端（kitty、Ghostty、WezTerm、Konsole 等）走原生图片，其余走
chafa 字符画。

不写任何配置时使用包内自带的 `assets/banner.gif`。不启动 pi 也能看排版：

```bash
bun run scripts/preview.ts --width 100            # 字符画模式
bun run scripts/preview.ts --image --width 100    # 图片带模式
```

## 配置

在**扩展所在目录**放一个 `pi-chafa-banner.json`（全局安装即 `~/.pi/agent/`，项目内安装即
`<项目>/.pi/`）。文件不存在、某个键缺失、值非法，都只是该键回退默认值，不会报错；
`/splash status` 会列出被忽略的项。

```json
{
  "version": 1,
  "image": {
    "path": "~/Pictures/logo/v-3.gif",
    "width": 44,
    "height": "auto",
    "renderer": "auto"
  },
  "panels": {
    "info": { "fields": ["version", "model", "theme"] },
    "resources": { "sections": ["context", "skills", "extensions"] }
  }
}
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `image.path` | 包内自带图 | 要播放的 GIF（支持 `~`） |
| `image.width` / `image.height` | `44` / `"auto"` | 图片尺寸（字符格）；`"auto"` 按 GIF 宽高比推导 |
| `image.fps` / `image.stride` | `"auto"` / `3` | 播放速度（`"auto"` = 按 gif 每帧自己的时长）/ 每 N 帧取一帧 |
| `image.renderer` | `"auto"` | `auto` 在终端支持时用原生图片 |
| `image.native.mode` | `"anim"` | `anim` 交给终端自己循环；`frames` 每帧重传（兼容性逃生口） |
| `image.native.palette` | `128` | 量化色数（16–256） |
| `layout.width` / `layout.gap` | `88` / `4` | 整体宽度 / 两个面板之间的间隔 |
| `panels.info.fields` | `["version","model","theme"]` | 可选 `version`、`model`、`theme`、`gif`、`frames`、`renderer` |
| `panels.resources.sections` | 全部四块 | 可选 `context`、`skills`、`themes`、`extensions` |
| `panels.resources.width` / `height` | `"auto"` | 固定面板宽度，或按内容自适应 |
| `behavior.static` / `behavior.enabled` | `false` / `true` | 冻结成静图 / 完全关闭 |

`pi-chafa-banner.schema.json` 覆盖所有键（编辑器可自动补全），
`pi-chafa-banner.example.json` 是一份完整可用的示例。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/splash off` / `on` | 恢复 pi 自带 header / 重新打开 splash |
| `/splash freeze` | 冻结当前帧（再执行一次恢复播放） |
| `/splash rebuild` | 重跑管线并刷新缓存 |
| `/splash reload` | 重新读取 `pi-chafa-banner.json` 并重建 |
| `/splash status` | 生效配置、缓存状态、检测到的工具 |

## 致谢

- 灵感来源 [beautiful-pi](https://github.com/danielmrdev/beautiful-pi)（MIT）：双栏
  `setHeader` splash + `RESOURCES` 面板的思路。未复制代码，边框绘制与行分配均为独立实现。
- [pi-splash](https://github.com/mavam/pi-splash)（MIT）：滚动行为、`unref()` 定时器纪律、
  窄终端降级思路受其启发。同样未复制代码，逐项说明见 `docs/ARCHITECTURE.md`。
- [chafa](https://hpjansson.org/chafa/) 负责字符画，`ffmpeg` 负责抽帧与量化，
  [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi) 提供 kitty/iTerm2 编码、
  单元格尺寸与宽度表。

实现细节、模块划分与渲染器依赖的不变式：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
English: [README.md](README.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。
