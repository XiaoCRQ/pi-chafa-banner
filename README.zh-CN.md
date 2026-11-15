# pi-chafa-banner

给 [pi](https://github.com/earendil-works/pi) 的启动 header 加一张会动的图：用
[chafa](https://hpjansson.org/chafa/) 把 GIF 渲染成字符画放在左上，下面接
coding-agent 信息卡，右侧是 resources 面板。

```
        ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄         ╭──────────── RESOURCES ────────────╮
        ███ chafa 渲染的 gif，逐帧播放 ███        │ [Context]                        │
        ████████████████████████████████         │   ~/work/app/AGENTS.md           │
        ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀         │ [Skills]                         │
       ╭──────── (pi) CODING AGENT ────────╮        │   workflow-authoring             │
       │ version  3.0.0                    │        │ [Extensions]                     │
       │ model    claude-sonnet-4.5        │        │   pi-chafa-banner                │
       ╰───────────────────────────────────╯        ╰──────────────────────────────────╯
```

splash 由 `ctx.ui.setHeader()` 安装，属于文档流：随对话上滚，不抢输入、不遮挡编辑器。
`/splash off` 会换回 pi 自带的 header。

## 快速开始

```bash
cd ~/.pi/agent
git clone <本仓库> pi-chafa-banner          # 或用 pi install <包名>
```

然后在 pi 的 settings 里加上：

```json
{ "extensions": ["~/.pi/agent/pi-chafa-banner/src/index.ts"] }
```

依赖：`chafa` 和 `ffmpeg` 在 `PATH` 上（`/splash status` 会打印检测结果）。
没有配置文件时使用包内自带的图。

不启动 pi 也能看排版：

```bash
bun run scripts/preview.ts --width 100        # 字符画，带颜色
bun run scripts/preview.ts --width 60         # 窄终端，上下堆叠
```

## 配置

配置文件是 `pi-chafa-banner.json`，**放在扩展旁边**——全局安装在
`~/.pi/agent/pi-chafa-banner.json`，项目安装在 `<项目>/.pi/pi-chafa-banner.json`。
文件不存在、缺某个键、或值非法，都只影响那一个键（回退默认值），`/splash status`
会列出所有警告。

```json
{
  "image": {
    "path": "~/Pictures/logo/v-3.gif",
    "fps": "auto",
    "stride": 3,
    "chafa": "--symbols block"
  },
  "layout": { "width": 88, "gap": 2 },
  "panels": { "info": { "fields": ["version", "model", "theme"] } }
}
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `image.path` | `~/Pictures/logo/v-3.gif`，找不到用包内图 | 要播放的 GIF（展开 `~`） |
| `image.fps` / `image.stride` | `"auto"` / `3` | `"auto"` = 用 GIF 自己的每帧延时；`stride` = 每 N 帧取 1 帧 |
| `image.chafa` | `""` | 额外的 chafa 参数，一个字符串，如 `"--symbols block -c 16"` |
| `layout.width` / `layout.gap` | `88` / `2` | 整体宽度；两列等分，字符画尺寸由它推导 |
| `layout.twoColumnMinWidth` / `compactMinWidth` | `76` / `32` | 低于前者改为上下堆叠，低于后者退化成三行 |
| `panels.info.enabled` / `.fields` | `true` / version, model, theme | 还可选 `gif`、`frames` |
| `panels.resources.enabled` / `.sections` | `true` / 四项全开 | `context`、`skills`、`themes`、`extensions` |
| `panels.resources.maxLinesPerSection` | `6` | 每个分类最多显示几行，超出用 `…` |
| `panels.resources.width` / `.height` | `"auto"` / `"auto"` | 双栏时忽略：面板宽度恒等于图片列宽度 |
| `behavior.enabled` / `.static` / `.hidePiResourceList` | `true` / `false` / `true` | 总开关、冻结成静图、隐藏 pi 自带的资源列表 |

`image.chafa` 里的 `--probe`、`--animate`、`--clear` 会被丢弃：第一个会让 chafa
等终端应答并抢走 pi 的 stdin，第二个会破坏逐帧输出，第三个会清屏。
`pi-chafa-banner.schema.json` 描述全部键，编辑器可直接补全。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/splash off` / `on` | 换回 pi 自带 header / 重新装上 splash |
| `/splash freeze` | 冻结当前帧（再执行一次恢复） |
| `/splash rebuild` | 重跑管线并刷新缓存 |
| `/splash reload` | 重新读取 `pi-chafa-banner.json` 并重建 |
| `/splash status` | 生效配置、缓存状态、工具检测、配置警告 |

## 致谢

- [beautiful-pi](https://github.com/danielmrdev/beautiful-pi)（MIT）：`setHeader`
  双栏 + `RESOURCES` 面板的灵感来源，未复制代码。
- [chafa](https://hpjansson.org/chafa/) 负责渲染字符画，`ffmpeg` 负责抽帧，
  [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi) 提供排版所用的宽度表。

模块划分、数据流与不变式见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
原生 kitty 图片版本保留在 `archive/kitty-native-images` 分支，留待以后实现。
English: [README.md](README.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。
