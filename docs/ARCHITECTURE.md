# Architecture

How `pi-chafa-banner` turns a GIF into a splash header, and why the pieces are
shaped the way they are. `README.md` covers usage; this file covers internals.

## 1. Module map

```
src/index.ts                extension entry: pi.on(...) wiring, /splash registration
src/extension/
  state.ts                  SessionState, the live `session` holder, status text
  session.ts                bootstrap, background build (plans + frames), resource refresh
  header.ts                 ctx.ui.setHeader, detaching pi's own resource listing
  commands.ts               /splash on|off|freeze|rebuild|reload|status
src/banner/
  component.ts              the Component: render/invalidate/dispose + frame timer
  panels.ts                 session resources -> ContentContext, /splash status line
src/layout/
  tree.ts                   node types, assertTree, planChafaNodes (geometry from config)
  measure.ts                natural sizes (measureTree) and box distribution (distribute)
  render-tree.ts            tree + boxes -> lines; renderSplash; error/placeholder cards
  box.ts                    boxes, painters, titles, line distribution
  palette.ts                theme roles -> hex -> ANSI (truecolor / 256)
  compose.ts                centerBlock, clampLines, compactSplash
  metrics.ts                CHROME_ROWS, splashRows
src/content/
  providers.ts              named content providers: version, model, context, skills, extensions
src/text/
  ansi.ts                   escape recognition, stripAnsi
  width.ts                  grapheme + East-Asian width, visibleWidth, padding
  truncate.ts               truncateToWidth, truncateEllipsis, sliceVisible
src/frames.ts               ffmpeg -> chafa pipeline per canvas, sanitation, disk cache
src/pipeline/
  process.ts                spawn with no tty, timeouts, preflight, gif hash, gif size
  timing.ts                 per-frame delays: probe, aggregate, thin, describe
  args.ts                   user chafa flags: split, sanitize, digest
  cache.ts                  cache root, atomic JSON writes, single-file delete
src/config/
  schema.ts                 types, defaults, limits, DEFAULT_FILE + DEFAULT_LAYOUT
  tree.ts                   layout-subtree parser: defaults for details, errors for structure
  legacy.ts                 v1 flat layout/panels -> equivalent tree
  validate.ts               tolerant root parser: warn per key, never throw
  load.ts                   discovery, gif resolution, plan assembly, per-image aspect
src/resources.ts            version/model+thinking/context files/skills/extensions
src/host.ts                 pure-memory detach of pi's `loadedResourcesContainer`
```

The `src/*.ts` files at the top level are barrels (`banner.ts`, `config.ts`,
`content.ts`, `layout.ts`, `text.ts`) so importers never need to know the split.

## 2. Lifecycle

```
pi session_start
  └─ bootstrap()
       ├─ loadSessionConfig()          JSON next to the plugin, tolerant
       ├─ collectResources()           commands/settings/manifest probes, each in try/catch
       ├─ installHeader()              ctx.ui.setHeader(component) + detach pi's listing
       └─ buildContent()               async: probe each plan's image, ffmpeg+chafa per canvas

pi agent_start  -> banner.pause()      no timer while tokens stream
pi agent_end    -> banner.resume()
pi before_agent_start -> refreshResources() with the skills from systemPromptOptions
pi session_shutdown -> banner.dispose() + ctx.ui.setHeader(undefined) + restore listing
```

`render()` is synchronous and never spawns: by the time the first frame is drawn
either the cache is warm or the placeholder card is showing.

## 3. Frame pipeline

```
assets/banner.gif (image.path, or a chafa node's own img)
  → planChafaNodes()                                one plan per chafa node, keyed by node path
  → applyPlanSources()                              per-image height from the real aspect ratio
  → groupPlans()                                    identical (image, size, args) share one build
  → sha1(path + mtimeMs + size)                     cache directory name
  → ffprobe frame=pts_time, format=duration         per-frame delays
  → ffmpeg -vsync 0 <cache>/work-*/f%03d.png        extract, at most 240 frames
  → sample every image.stride-th frame              delays of dropped frames fold in
  → chafa -f symbols --symbols solid --probe off
          --animate off -c full|256 <extra flags> -s WxH
  → stripChafaControl + sanitizeFrame(rows, cols)   one string array per row
  → <cache>/<hash>/frames-<WxH>-<color>[-<argsDigest>].json
```

`CACHE_VERSION` guards the JSON shape: bump it whenever the payload changes.
Extra chafa flags are part of both the filename (an 8-char digest) and the
payload, so two configurations never share frames.

`loadPlanFrames()` builds every canvas in the tree and returns a
`Map<nodePath, FrameSet>` (plus one error string per failed canvas). One broken
canvas only costs its own node: the rest still animate, and the failing node
draws the `IMAGE` placeholder with the reason. The first canvas with frames
drives the animation timer; per-frame delays still come from the gif, not from
`fps`, unless `image.fps` is a number.

## 4. Layout tree

A splash is a tree of three node kinds (`src/layout/tree.ts`):

| Node | Role | Notes |
| --- | --- | --- |
| `chafa` | draws a pre-rendered canvas | `img` overrides `image.path`; `args` adds chafa flags for this node only |
| `window` | bordered box of content specs | `title` defaults to `WINDOW`; `content` entries are `inline` (`[Title] value`) or `outline` (heading on its own row) |
| `layout` | splits its box between children | `mode: "horizontal"` splits the width, `"vertical"` splits the height; `weight` picks the share |

`content` names a provider (`version`, `model`, `context`, `skills`,
`extensions`) or is a literal string. `stacked: true` prints list values one per
line, otherwise they wrap with commas. `src/content/providers.ts` owns the
registry; adding a provider is one entry there.

Geometry is solved from the configuration — `width`, `height`, `gap` and the
weights — plus one runtime input: how many columns the terminal has. The chafa
pipeline needs a canvas size while it is pre-rendering frames, long before
`render(width)` runs, so a narrower terminal re-solves the canvases at the width
that actually fits (keeping the probed aspect ratio) and asks the session to
rebuild those frames off the render path; the cached ones are clipped meanwhile.

```
root box:
  width  = variableWidth ? min(max(width, naturalWidth), cols) : min(width, cols)
  height = height === "auto" ? natural : max(height, natural)   // then capped
budget = max(1, splashRows(terminalRows) - (status ? 1 : 0))
```

`height: "auto"` means "exactly as tall as the content needs"; an explicit
number (default `17`) is the box height itself. Either way the result is capped
by `budget`, and `variableHeight` decides what happens when the content wants
more: `false` (default) keeps the box at that height and marks the cut, `true`
grows the box until everything fits. `splashRows(terminalRows) = max(10, rows - CHROME_ROWS)` with `CHROME_ROWS = 7`
(editor 3, footer 2, the two spacers around the header). When `variableWidth` /
`variableHeight` are false the configured value is a ceiling; content that wants
more is truncated instead of growing the box. A truncated row ends with `...`;
when rows run out, the last row becomes `...` if the first dropped row was a
heading and `  ...` if it was an item — the mark reuses the indentation of the row it replaces. With `variableHeight: true` no marker is
written — the box simply keeps growing.

Inside the root box, each group splits its extent with `proportionalShares()`:
largest-remainder apportionment, so integer shares always sum to the available
cells, with ties going to the lower index. A missing `weight` means 1; a weight
that is zero, negative or not a number is a structural error. `measureTree()`
computes each subtree's minimum and preferred size: a `chafa` has an `8x2` floor
(the height floor is deliberately low, so a short terminal crops artwork instead
of text) and is rigid at its planned canvas size, a `window` has a `12x3` floor
and a content-driven preference, and a group sums (or maxes) its children plus
`gap`. `distribute()` then allocates one axis at a time — proportional shares
first, anything below its minimum topped up from the child with the most slack,
rigid canvases stopped at their natural size, preference gaps filled, and
whatever is left handed to flexible windows by weight. On the **height axis
only**, a tight box adds one more step: a flexible node still short of its
preference borrows one row at a time from a sibling that can spare it (a rigid
node down to its minimum, a flexible one down to its own preference). Blank
rows are cheap, a squeezed info card is not; the width axis never borrows,
because a borrowed column would desync a canvas box from its plan. The result is a `Map` from global
node path (`root.0.1`) to box.

Every node then renders into a box of exactly its solved size: horizontal groups
join children with `gap` blank columns, vertical groups insert `gap` blank rows.
A canvas that does not fit is cropped from the top and centred horizontally
(`cropFrame`), and a window whose body overflows ends with `…`. If even the
minimums do not fit, the layout throws `LayoutError` with a node path, and
`renderSplash()` turns that into a `LAYOUT ERROR` card that lists the offending
*JSON* paths (`layout.children[0].children[1]`), because that is what the user
has to edit. Below `compactWidth` columns the whole splash collapses to
`compactSplash()`: three plain lines.

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
9. Degrade, never throw — with one deliberate exception. Missing tools, a missing
   gif, a corrupt cache or a narrow terminal fall back to a placeholder or the
   compact splash, with one notice. A *structurally broken layout tree* is shown,
   not swallowed: silence there would draw a different splash than requested.
10. The host tree is edited only in memory, reversibly: `host.ts` removes pi's
    `loadedResourcesContainer` and `restore()` puts it back at its old index.
11. Canvas geometry comes from the config (`width`/`height`/`gap`/weights) plus
the terminal's column count. A narrower terminal re-solves the canvases
(`plansForWidth()`) and asks for frames at that grid; until they land, the
cached frames are clipped. The cache key stays `image + WxH + args`, so
widening back is a cache hit and two widths never share a file.
12. Node paths (`root.0.1`) are the identity of a canvas: they key the frame map
    and the cache. `assertTree()` runs before measuring so an unknown `type` is
    reported instead of crashing on a missing `children` array.

## 7. Configuration

`pi-chafa-banner.json` lives next to the plugin (`configPath(pluginRoot())`).
The document is parsed in two layers:

- `validate.ts` reads the root group (`image`, `theme`, `behavior`, the root box
  keys) with a `Reader` that records `"<path>: <problem>"` warnings and returns
  the default for anything it cannot use, so a typo costs one key, not the splash.
- `tree.ts` parses the `layout` subtree. Missing or mistyped *details* (no
  `weight`, no `mode`, a non-string title) get their defaults; *structural*
  mistakes (unknown `type`, a group without `children`, a window without
  `content`, a non-positive weight) come back as one error string.

A structural error is stored as `layoutError` with the tree left undefined. The
renderer shows the `LAYOUT ERROR` card and `/splash status` reports
`layout=error`; nothing silently substitutes the default splash. `DEFAULT_FILE`
in `schema.ts` is the single source of truth for both runtime and `/splash
status`, and `DEFAULT_LAYOUT` (next to it) is the fallback tree.

A v1 file — no `layout` tree, a flat `layout`/`panels` pair — is translated by
`legacy.ts` into the equivalent tree, with one summary warning that names the
result plus one warning per v1 field that has no v2 equivalent (or is mistyped).

Gif resolution (`resolveGifPath()`): an explicit `image.path` wins even when the
file is missing (a clear "cannot read" beats animating a different picture), then
`~/Pictures/logo/v-3.gif`, then `~/Pictures/logo/v-1.gif`, then the bundled
`assets/banner.gif`. A chafa node's `img` is used as given: no `~` expansion, so
an absolute path is safest.

`assemble()` solves the plan once: `planChafaNodes()` walks the tree and records
one `ChafaPlan` per chafa node, with the width split by weights and a nominal
height from `autoHeightFor()`. `applyPlanSources()` then replaces that height
with the artwork's real aspect ratio per image (a character cell is roughly twice
as tall as it is wide). The plan is frozen before frames are rendered; the render
loop never recomputes it. Old flat fields (`layout`, `panels`) are still mirrored
from the splash settings for compatibility, but the tree is the truth.

## 8. Cache

- `~/.pi/agent/tmp/pi-chafa-banner/<sha1>/frames-<WxH>-<color>[-<args>].json`
  — one file per distinct canvas (`<WxH>` is that canvas, not the terminal).
- Atomic writes: `<file>.<pid>.tmp` then `rename`.
- Invalidation: `CACHE_VERSION`, gif `sha1(path+mtimeMs+size)`, canvas size,
  colour mode, chafa flags.
- `/splash rebuild` forces a re-render; `/splash reload` also re-reads the JSON,
  and drops the cache files of plan shapes that changed (`clearPlanCaches()`
  touches only those exact files).

## 9. Tests

`bun test` covers the pure layers: `test/config.test.ts` (tolerant root parsing
and v1 translation), `test/layout-tree.test.ts` (node validation, weights,
planning), `test/render-tree.test.ts` (natural sizes, distribution, `LAYOUT
ERROR` paths), `test/banner.test.ts` / `test/splash.test.ts` / `test/index.test.ts`
(component and extension wiring), `test/text*.test.ts` (`visibleWidth`,
truncation, pi-tui parity), `test/theme.test.ts` (hex parsing, preset/override
merging, SGR conversion, width invariance) and `test/host.test.ts` (reversible
detach). `test/frames.test.ts` and `test/timing.test.ts` shell out to real
`ffmpeg`/`ffprobe`/`chafa` and skip when the tools or the sample gif are missing.
No test pins a case count; read the summary line instead.

## 10. Upstream references

| Project | Licence | Relation |
| --- | --- | --- |
| [beautiful-pi](https://github.com/danielmrdev/beautiful-pi) | MIT | Inspiration for a `setHeader` splash with a `RESOURCES` box. No code copied; the box drawing, `allocate()` and `renderSplash()` are independent. |
| [chafa](https://hpjansson.org/chafa/) | LGPL-3.0 | External binary; renders the art. |
| [ffmpeg](https://ffmpeg.org/) | LGPL/GPL | External binary; extracts frames, probes timing and size. |
| [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi) | MIT | Peer dependency: width tables and the component contract. |

A native kitty-image renderer (real pixels, crop-on-resize, teardown deletes) is
preserved on the `archive/kitty-native-images` branch. It is not maintained here:
pi's main screen cannot place text beside a kitty image, so the unified look was
impossible, and character art keeps every terminal identical.
