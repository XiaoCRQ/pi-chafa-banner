# pi-chafa-banner

Your favourite GIF, redrawn as terminal character art and parked in [pi](https://github.com/earendil-works/pi)'s
startup header — it scrolls away with the conversation, never steals focus, and
never touches a keystroke.

```
        ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄         ╭──────────── RESOURCES ────────────╮
        ███ the gif, rendered by chafa ███         │ [Context]                        │
        ███ one frame at a time ██████████         │   ~/work/app/AGENTS.md           │
        ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀         │ [Skills]                         │
       ╭──────── (pi) CODING AGENT ────────╮        │   workflow-authoring             │
       │ version  1.0.0                    │        │ [Extensions]                     │
       │ model    claude-sonnet-4.5        │        │   pi-chafa-banner                │
       ╰───────────────────────────────────╯        ╰──────────────────────────────────╯
```

## Quick start

```bash
cd ~/.pi/agent
git clone <this-repo> pi-chafa-banner        # or: pi install <package>
```

Point pi at it:

```json
{ "extensions": ["~/.pi/agent/pi-chafa-banner/src/index.ts"] }
```

You need `chafa` and `ffmpeg` on your `PATH` — `/splash status` tells you what it
found. No config file? The bundled artwork shows up.

Want to see the layout without starting pi? There is a previewer for that:

```bash
bun run scripts/preview.ts --width 100        # characters, colours on
bun run scripts/preview.ts --width 60         # narrow, stacked layout
```

## Configuration

Drop a `pi-chafa-banner.json` next to the extension: `~/.pi/agent/pi-chafa-banner.json`
for a global install, `<project>/.pi/pi-chafa-banner.json` for a project one.
Everything is optional — a missing key, a typo or a nonsense value just falls
back to the default for that key, and `/splash status` tells you which ones it
ignored.

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

| Key | Default | Meaning |
| --- | --- | --- |
| `image.path` | `~/Pictures/logo/v-3.gif`, else the bundled artwork | Which GIF to animate (`~` expands) |
| `image.fps` / `image.stride` | `"auto"` / `3` | `"auto"` plays at the gif's own pace; `stride` keeps every Nth frame |
| `image.chafa` | `""` | Extra chafa flags, one string, e.g. `"--symbols block -c 16"` |
| `layout.width` / `layout.gap` | `88` / `2` | Overall width; the two columns split it evenly and the art canvas follows |
| `layout.twoColumnMinWidth` / `compactMinWidth` | `76` / `32` | Below these the panels stack, then collapse into three lines |
| `panels.info.enabled` / `.fields` | `true` / version, model, theme | Also `gif`, `frames` |
| `panels.resources.enabled` / `.sections` | `true` / all four | `context`, `skills`, `themes`, `extensions` |
| `panels.resources.maxLinesPerSection` | `6` | Lines per section before it trails off with `…` |
| `panels.resources.width` / `.height` | `"auto"` / `"auto"` | Ignored side-by-side: the panel is exactly as wide as the art column |
| `behavior.enabled` / `.static` / `.hidePiResourceList` | `true` / `false` / `true` | Master switch, freeze on one frame, hide pi's own resource list |

Three flags are quietly dropped from `image.chafa`: `--probe` (chafa would wait
for a terminal reply and steal pi's stdin), `--animate` (breaks one-frame-at-a-time)
and `--clear` (wipes the screen). `pi-chafa-banner.schema.json` describes every key
if you want autocompletion in your editor.

## Commands

| Command | Effect |
| --- | --- |
| `/splash off` / `on` | Hand the header back to pi / take it over again |
| `/splash freeze` | Hold the current frame — and unfreeze it |
| `/splash rebuild` | Re-run the pipeline and rewrite the cache |
| `/splash reload` | Re-read `pi-chafa-banner.json` and rebuild |
| `/splash status` | Effective config, cache state, detected tools, warnings |

## Credits

- [beautiful-pi](https://github.com/danielmrdev/beautiful-pi) (MIT): the
  inspiration for a `setHeader` splash with a `RESOURCES` box. No code copied.
- [chafa](https://hpjansson.org/chafa/) turns pixels into characters, `ffmpeg`
  digs the frames out of the gif, and
  [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi) supplies the
  width tables everything is measured with.

Curious how it works? [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the module
map, the data flow and the invariants. A native kitty-image version waits on the
`archive/kitty-native-images` branch. 中文说明：[README.zh-CN.md](README.zh-CN.md).

MIT licensed, see [LICENSE](LICENSE).
