# pi-chafa-banner

An animated splash in [pi](https://github.com/earendil-works/pi)'s startup header:
your GIF rendered as character art by [chafa](https://hpjansson.org/chafa/), with
the coding-agent card under it and a resource panel on the right.

```
        ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄         ╭──────────── RESOURCES ────────────╮
        ███ the gif, rendered by chafa ███         │ [Context]                        │
        ███ one frame at a time ██████████         │   ~/work/app/AGENTS.md           │
        ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀         │ [Skills]                         │
       ╭──────── (pi) CODING AGENT ────────╮        │   workflow-authoring             │
       │ version  3.0.0                    │        │ [Extensions]                     │
       │ model    claude-sonnet-4.5        │        │   pi-chafa-banner                │
       ╰───────────────────────────────────╯        ╰──────────────────────────────────╯
```

The splash is installed with `ctx.ui.setHeader()`, so it is part of the document:
it scrolls away with the conversation, never takes input and never covers the
editor. `/splash off` restores pi's own header.

## Quick start

```bash
cd ~/.pi/agent
git clone <this-repo> pi-chafa-banner        # or: pi install <package>
```

Then add it to your pi settings:

```json
{ "extensions": ["~/.pi/agent/pi-chafa-banner/src/index.ts"] }
```

Requirements: `chafa` and `ffmpeg` on `PATH` (`/splash status` prints what was
found). Without a config file the bundled artwork is used.

Preview the layout without starting pi:

```bash
bun run scripts/preview.ts --width 100        # characters, colors on
bun run scripts/preview.ts --width 60         # narrow, stacked layout
```

## Configuration

`pi-chafa-banner.json`, next to the extension itself — `~/.pi/agent/pi-chafa-banner.json`
for a global install, `<project>/.pi/pi-chafa-banner.json` for a project one.
A missing file, a missing key or a bad value falls back to that key's default;
`/splash status` lists the warnings.

```json
{
  "image": {
    "path": "~/Pictures/logo/v-3.gif",
    "width": 44,
    "height": "auto",
    "fps": "auto",
    "stride": 3,
    "chafa": "--symbols block"
  },
  "layout": { "width": 88, "gap": 4 },
  "panels": { "info": { "fields": ["version", "model", "theme"] } }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `image.path` | `~/Pictures/logo/v-3.gif`, else the bundled artwork | GIF to animate (`~` expands) |
| `image.width` / `image.height` | `44` / `"auto"` | Art size in cells; `"auto"` follows the gif's aspect ratio |
| `image.fps` / `image.stride` | `"auto"` / `3` | `"auto"` = the gif's own frame delays; `stride` keeps every Nth frame |
| `image.chafa` | `""` | Extra chafa flags as one string, e.g. `"--symbols block -c 16"` |
| `layout.width` / `layout.gap` | `88` / `4` | Total splash width, and the gap between the columns |
| `layout.twoColumnMinWidth` / `compactMinWidth` | `76` / `32` | Below these the panels stack, then collapse to three lines |
| `panels.info.enabled` / `.fields` | `true` / version, model, theme | Also `gif`, `frames` |
| `panels.resources.enabled` / `.sections` | `true` / all four | `context`, `skills`, `themes`, `extensions` |
| `panels.resources.width` / `.height` / `.maxLinesPerSection` | `"auto"` / `"auto"` / `6` | Panel sizing |
| `behavior.enabled` / `.static` / `.hidePiResourceList` | `true` / `false` / `true` | Master switch, freeze on one frame, drop pi's own listing |

`--probe`, `--animate` and `--clear` are dropped from `image.chafa`: the first
makes chafa wait for a terminal reply and steal pi's stdin, the second breaks
framing, the third wipes the screen. `pi-chafa-banner.schema.json` describes every
key for editor autocompletion.

## Commands

| Command | Effect |
| --- | --- |
| `/splash off` / `on` | Restore pi's built-in header / bring the splash back |
| `/splash freeze` | Hold the current frame (or resume) |
| `/splash rebuild` | Re-run the pipeline and cache |
| `/splash reload` | Re-read `pi-chafa-banner.json` and rebuild |
| `/splash status` | Effective config, cache state, detected tools, warnings |

## Credits

- [beautiful-pi](https://github.com/danielmrdev/beautiful-pi) (MIT): the idea of a
  `setHeader` splash with a `RESOURCES` box. No code copied.
- [pi-splash](https://github.com/mavam/pi-splash) (MIT): scrolling behaviour,
  `unref()` timers, narrow-terminal fallback. No code copied.
- [chafa](https://hpjansson.org/chafa/) renders the art, `ffmpeg` extracts frames,
  and [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi) supplies the
  width tables the layout is measured with.

Module map, data flow and the invariants behind the layout:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). A native kitty-image version lives on
the `archive/kitty-native-images` branch for later work. 中文说明:
[README.zh-CN.md](README.zh-CN.md).

## License

MIT — see [LICENSE](LICENSE).
