# Architecture

How `pi-chafa-banner` turns a GIF into a splash header, and why the pieces are
shaped the way they are. `README.md` covers usage; this file covers internals.

## 1. Module map

```
src/index.ts                extension entry: pi.on(...) wiring, /splash registration
src/extension/
  state.ts                  SessionState, the live `session` holder, status text
  session.ts                bootstrap, background build, resource refresh
  header.ts                 ctx.ui.setHeader, detaching pi's own resource listing
  commands.ts               /splash on|off|freeze|rebuild|reload|status
src/banner/
  component.ts              the Component: render/invalidate/dispose + frame timer
  panels.ts                 info card rows, resource sections, status line, placeholder
src/layout/
  box.ts                    boxes, painters, titles, line distribution
  palette.ts                theme roles -> hex -> ANSI (truecolor / 256)
  compose.ts                twoColumn, centerBlock, clampLines, compactSplash
  metrics.ts                CHROME_ROWS, splashRows, blockWidthFor
src/text/
  ansi.ts                   escape recognition, stripAnsi
  width.ts                  grapheme + East-Asian width, visibleWidth, padding
  truncate.ts               truncateToWidth, truncateEllipsis, sliceVisible
src/frames.ts               ffmpeg -> chafa pipeline, sanitation, disk cache
src/pipeline/
  process.ts                spawn with no tty, timeouts, preflight, gif hash, gif size
  timing.ts                 per-frame delays: probe, aggregate, thin, describe
  args.ts                   user chafa flags: split, sanitize, digest
  cache.ts                  cache root, atomic JSON writes, single-file delete
src/config/
  schema.ts                 types, defaults, limits, DEFAULT_FILE
  validate.ts               tolerant parser: warn per key, never throw
  load.ts                   discovery, gif resolution, auto height, overrides
src/resources.ts            version/model/theme/context files/skills/themes/extensions
src/host.ts                 pure-memory detach of pi's `loadedResourcesContainer`
```

The `src/*.ts` files at the top level are barrels (`banner.ts`, `config.ts`,
`layout.ts`, `text.ts`) so importers never need to know the split.

## 2. Lifecycle

```
pi session_start
  └─ bootstrap()
       ├─ loadSessionConfig()          JSON next to the plugin, tolerant
       ├─ collectResources()           commands/settings/theme probes, each in try/catch
       ├─ installHeader()              ctx.ui.setHeader(component) + detach pi's listing
       └─ buildContent()               async: probe aspect ratio, ffmpeg+chafa, cache

pi agent_start  -> banner.pause()      no timer while tokens stream
pi agent_end    -> banner.resume()
pi before_agent_start -> refreshResources() with the skills from systemPromptOptions
pi session_shutdown -> banner.dispose() + ctx.ui.setHeader(undefined) + restore listing
```

`render()` is synchronous and never spawns: by the time the first frame is drawn
either the cache is warm or the placeholder card is showing.

## 3. Frame pipeline

```
assets/banner.gif (or image.path)
  → sha1(path + mtimeMs + size)                     cache directory name
  → ffprobe frame=pts_time, format=duration         per-frame delays
  → ffmpeg -vsync 0 <cache>/work-*/f%03d.png        extract, at most 240 frames
  → sample every image.stride-th frame              delays of dropped frames fold in
  → chafa -f symbols --symbols solid --probe off
          --animate off -c full|256 <extra flags> -s WxH
  → stripChafaControl + sanitizeFrame(rows, cols)   one string array per row
  → <cache>/<hash>/frames-<WxH>-<color>-<args>.json
```

`CACHE_VERSION` guards the JSON shape: bump it whenever the payload changes.
Extra chafa flags are part of both the filename (an 8-char digest) and the
payload, so two configurations never share frames.

## 4. Layout

```
block  = cols >= ceiling ? ceiling : max(20, cols - 4)   ceiling = min(maxWidth, width)
column = floor((block - layout.gap) / 2)        both sides, always equal
canvas = column x autoHeightFor(column)         chafa renders at exactly this size
```

There is no image size setting: the artwork is one column wide, and its height
follows the gif's aspect ratio (`applySourceSize()` refines `column / 2`). Two
columns when `block >= layout.twoColumnMinWidth` and `column >= 28`; otherwise the
resource panel stacks under the card, both at full `block` width. Below
`layout.compactMinWidth` the whole splash collapses to `compactSplash()`: three
plain lines.

Rows come from `splashRows(terminalRows) = max(10, rows - CHROME_ROWS)` with
`CHROME_ROWS = 7` (editor 3, footer 2, the two spacers around the header). The art
is clipped from the top to fit what is left after the info card, the status line
and any stacked panel — the card never gives way, because the card is the part
that carries information.

## 5. Colour

Boxes take four roles — `windowTitle`, `sectionTitle`, `border`, `content` — from
the `theme` group. `resolvePalette()` merges `theme.preset` with per-role hex
overrides (an override always wins). The default preset `"tokyonight"` pins all
four to `TOKYONIGHT_PALETTE` (`#7aa2f7`, `#bb9af7`, `#3b4261`, `#a9b1d6`);
`"preset": "pi"` resolves to an empty palette, and `themePainter()` then paints
with pi's own `borderMuted` / `mdHeading` / `text` tokens, so a light terminal
stays readable. `content` replaces the `text`/`muted`/`dim` trio with one colour.

Emission follows `theme.getColorMode()`: 24-bit SGR for `truecolor`, the nearest
entry of the 6x6x6 cube or the 24-step grey ramp for `256color`. The reset is
`ESC[39m` (default foreground), not `ESC[0m`, so bold from an outer wrapper
survives — the same contract as pi's `fg()`. Colours never change the measured
width, which is why the ANSI wrappers are applied *after* padding.

## 6. Invariants

Break one of these and pi's renderer corrupts the screen.

1. Every rendered line measures `<= width` under `visibleWidth()`.
2. One array element is one screen row: never embed `\n`.
3. chafa always gets `--probe off` (else it waits up to 5s for a terminal reply and
   steals pi's stdin) and `--animate off` (one frame per invocation).
4. `render()` is synchronous; all frames are pre-rendered and cached.
5. The component implements only `render`, `invalidate`, `dispose` — no
   `handleInput`, no focus, no overlays. The splash is a document row so it scrolls
   away with the conversation.
6. Timers are `unref()`ed, cleared in `dispose()`, and paused while the agent
   streams.
7. Nothing writes `~/.pi/agent/settings.json` and nothing patches pi's dist.
8. Writes only happen under `~/.pi/agent/tmp/pi-chafa-banner/<sha1>/`
   (`PI_CODING_AGENT_DIR` respected); temp dirs are removed by explicit path.
9. Degrade, never throw: missing tools, a missing gif, a corrupt cache or a narrow
   terminal all fall back to a placeholder or the compact splash, with one notice.
10. The host tree is edited only in memory, reversibly: `host.ts` removes pi's
    `loadedResourcesContainer` and `restore()` puts it back at its old index.

## 7. Configuration

`pi-chafa-banner.json` lives next to the plugin (`configPath(pluginRoot())`).
`validateSettings()` walks the document with a `Reader` that records
`"<path>: <problem>"` warnings and returns the default for anything it cannot
use, so a typo costs one key, not the splash. `DEFAULTS` is the single source of
truth for both runtime and `/splash status`.

The canvas is derived, never configured: `derivedCanvas()` splits `layout.width`
into two equal columns around `layout.gap`, and `applySourceSize()` recomputes the
height from the artwork's aspect ratio (a character cell is roughly twice as tall
as it is wide) once per build, via `probeSourceSize()` (ffprobe).

## 8. Cache

- `~/.pi/agent/tmp/pi-chafa-banner/<sha1>/frames-<WxH>-<color>[-<args>].json`
- Atomic writes: `<file>.<pid>.tmp` then `rename`.
- Invalidation: `CACHE_VERSION`, gif `sha1(path+mtimeMs+size)`, size, colour mode,
  chafa flags.
- `/splash rebuild` forces a re-render; `/splash reload` also re-reads the JSON.

## 9. Tests

`bun test` — 204 cases in 12 files. `test/frames.test.ts` and `test/timing.test.ts`
shell out to real `ffmpeg`/`ffprobe`/`chafa` and skip when the tools or the sample
gif are missing. `test/text-parity.test.ts` compares `visibleWidth`/`truncateToWidth`
against pi-tui's own implementation when it can be resolved. `test/theme.test.ts`
covers hex parsing, preset/override merging, the truecolor and 256-color SGR
conversion, and that the palette never changes measured widths.

## 10. Upstream references

| Project | Licence | Relation |
| --- | --- | --- |
| [beautiful-pi](https://github.com/danielmrdev/beautiful-pi) | MIT | Inspiration for a `setHeader` splash with a `RESOURCES` box. No code copied; the box drawing and `distributeLines()` are independent. |
| [chafa](https://hpjansson.org/chafa/) | LGPL-3.0 | External binary; renders the art. |
| [ffmpeg](https://ffmpeg.org/) | LGPL/GPL | External binary; extracts frames, probes timing and size. |
| [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi) | MIT | Peer dependency: width tables and the component contract. |

A native kitty-image renderer (real pixels, crop-on-resize, teardown deletes) is
preserved on the `archive/kitty-native-images` branch. It is not maintained here:
pi's main screen cannot place text beside a kitty image, so the unified look was
impossible, and character art keeps every terminal identical.
