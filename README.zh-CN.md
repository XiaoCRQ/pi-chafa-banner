# pi-chafa-banner

把一张喜欢的 GIF 变成终端里的字符画，安稳地摆在 [pi](https://github.com/earendil-works/pi)
的启动页——它会跟着对话一起往上滚，不抢焦点，也不碰你的键盘。

```
        ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄         ╭──────────── RESOURCES ────────────╮
        ███ chafa 渲染出来的那一帧 ███████         │ [Context]                        │
        ███ 一次只画一帧 █████████████████         │   ~/work/app/AGENTS.md           │
        ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀         │ [Skills]                         │
       ╭──────── (pi) CODING AGENT ────────╮        │   workflow-authoring             │
       │ version  1.0.0                    │        │ [Extensions]                     │
       │ model    claude-sonnet-4.5        │        │   pi-chafa-banner                │
       ╰───────────────────────────────────╯        ╰──────────────────────────────────╯
```

## 快速开始

```bash
cd ~/.pi/agent
git clone <本仓库> pi-chafa-banner        # 或者：pi install <包名>
```

然后在 pi 的设置里加上它：

```json
{ "extensions": ["~/.pi/agent/pi-chafa-banner/src/index.ts"] }
```

需要 `chafa` 和 `ffmpeg` 在 `PATH` 里（`/splash status` 会告诉你找到没找到）。
没有配置文件也没关系，包内自带一张图。

不想启动 pi、只想先看看排版？有个预览器：

```bash
bun run scripts/preview.ts --width 100        # 字符画，带颜色
bun run scripts/preview.ts --width 60         # 窄终端，上下堆叠
```

## 配置

把 `pi-chafa-banner.json` 放在扩展旁边就行：全局安装是
`~/.pi/agent/pi-chafa-banner.json`，装进项目则是
`<项目>/.pi/pi-chafa-banner.json`。

每个键都可以不写——文件缺失、键缺失、写错类型、数值离谱，都只会退回那一项的
默认值，`/splash status` 会列出它忽略了哪些。

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
| `image.path` | `~/Pictures/logo/v-3.gif`，找不到用包内图 | 要播放的 GIF（会展开 `~`） |
| `image.fps` / `image.stride` | `"auto"` / `3` | `"auto"` 按 GIF 自己的节奏播；`stride` 是每 N 帧取 1 帧 |
| `image.chafa` | `""` | 额外的 chafa 参数，一个字符串，比如 `"--symbols block -c 16"` |
| `layout.width` / `layout.gap` | `88` / `2` | 整体宽度；两列等分，字符画尺寸跟着推导，不用单独配 |
| `layout.twoColumnMinWidth` / `compactMinWidth` | `76` / `32` | 窄于前者改成上下堆叠，窄于后者退化成三行 |
| `panels.info.enabled` / `.fields` | `true` / version, model, theme | 还能加 `gif`、`frames` |
| `panels.resources.enabled` / `.sections` | `true` / 四项全开 | `context`、`skills`、`themes`、`extensions` |
| `panels.resources.maxLinesPerSection` | `6` | 每个分类最多几行，超出用 `…` 收尾 |
| `panels.resources.width` / `.height` | `"auto"` / `"auto"` | 双栏时忽略：面板宽度恒等于图片列 |
| `behavior.enabled` / `.static` / `.hidePiResourceList` | `true` / `false` / `true` | 总开关、冻结成静图、隐藏 pi 自带的资源列表 |

`image.chafa` 里有三个参数会被悄悄丢掉：`--probe`（chafa 会等终端应答，抢走
pi 的 stdin）、`--animate`（会破坏一帧一帧的输出）、`--clear`（会清屏）。
想让你编辑器补全这些键，旁边还有 `pi-chafa-banner.schema.json`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/splash off` / `on` | 把 header 还给 pi / 再拿回来 |
| `/splash freeze` | 停在当前这一帧——再按一次继续播 |
| `/splash rebuild` | 重跑一遍管线，重写缓存 |
| `/splash reload` | 重新读 `pi-chafa-banner.json` 并重建 |
| `/splash status` | 生效的配置、缓存状态、检测到的工具、警告 |

## 致谢

- 灵感来源：[beautiful-pi](https://github.com/danielmrdev/beautiful-pi)——用
  `setHeader` 做带 `RESOURCES` 面板的启动页。
- 依赖：[chafa](https://hpjansson.org/chafa/) 渲染字符画，`ffmpeg` 抽帧，
  [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi) 提供宽度表。

想了解实现：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 里有模块划分、数据流和
不变式。kitty 原生图片版本留在 `archive/kitty-native-images` 分支，等以后再说。
English: [README.md](README.md)。

MIT 许可，见 [LICENSE](LICENSE)。
