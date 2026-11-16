# pi-chafa-banner

[![npm](https://img.shields.io/npm/v/pi-chafa-banner)](https://www.npmjs.com/package/pi-chafa-banner)

把一张喜欢的 GIF 变成终端里的字符画，安稳地摆在 [pi](https://github.com/earendil-works/pi)
的启动页——它会跟着对话一起往上滚，不抢焦点，也不碰你的键盘。

![pi-chafa-banner 在 pi 里的样子：左上 chafa 字符画，下面是信息卡，右侧资源面板](https://raw.githubusercontent.com/XiaoCRQ/pi-chafa-banner/main/assets/preview.png)

<sub>真机截图：左边字符画、下面 <code>CODING AGENT</code>、右侧资源面板——示例用的是 tokyonight 配色。</sub>

## 快速开始

按 pi 包的方式安装，npm 上的包名叫
[`pi-chafa-banner`](https://www.npmjs.com/package/pi-chafa-banner)：

```bash
pi install npm:pi-chafa-banner        # 写进 ~/.pi/agent/settings.json
pi -e npm:pi-chafa-banner             # 或者只跑一次试试
```

需要 `chafa` 和 `ffmpeg` 在 `PATH` 里（`/splash status` 会告诉你找到没找到）。
没有配置文件也没关系：先找 `~/Pictures/logo/v-3.gif`，再找
`~/Pictures/logo/v-1.gif`，都没有才用包内自带的那张图。

想改代码？把它克隆到 pi 的扩展目录旁边：

```bash
git clone https://github.com/XiaoCRQ/pi-chafa-banner ~/.pi/agent/pi-chafa-banner
cd ~/.pi/agent/pi-chafa-banner && bun install
```

然后在 pi 的设置里加上它：

```json
{ "extensions": ["~/.pi/agent/pi-chafa-banner/src/index.ts"] }
```

不想启动 pi、只想先看看排版？有个预览器：

```bash
bun run scripts/preview.ts --width 100                     # 字符画，带颜色
bun run scripts/preview.ts --width 60                      # 窄终端，不改配置
bun run scripts/preview.ts --static --theme pi             # 跟随 pi 主题 token
```

`bash scripts/demo.sh --preview` 会先打印用到的配置文件再走预览；`bash scripts/demo.sh`
则用 `pi --no-extensions -e .` 启动 pi——**只加载这个 banner**，其他插件全部关掉，
是确认「你看到的 splash 就是它画的」最干净的方式。

## 配置

把 `pi-chafa-banner.json` 放在扩展旁边就行：克隆在 agent 目录里是
`~/.pi/agent/pi-chafa-banner.json`，装进项目是 `<项目>/.pi/pi-chafa-banner.json`，
用 npm 包装的是 `~/.pi/agent/npm/node_modules/pi-chafa-banner/pi-chafa-banner.json`
（`/splash status` 会打印它实际读的路径）。

每个键都可以不写——文件缺失、键缺失、写错类型、数值离谱，都只会退回那一项的
默认值，`/splash status` 会列出它忽略了哪些。唯一的例外是 `layout`：那里的结构
性错误会被报出来而不是换回默认值，否则错误就被藏起来了（见[尺寸](#尺寸)）。

```json
{
  "version": 2,
  "image": {
    "path": "~/Pictures/logo/v-3.gif",
    "fps": "auto",
    "stride": 3,
    "chafa": "--symbols block"
  },
  "width": 88,
  "height": 17,
  "gap": { "width": 2, "height": 1 },
  "variableWidth": false,
  "variableHeight": false,
  "compactWidth": 32,
  "theme": { "preset": "tokyonight" }
}
```

不写 `layout` 就是[布局](#布局)一节里那棵默认树。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `image.path` | 先 `~/Pictures/logo/v-3.gif`，再 `v-1.gif`，都没有就用包内图 | 要播放的 GIF（会展开 `~`）；节点自带 `img` 时以节点为准 |
| `image.fps` / `image.stride` | `"auto"` / `3` | `"auto"` 按 GIF 自己的节奏播；`stride` 是每 N 帧取 1 帧 |
| `image.chafa` | `""` | 额外的 chafa 参数，一个字符串，比如 `"--symbols block -c 16"` |
| `width` / `height` | `88` / `"auto"` | 根盒子尺寸（单元格）。`height: "auto"` 恰好等于内容自然高度；写数字是**下限**（内容更多就长高，`variableHeight: false` 时才是硬上限） |
| `gap` | `2` | 每个布局分组内子节点之间的空白列/行 |
| `variableWidth` / `variableHeight` | `false` / `false` | 为 `true` 时根盒子可以超出 `width`/`height` 去容纳内容；为 `false` 就是硬上限，超出部分会被标记：过宽的行以 `...` 结尾，行数不够时最后一行是 `...`，缩进沿用被截掉的那一行（标题和 inline 字段顶格，条目是 `  ...`）。开启 `variableHeight` 则完全不标记，盒子直接长高 |
| `compactWidth` | `32` | 终端窄于此值时 splash 退化成三行纯文本 |
| `layout` | [布局](#布局)里的默认树 | 递归节点树，省略就保留默认 splash |
| `theme.preset` | `"tokyonight"` | 锁定下面的深色配色；写 `pi` 改为跟随 pi 当前主题 |
| `theme.windowTitle` / `.sectionTitle` / `.border` / `.content` | 取预设 | 四个配色角色，写 `#rgb` 或 `#rrggbb` 即可覆盖——见下节 |
| `behavior.enabled` / `.static` / `.hidePiResourceList` | `true` / `false` / `true` | 总开关、冻结成静图、隐藏 pi 自带的资源列表 |

`image.chafa` 里有三个参数会被悄悄丢掉：`--probe`（chafa 会等终端应答，抢走
pi 的 stdin）、`--animate`（会破坏一帧一帧的输出）、`--clear`（会清屏）。
想让你编辑器补全这些键，旁边还有 `pi-chafa-banner.schema.json`。

### 配色

`theme` 只管四个地方的颜色，别的都不碰。默认 `"preset": "tokyonight"`，一套固定的
深色配色，任何终端上看起来都一样；写成 `"preset": "pi"` 则回落到 pi 自己的主题
token，浅色终端该用这个。任一角色还能单独用 hex 覆盖：

```json
{
  "theme": {
    "preset": "tokyonight",
    "windowTitle": "#7aa2f7",
    "sectionTitle": "#bb9af7",
    "border": "#3b4261",
    "content": "#a9b1d6"
  }
}
```

| 角色 | 画在哪 | `tokyonight` |
| --- | --- | --- |
| `windowTitle` | 窗口标题：`RESOURCES`、`CODING AGENT`、`IMAGE` | `#7aa2f7` 蓝 |
| `sectionTitle` | 标签标题：`[Context]`、`[Skills]`、`[Extensions]`、`[Version]`、`[Model]` | `#bb9af7` 紫 |
| `border` | 窗口边框，以及标题两侧的横线 | `#3b4261` 注释灰 |
| `content` | 窗口内容：字段值、资源名、状态行 | `#a9b1d6` 正文色 |

显式写的 hex 永远压过预设，所以 `{"preset": "tokyonight", "border": "#ff0000"}`
会保留整套配色、只把边框换成红色。写了 `content` 就等于用一种颜色顶掉 pi 的
`text`/`muted`/`dim` 三档；`"preset": "pi"` 时不写它才能保住这三档层次。颜色在
`truecolor` 下输出 24 位 SGR，`256color` 下取最近的调色板项，跟 pi 报告给你的终端
能力一致。`bun run scripts/preview.ts --color border=#ff0000` 可以不重启 pi 直接看
效果。

## 布局

splash 是一棵递归的节点树，只有三种节点：`layout` 把盒子分给子节点，`window` 画一个带
边框的窗口，`chafa` 渲染一块字符画。写了 `layout` 就整棵替换，不写就是下面这棵默认树：

```json
{
  "type": "layout",
  "mode": "horizontal",
  "children": [
    {
      "type": "layout",
      "weight": 5,
      "mode": "vertical",
      "children": [
        { "type": "chafa", "weight": 1 },
        {
          "type": "window",
          "weight": 1,
          "title": "CODING AGENT",
          "content": [
            { "type": "inline", "title": "Version", "content": "version" },
            { "type": "inline", "title": "Model", "content": "model" }
          ]
        }
      ]
    },
    {
      "type": "window",
      "weight": 5,
      "title": "RESOURCES",
      "content": [
        { "type": "outline", "title": "Context", "content": "context" },
        { "type": "outline", "title": "Skills", "content": "skills" },
        { "type": "outline", "title": "Extensions", "content": "extensions" }
      ]
    }
  ]
}
```

| 节点 | 字段 | 作用 |
| --- | --- | --- |
| `layout` | `mode`、`children`、`weight` | 分组。`"horizontal"` 按 weight 切宽度、子节点左右并排；`"vertical"` 切高度。`mode` 默认 `vertical`；兄弟之间隔着 `gap` 个空白列/行 |
| `window` | `title`、`content`、`weight` | 带边框的窗口。`title` 默认是 `WINDOW`；每个 `content` 项的 `title` 默认取 provider 名首字母大写。`content` 是一串 `{"type":"inline"\|"outline","title","content","stacked"}` |
| `chafa` | `img`、`args`、`weight` | 一块字符画。`img` 覆盖该节点的 `image.path`，但原样使用（不展开 `~`），`args` 追加到 `image.chafa` 后面 |

**`weight`** 是正数，默认 `1`，含义只有一句：「我在父节点里相对兄弟占多少」。份额用
最大余数法分配，加起来正好等于可用的列数/行数，余数相同则靠前的子节点优先。默认 splash
的 5/5 左右分栏、左列里图在上信息卡在下，都是靠嵌套分组拼出来的。

**`inline` 与 `outline`。** `inline` 在一行里印 `[Title] value`——这就是 `CODING AGENT`
卡；`outline` 把 `[Title]` 单独放一行、值缩进在下面——这就是 `RESOURCES` 里的每一节。
内容返回列表时，`stacked: true` 会一行一个名字，否则用逗号换行；默认树里
`Extensions` 竖排、`Context`/`Skills` 逗号换行。provider 返回全部项目、从不自己截断：
窗口填满自己的盒子，列表被截断时最后一行是 `...`，某行过长时该行以 `...` 结尾。

**provider。** `content` 写 provider 名字，或者直接写死一个字符串（不认识的名字就原样
画出来）。内置 5 个 provider：

| provider | 渲染成 | 备注 |
| --- | --- | --- |
| `version` | pi 自身的版本号（取自 `pi -v`） | 探测失败时退化成 `?.?.?` |
| `model` | 当前模型名 | 思考强度跟在后面作后缀（`Claude Sonnet 4.5 · high`）；未知时不显示 |
| `context` | 上下文文件（`AGENTS.md`、`CLAUDE.md`、`APPEND_SYSTEM.md` 等） | 逗号换行，或配合 `stacked` 一行一个 |
| `skills` | 已安装的 skills | 首轮对话之后才可能补全 |
| `extensions` | 已安装的包与本地扩展 | `包名:入口`，与 pi 启动时打印的标签逐字一致。slash 命令从不单独列出（`acp`/`acp-cache` 都属于 `billion-context`，合并成那一个包标签），pi 自带的 `builtin:llama.cpp` 等隐藏扩展也会跳过 |

**尺寸。** `width` 和 `height` 是根盒子的尺寸，而且都是下限而不是固定值：

```
W = variableWidth  ? min(max(width,  内容自然宽度), 终端列数) : min(width,  终端列数)
H = variableHeight ? min(max(height, 内容自然高度), 可用行数) : min(height, 可用行数)
```

「可用行数」是文档视口：终端行数减去 pi 的编辑器/页脚，有状态行时再减一行。

内容需要的行数比 `height` 少时，仍然占满 `height` 行，多出来的部分就是底部的空白行。
`variableHeight: false`（默认）把盒子钉在 `height` 上、把放不下的部分标记出来；
`true` 则让盒子一直长到内容放得下（上限是文档视口：终端行数减去 pi 的编辑器/页脚），
且不写任何标记。`variableWidth` 同理：钉在 `width` 上更宽的行以 `...` 结尾，改成 `true`
才让盒子撑到内容自然宽度。字符画尺寸永远不用配：每个 `chafa`
节点的画布由 `width`、`gap` 和各级 weight 推导出来，所以帧可以提前渲染；终端变窄时裁掉
已渲染好的字符画，而不是重渲一遍。

**布局写错会看得见。** 结构性错误（`type` 不认识、分组没有 `children`、窗口没有
`content`、`weight` 小于等于 0）不会被悄悄换成默认树：splash 变成一张 `LAYOUT ERROR`
卡片，上面照着 JSON 路径写清错误，比如 `layout.children[1].type: expected one of chafa,
layout, window (got "chart")`。盒子小到装不下子节点时也是同一张卡片，比如
`layout.children[0].children[1]: needs at least 12 columns, only 8 available`，
`/splash status` 里则会显示 `layout=error` 和具体原因。`weight` 上限是 100（超过就截到
100），所以 `0.5` 合法，只有 `0` 或负数才算错。

v1 的配置文件（扁平的 `layout`/`panels` 分组）仍然能用：加载时会翻译成等价的树，
`/splash status` 里多一条 `version 1 config: translated to the layout tree (…)` 警告。
翻译会保留 `layout.width`、`layout.gap`、`layout.compactMinWidth`、
`panels.info.fields` 和 `panels.resources.sections`；`panels.info.enabled: false` /
`panels.resources.enabled: false` 会像 v1 那样真的去掉对应窗口并给一条警告。
`layout.maxWidth`、`layout.twoColumnMinWidth`、`layout.lowerRows`、
`panels.resources.width`、`panels.resources.height`、
`panels.resources.maxLinesPerSection` 和 panels 里不认识的字段在 v2 没有对应键：
每一项都会单独给一条 `… ignored when translating` 警告，而不是无声消失。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/splash off` / `on` | 把 header 还给 pi / 再拿回来 |
| `/splash freeze` | 停在当前这一帧——再按一次继续播 |
| `/splash rebuild` | 重跑一遍管线，重写缓存 |
| `/splash reload` | 重新读 `pi-chafa-banner.json` 并重建 |
| `/splash status` | 生效的配置、缓存状态、检测到的工具、警告 |

## 致谢

- [beautiful-pi](https://github.com/danielmrdev/beautiful-pi) 灵感来源
- [chafa](https://hpjansson.org/chafa/) 渲染字符画，`ffmpeg` 抽帧。

> 想了解实现：[docs/ARCHITECTURE.md](https://github.com/XiaoCRQ/pi-chafa-banner/blob/main/docs/ARCHITECTURE.md)
> 里有模块划分、数据流和不变式。
>
> kitty 原生图片版本留在 `archive/kitty-native-images` 分支，等以后再说。

English: [README.md](https://github.com/XiaoCRQ/pi-chafa-banner/blob/main/README.md)。

MIT 许可，见 [LICENSE](https://github.com/XiaoCRQ/pi-chafa-banner/blob/main/LICENSE)。
