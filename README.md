# pi-chafa-banner

An animated splash for [pi](https://github.com/earendil-works/pi)'s startup header:
your GIF on the left, model/context/skills on the right. It renders as character
art through [chafa](https://hpjansson.org/chafa/), and as the *actual picture* on
terminals that speak the kitty graphics protocol.

```
╭──────────────── (pi) CODING AGENT ────────────────╮╭──────────────── RESOURCES ────────────────╮
│ version  2.0.0                                    ││ [Context]                                 │
│ model    claude-sonnet-4.5                        ││   ~/work/app/AGENTS.md                    │
│ theme    system/dark                              ││ [Skills]                                  │
╰───────────────────────────────────────────────────╯╰───────────────────────────────────────────╯
```

The splash is installed with `ctx.ui.setHeader()`, so it sits at the top of the
transcript and scrolls away with the conversation — it never takes input, never
covers the editor, and disappears with `pi`'s own header when the session ends.

## Quick start

```bash
cd ~/.pi/agent                       # where pi looks for packages
git clone <this-repo> pi-chafa-banner
# add the extension to your pi settings:
#   { "extensions": ["~/.pi/agent/pi-chafa-banner/src/index.ts"] }

pi                                    # start pi: the splash is in the header
```

Requirements: `ffmpeg` for both renderers, plus `chafa` if you are not on a kitty
terminal (`/splash status` prints what was found). A terminal that supports the
kitty graphics protocol (kitty, Ghostty, WezTerm, Konsole…) gets the native image;
everything else gets the chafa rendering.

Without any configuration the bundled artwork (`assets/banner.gif`) is used. To
preview the layout without starting pi:

```bash
bun run scripts/preview.ts --width 100            # character art
bun run scripts/preview.ts --image --width 100    # picture band layout
```

## Configuration

Create `pi-chafa-banner.json` **next to the extension** (i.e. in the directory
where the plugin is installed — `~/.pi/agent/` for a global install, `<project>/.pi/`
for a project one). No file, no key, or a bad value simply falls back to the
default for that key; a warning is shown in `/splash status`.

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

| Key | Default | Meaning |
| --- | --- | --- |
| `image.path` | bundled artwork | GIF to animate (`~` is expanded) |
| `image.width` / `image.height` | `44` / `"auto"` | Art size in cells; `"auto"` keeps the GIF's aspect ratio |
| `image.fps` / `image.stride` | `16` / `3` | Playback rate, and "use every Nth frame" |
| `image.renderer` | `"auto"` | `auto` picks the native image when the terminal supports it |
| `image.native.mode` | `"anim"` | `anim` = terminal loops the frames itself; `frames` = resend per tick |
| `image.native.palette` | `128` | Colour count of the quantized frames (16–256) |
| `layout.width` / `layout.gap` | `88` / `4` | Total splash width, and the gap between the two panels |
| `panels.info.fields` | `["version","model","theme"]` | Any of `version`, `model`, `theme`, `gif`, `frames`, `renderer` |
| `panels.resources.sections` | all four | Any of `context`, `skills`, `themes`, `extensions` |
| `panels.resources.width` / `height` | `"auto"` | Pin a panel's width, or let it grow with the content |
| `behavior.static` / `behavior.enabled` | `false` / `true` | Freeze on one frame, or disable the splash |

`pi-chafa-banner.schema.json` describes every key (editors will autocomplete it);
`pi-chafa-banner.example.json` is a complete, valid example.

## Commands

| Command | Effect |
| --- | --- |
| `/splash off` / `on` | Restore pi's built-in header / bring the splash back |
| `/splash freeze` | Hold the current frame (or resume) |
| `/splash rebuild` | Re-run the pipeline and cache |
| `/splash reload` | Re-read `pi-chafa-banner.json` and rebuild |
| `/splash status` | Effective config, cache state, detected tools |

## Credits

- Inspired by [beautiful-pi](https://github.com/danielmrdev/beautiful-pi) (MIT):
  the idea of a two-column `setHeader` splash with a `RESOURCES` box. No code was
  copied; the box drawing and line distribution here are independent.
- [pi-splash](https://github.com/mavam/pi-splash) (MIT) informed the scrolling
  behaviour, the `unref()` timer discipline and the narrow-terminal fallback. No
  code was copied either — see `docs/ARCHITECTURE.md` for an item-by-item note.
- [chafa](https://hpjansson.org/chafa/) renders the character art, `ffmpeg`
  extracts and quantizes frames, and [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi)
  provides the kitty/iTerm2 encoders, cell metrics and width tables.

Implementation details, module map and the invariants the renderer relies on:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). 中文说明: [README.zh-CN.md](README.zh-CN.md).

## License

MIT — see [LICENSE](LICENSE).
