# pi-chafa-banner

An animated **chafa** image splash for [pi](https://github.com/earendil-works/pi), rendered into pi's
startup header — not an overlay, not a chat message.

> English is the primary README; a Chinese translation lives in [README.zh-CN.md](README.zh-CN.md).

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

The left column is a GIF rendered to character art by `chafa` (one animation frame per tick), with a
small info card underneath. The right column lists context files, skills, themes and extensions.

## One splash, no duplicated listing

pi prints its own `[Context] / [Skills] / [Themes] / [Extensions]` summary right below the header: it
lives in `loadedResourcesContainer`, the container that follows `headerContainer` inside
`documentContainer`. The splash already shows all of it, so the extension detaches that container from
the live component tree when the header mounts:

- runtime only — no file is written, no dist patch, nothing persisted; a restart brings the stock
  screen back;
- `/splash off` splices it back at its original index, so pi's startup screen is fully restored;
- `PI_BANNER_HIDE_RESOURCES=0` keeps pi's listing untouched;
- if a future pi rearranges its internal tree the detach fails silently (the listing simply stays
  visible) and `/splash status` reports
  `listing visible — detach failed; set "quietStartup": true in pi settings instead`.

Finding it works because `ctx.ui.setHeader()` hands the factory the live `tui` root, whose containers
expose `children` / `removeChild`, and because the header container is always followed by the listing
container. Everything is duck-typed in `src/host.ts`, so a different shape degrades instead of throwing.

## Why a header?

`ctx.ui.setHeader()` replaces pi's builtin startup header inside `headerContainer`, which is a normal
child of the document. That gives us, for free:

- the splash lives **at the top of the transcript** and scrolls into scrollback as the conversation grows
  (no overlay, no input capture, never blocks sending a message);
- pi disposes the previous header on reload / shutdown, so no leaked timers;
- everything keeps working when `quietStartup` hides the default logo.

## Requirements

| tool | why | version |
| --- | --- | --- |
| `chafa` | GIF frame → ANSI character art | ≥ 1.10 (`--symbols solid`, `--probe`) |
| `ffmpeg` | GIF → PNG frames | any recent build (`-fps_mode` or `-vsync`) |
| `pi` | host | 1.5.x |

Both binaries are probed at startup. If either is missing the splash degrades to a bordered
`IMAGE unavailable: …` card plus one warning notice — pi itself keeps working.

## Install / try it

```bash
# try it without installing anything
cd /home/XiaoCRQ/Work/Program/Project/pi-chafa-banner
pi -e .

# or point pi at any checkout
pi -e /path/to/pi-chafa-banner
```

The artwork ships inside the repo at `assets/banner.gif` (a copy of
`~/Pictures/logo/v-1.gif`), so a fresh clone renders immediately. To use your
own image, either replace `assets/banner.gif` or point `PI_BANNER_GIF` at any
`.gif` (see [Configuration](#configuration)); the path is resolved per process,
so no rebuild or reinstall is needed.

The repo ships a user-facing test command that sets the environment, prints the
effective flags, then starts pi from the repo root:

```bash
cd /home/XiaoCRQ/Work/Program/Project/pi-chafa-banner
bash scripts/demo.sh                 # animate with defaults
bash scripts/demo.sh --static        # one frame, no timer
bash scripts/demo.sh --fps 12        # slower animation
bash scripts/demo.sh --size 60x30    # larger canvas
bash scripts/demo.sh --gif ~/Pictures/logo/v-1.gif   # try another gif
```

`demo.sh` only launches an interactive pi (use `/exit` or Ctrl-C to leave); it
never installs anything. If `pi` is not on `PATH` it exits 127 with a hint.

As a package (see pi's `docs/packages.md`), the manifest is already correct:

```json
{ "pi": { "extensions": ["./src/index.ts"] } }
```

No build step: pi loads TypeScript directly with jiti.

## Preview without pi

`scripts/preview.ts` is the tight loop for tuning the art. It runs the real
gif → ffmpeg → chafa → ANSI → layout pipeline but stubs `TUI` and `Theme`, so no
pi process or model call is involved:

```bash
bun run scripts/preview.ts                        # one frame, 100 cols
bun run scripts/preview.ts --static --width 100   # CI smoke test
bun run scripts/preview.ts --width 60             # narrow/stacked layout
bun run scripts/preview.ts --frames 5             # print 5 animation frames
bun run scripts/preview.ts --anim --fps 12        # loop in place, Ctrl-C to stop
bun run scripts/preview.ts --size 30x15           # smaller chafa canvas
bun run scripts/preview.ts --no-frames            # placeholder/degraded card
bun run scripts/preview.ts --plain                # no colors (diffable output)
PI_IMAGE_PROTOCOL=kitty bun run scripts/preview.ts --static   # native kitty band (implies --image)
bun run scripts/preview.ts --image --size 44x22   # same path, explicit flag
```

Art goes to stdout and diagnostics (frame count, cache hit, timing) to stderr, so
`bun run scripts/preview.ts > preview.txt` stays clean. It exits `2` with an
install hint when `chafa` or `ffmpeg` is missing and `1` when the gif cannot be
read; `--no-frames` bypasses both tools. Resources are deterministic stubs unless
you pass `--real-resources`, which keeps previews diffable across machines.

## Configuration

Everything is environment variables — no settings file is written or read.

| variable | default | meaning |
| --- | --- | --- |
| `PI_BANNER_GIF` | `assets/banner.gif` in this package, else `~/.pi/agent/banner.gif`, else `~/Pictures/logo/v-1.gif` | GIF to animate (absolute, or relative to the current directory) |
| `PI_BANNER_SIZE` | `44x22` | canvas cap, `WIDTHxHEIGHT` (width 8–160, height 4–60); in image mode this is the character-grid ceiling |
| `PI_BANNER_FPS` | `16` | animation frames per second (1–30) |
| `PI_BANNER_STRIDE` | `3` | keep every Nth GIF frame (1–10); 57 frames ÷ 3 = 19 kept |
| `PI_BANNER_RENDERER` | `auto` | `auto` \| `chars` \| `kitty`; `auto` uses the native image band when the terminal supports it, `kitty` also explains itself when it cannot |
| `PI_BANNER_STATIC` | off | `1` = render one frame, never start a timer |
| `PI_BANNER_KITTY_MODE` | `anim` | `anim` = the terminal loops the frames itself (0 B/s steady state); `frames` = retransmit one frame per tick (~1.3 MB/s, escape hatch for terminals that ignore animation — expensive once the header scrolls out of the viewport, see *Architecture*) |
| `PI_BANNER_PALETTE` | `128` | PNG palette size: 16, 32, 64, 128 or 256 colours (normalised down to the nearest allowed value) |
| `PI_BANNER_MAX_PX` | `640000` | pixel ceiling per frame; larger grids are scaled down (10 000–4 000 000) |
| `PI_BANNER_MAX_FRAMES` | `24` | frames kept after decimation (1–120) |
| `PI_BANNER_ANIM_SECONDS` | `0` | `0` = loop forever; `>0` = freeze into a still after N seconds (in `anim` mode that costs one retransmission) |
| `PI_BANNER_HIDE_RESOURCES` | on | `0` = keep pi's own `[Context]/[Skills]/…` listing below the splash |
| `PI_BANNER_DISABLED` | off | `1` = do not install the header at all |

Sizing math: the block is `min(terminal width - 4, 108)` columns wide. Two columns need ≥ 76 columns
and ≥ 28 columns left for the panel; below that the layout stacks (image, info card, panel) and below
32 columns it falls back to a three-line text splash.

## Commands

| command | effect |
| --- | --- |
| `/splash on` | install/reshow the header (rebuilds frames if they are missing) |
| `/splash off` | restore pi's builtin header and its resource listing |
| `/splash freeze` | hold the current frame (toggle) |
| `/splash rebuild` | drop the cached frames and re-run ffmpeg + chafa |
| `/splash size 60x30` | change the canvas, clear that cache entry and rebuild |
| `/splash status` | effective config, frame count, cache hit, tool versions, whether pi's listing is detached |

## How it works

```
src/
  index.ts      extension entry: session_start → setHeader, /splash, agent_start/end pause,
                before_agent_start → refresh resources from the resolved system prompt
  host.ts       locate + detach pi's loadedResourcesContainer so the listing is not shown twice
  banner.ts     the Component: render(width) composes the splash from cached strings;
                setInterval bumps the frame index → invalidate() + tui.requestRender()
  layout.ts     pure box drawing: panel(), infoBox(), resourcePanel(), twoColumn(), centering,
                name wrapping with ", ..." overflow; no I/O, unit-testable with a stub Painter
  frames.ts     preflight(chafa, ffmpeg), gif hashing, ffmpeg extraction, chafa render,
                ANSI cleanup, disk cache read/write, frame striding
  resources.ts  version / model / theme / context / skills / themes / extensions collection
  text.ts       ANSI-aware visibleWidth / truncateToWidth / padVisible / centerVisible
types/
  pi-host.d.ts  ambient shim for the pi host API (see "Notes")
```

Key details, because they are not obvious:

- **chafa flags.** `-f symbols --symbols solid --probe off --animate off -c full|256 -s WxH`. `--probe off`
  is mandatory: otherwise chafa waits up to five seconds for a terminal DA reply and steals stdin.
  `--symbols solid` emits foreground-only block glyphs, so the header never paints a background and
  theme colors around the image stay intact.
- **ANSI cleanup.** chafa wraps its output in `ESC[?25l`/`ESC[?25h` and (with `--clear`) `ESC[2J`/`ESC[0H`.
  Those fight pi's renderer, so they are stripped — SGR color sequences (the image itself) are kept.
- **Async build + placeholder.** `render()` is synchronous, so frames are built once, off the event
  loop, and cached in memory. Until they arrive the same footprint is reserved by an `IMAGE` card.
- **Pause while streaming.** `agent_start` stops the timer and `agent_end` restarts it; pi re-renders the
  document on every token and an extra 16 fps splash would be pure jank.
- **Disk cache.** `~/.pi/agent/tmp/pi-chafa-banner/<sha1(gif path + mtime + size)>/frames-<WxH>-<colormode>.json`,
  written atomically (temp file + rename). A cache read failure silently rebuilds. `PI_CODING_AGENT_DIR`
  is respected.
- **ffmpeg compatibility.** ffmpeg 8 removed `-vsync 0` in favour of `-fps_mode passthrough`; the extractor
  tries the modern spelling, then the legacy one, then no flag at all.
- **No duplicate resource list.** `render()` never draws pi's `[Context]/[Skills]/…` block; `host.ts`
  removes pi's own copy at runtime (see above) and `/splash off` puts it back.
- **Resource refresh.** `before_agent_start` hands us the resolved `contextFiles` and `skills`, which is
  the only place they are authoritative; the panel updates on the next turn without restarting pi.

## Troubleshooting

| symptom | cause / fix |
| --- | --- |
| `IMAGE unavailable: missing chafa, ffmpeg on PATH` | install both: `apt install chafa ffmpeg` / `brew install chafa ffmpeg`, then `/splash rebuild` |
| `IMAGE unavailable: cannot read <path>: ENOENT` | `PI_BANNER_GIF` points at a missing file, or the bundled `assets/banner.gif` was deleted: restore it, or drop a gif at `~/.pi/agent/banner.gif` |
| `preview: missing required tool …` (exit 2) | same fix; or preview the fallback with `--no-frames` |
| art looks stale after editing the gif | cache key is `sha1(path + mtime + size)`; `/splash rebuild` or touch the file |
| art is too big / cropped | lower `PI_BANNER_SIZE` (e.g. `40x18`) or make the terminal taller; short terminals crop from the top |
| animation is janky | lower `PI_BANNER_FPS` (16 → 8) or increase `PI_BANNER_STRIDE`; the timer pauses while the agent streams |
| no splash at all | check `PI_BANNER_DISABLED` is unset, `ctx.mode === "tui"`, and run `/splash status` |
| custom first frame in preview | `--frame N`, or `--frames N` for a gallery |

### Deployment fallbacks

| situation | behaviour |
| --- | --- |
| `chafa`/`ffmpeg` missing | info card + resources panel, `IMAGE unavailable: missing … on PATH`, one warning |
| GIF missing/unreadable | same, with `cannot read <path>: ENOENT` |
| terminal < 32 columns | three-line text splash (`π pi 1.5.2` / model / theme) |
| terminal < 76 columns | vertical stack: image, info card, resources panel |
| terminal short enough that `rows - CHROME_ROWS` cannot hold image + gap + lower block | image shrinks the lower block to the info card, then falls back to the `IMAGE` card |
| `PI_BANNER_STATIC=1` | one frame, no interval, no `requestRender` calls |
| image band does not fit (terminal too short/narrow) | 5-row `IMAGE` card, info + panel still shown, one debounced re-encode |
| `ffmpeg` missing in image mode | `IMAGE unavailable: …` card, one warning, chars frames are not attempted |
| non-TUI mode (`pi -p`, RPC) | extension does nothing (`ctx.mode !== "tui"`) |

## Native images (kitty)

`PI_BANNER_RENDERER=auto` (default) switches to native pixels when `getCapabilities().images === "kitty"`;
`chars` is always available and byte-identical to the pre-image release.

How it fits pi's line model — this is the part that constrains everything else:

- The picture gets a **full-width band at the very top**. Nothing may sit beside it: pi's
  `getKittyImageReservedRows` stops counting reserved rows at the first following line whose
  `visibleWidth > 0`, and a single space already counts.
- Exactly one line carries the escape: `padding + <kitty sequence>`. The next `rows - 1` lines must be
  the literal empty string `""`, then one blank gap row, then the info card and RESOURCES panel.
- The sequence comes from pi-tui's `renderImage(..., { imageId, moveCursor: false })`: `imageId` enables
  placement metadata (so full-screen cropping works), `moveCursor: false` (`C=1`) means we own the
  cursor movement, i.e. those `rows - 1` empty lines.
- Frames are quantized PNGs (ffmpeg → `palettegen`/`paletteuse`), encoded once into
  `~/.pi/agent/tmp/pi-chafa-banner/<sha1>/images-*.json`. The kitty image id is **never cached** — it is
  allocated per process.
- `anim` mode sends one constant line (root frame + `a=a` per-frame payloads + start command), so the
  terminal animates on its own and pi never sees a diff. `frames` mode is the escape hatch.
- **`frames` mode is expensive once the header scrolls away.** Every tick changes the image line, so
  `firstChanged` lands inside the header; if the splash is as tall as the document viewport, the image
  anchor sits above `viewportTop` and pi's main-screen renderer answers with `fullRender(true)`
  (`\x1b[2J\x1b[3J`, scrollback included) plus a full retransmit. Only enable it for terminals that ignore
  animation, and pair it with `PI_BANNER_STATIC=1` or `PI_BANNER_ANIM_SECONDS` in long sessions.
- **Frame heads must carry `f=100`.** kitty does not inherit the root image's format for `a=f`
  (`uint32_t fmt = g->format ? g->format : RGBA;`), so a frame without it is validated as raw RGBA and
  dropped wholesale — with `q=2` the error is silent and you are left with a frozen first frame.
- **Short terminals crop, never degrade.** `planImageBand()` (`src/layout.ts`) shrinks the *source
  rectangle* (`x=/y=/w=/h=`) and the cell grid (`c=/r=`) of the root frame, biased to the top third, so the
  band always shows real pixels instead of the `IMAGE` placeholder card. The placeholder is reserved for
  "no picture yet" (build running/failed).
- **A resize re-uploads under a fresh image id.** kitty may drop or reflow a placement when the viewport
  changes, and pi's full-screen path happily replaces our root frame with `a=p` (place-only, no payload)
  while it believes the id is already on the GPU. `Banner.syncTerminalShape()` therefore retargets the
  sequence to a new id on every size change, which makes that cache miss and the full `a=T` line get
  written; the old id is freed afterwards.
- **Teardown frees the image.** `dispose()`, `/splash off` and a rebuild all send
  `a=d,d=I,i=<id>,q=2` (scoped to our id — never `d=A`), because a kitty image outlives the pi process:
  without it the picture keeps animating behind the shell prompt.
- The splash may only use `terminalRows - CHROME_ROWS` (`CHROME_ROWS = 7`: 3 editor rows, 2 footer rows,
  one blank header spacer above and below). See `layout.ts splashRows()` / `imageBandBudget()`.

`PI_BANNER_SIZE` in image mode caps the character grid, not the pixels: the PNG is encoded at
`columns × cellWidth` by `rows × cellHeight` and re-read through `renderImage` so the reserved rows match
what the terminal actually draws.

## Testing

```bash
bun install
bunx tsc --noEmit                # strict typecheck
bun test                         # every test must pass (no hardcoded count)
bun run preview:static --width 100
bun run preview --width 60 --plain
bun run preview --no-frames
bash scripts/demo.sh --static    # real pi, interactive
```

`tests/layout.test.ts` composes the whole splash at 40/60/80/100/140 columns and
asserts every line fits, the block's bounding box is centered within one column,
narrow widths stack, and box titles are centered. `tests/frames.test.ts` covers
ANSI cleaning (control sequences stripped, SGR kept), exact WxH sanitization, and
the cache key changing with gif mtime, canvas size and color mode. The older
`test/` suite covers text helpers, config parsing, the frame pipeline, the Banner
component, the extension wiring, and `host.ts` tree surgery (header container
found through a `tui`-like root, listing detached/restored, hostile trees).

`test/text-parity.test.ts` imports pi-tui's own dist (`PI_TUI_DIST`, default
`/usr/lib/node_modules/pi/packages/tui/dist`) and compares `visibleWidth`,
`truncateToWidth` and `isImageLine` behaviour on mixed-width samples; it skips
when that install is absent. `preview.ts` fakes `TUI` and `Theme` and (unless
`--no-frames`) runs the real ffmpeg/chafa pipeline into a throwaway
`PI_CODING_AGENT_DIR`. The real pipeline is
also exercised by `test/frames.test.ts` (16x8, stride 30 → two chafa invocations;
skipped when the tools or the demo GIF are absent).

Is the extension even loadable by pi? Non-interactive check (pi exits 0 even for broken extensions, so
grep the output):

```bash
pi --list-models --offline -e . | grep -E "Failed to load extension|Extension package"
```

No output = loaded cleanly.

## Notes

- **`types/pi-host.d.ts`.** pi aliases `@earendil-works/pi-coding-agent` and `-pi-tui` to its own copies at
  runtime, and the package must not depend on them. To keep `tsc --noEmit` and plain `bun test` working
  without installing the host, the small surface we use is declared ambiently. If you upgrade pi and need
  more API, extend that file instead of adding a dependency.
- **`src/text.ts` instead of `@earendil-works/pi-tui`.** Same contract (`visibleWidth`, `truncateToWidth`),
  but importable outside a running pi process, which keeps layout tests and `preview.ts` dependency-free.
- **`quietStartup` is not touched.** The extension never edits `~/.pi/agent/settings.json`; if you would
  rather silence pi's own startup output with pi's own switch, set `"quietStartup": true` (removes the
  header *and* the listing) or `"header"` (keeps a header, drops the listing) yourself.
- **If the detach ever fails** (pi changed its component tree), nothing breaks: the splash renders,
  pi's listing shows below it, and `/splash status` tells you which of the two happened. Setting
  `PI_BANNER_HIDE_RESOURCES=0` opts out of the whole mechanism.
- **Nothing is written outside** the cache directory and `mkdtemp` workspaces (both cleaned up by explicit path).
