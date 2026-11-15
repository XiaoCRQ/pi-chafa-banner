# Architecture

How pi-chafa-banner is put together, why it is put together that way, and which
rules you must not break when changing it. For user-facing docs see
[../README.md](../README.md).

## 1. The one-sentence design

A pi extension draws a splash inside `ctx.ui.setHeader()`: a picture band on top
(native kitty image, or chafa character art), and two equal panels underneath
(coding-agent info on the left, resources on the right), all centred inside one
block that is at most `layout.width` cells wide.

Everything expensive (ffmpeg, chafa, base64) happens **before** `render()` and is
cached on disk; `render()` is a pure, synchronous string builder.

## 2. Module map

```
src/
  index.ts                 entry point: pi events → controllers (86 lines)
  extension/
    state.ts               SessionState holder, renderer choice, status text
    session.ts             bootstrap, background build, resource refresh, resize rebuild
    header.ts              setHeader wiring, pi-listing detach/restore
    commands.ts            /splash on|off|freeze|rebuild|reload|status
  config/
    schema.ts              config shape, defaults, limits, parseSize/paletteOf
    validate.ts            tolerant JSON → ValidatedSettings (+ warnings)
    load.ts                file discovery, gif resolution, auto height, loader seam
  banner/
    component.ts           the pi Component: render/invalidate/dispose lifecycle
    band.ts                ImageFrameSet → kitty sequence lines (memoized)
    panels.ts              info card, RESOURCES groups, placeholders (pure)
  layout/
    box.ts                 themed boxes, wrapping, line distribution
    compose.ts             twoColumn / centerBlock / compactSplash
    metrics.ts             row & column budgets, splashRows, kitty row parsing
  text/
    ansi.ts                escape recognition (CSI/OSC/APC), isImageLine, stripAnsi
    width.ts               visible width, padding, centring (pi-tui parity)
    truncate.ts            truncateToWidth and friends
  pipeline/
    process.ts             spawn-without-tty, preflight, gif fingerprint
    cache.ts               cache root, atomic JSON write, single-file delete
    timing.ts              per-frame delays from the gif (ffprobe), sampling/thinning
  frames.ts                char pipeline: gif → ffmpeg → chafa → cached ANSI frames
  images.ts                image pipeline: gif → ffmpeg → pal8 PNG → base64 frames
  kitty.ts                 kitty protocol: encode, re-target, delete
  resources.ts             collect version/model/theme/context/skills/…
  host.ts                  detach pi's own resource listing from the component tree
  config.ts, layout.ts,   barrels (one-line re-exports) so imports stay stable
  text.ts, banner.ts
```

Two pipelines, one shape: `loadFrames()` and `loadImageFrames()` both return a
pre-rendered set plus provenance (`fromCache`, `builtAt`), and both are safe to
call from an event handler — they never throw into pi, they reject with
`FrameError` and the caller degrades to a placeholder card.

Both also carry the gif's own timing. A gif has no frame rate: every frame
carries a delay, so `pipeline/timing.ts` reads those delays with ffprobe
(`probeGifTiming`), folds the frames that `stride`/`maxFrames` dropped back into
the ones that survived (`aggregateDelays`, `thinDelays`) and the result becomes
`FrameSet.delays` (character mode: one `setTimeout` per frame) or
`ImageFrameSet.gapsMs` (kitty `anim` mode: one `z=` per `a=f`, so the terminal
loops at the gif's real speed with zero steady-state traffic). `image.fps` is an
explicit override for people who want a fixed rate; `"auto"` is the default.

## 3. Data flow

```
session_start
  loadSessionConfig()            pi-chafa-banner.json → BannerConfig (+ warnings)
  resolveRenderer(config, caps)  auto → kitty only when the terminal speaks it
  installHeader(ctx)             ctx.ui.setHeader(factory)
    banner.render(width) ────────┐
  buildContent() (async)         │  while building: placeholder card
    chafa:  ffmpeg → chafa → sanitize → cache
    image:  ffmpeg → pal8 pngs → base64 → cache
    banner.setFrames()/setImages()┘  → tui.requestRender()
```

Render path (both renderers):

```
render(width)
  cols < layout.compactMinWidth        → 3-line compact splash
  blockWidth = blockWidthFor(cols)     → min(cols-4, min(maxWidth, layoutWidth))
  body = splashRows(rows) - statusLine
  band  = pixelBand | charBand          → the picture, plus IMAGE_GAP_ROWS empty rows
  lower = lowerLines(body - band.length)→ info card | RESOURCES panel, side by side
  + centring, + truncation to `width`
```

## 4. Invariants (violating these breaks pi's renderer)

1. **Every returned line is ≤ `width` cells.** pi assumes it; a wider line wraps
   and pushes the editor around. Widths come from `text/width.ts`, which is kept
   byte-compatible with `@earendil-works/pi-tui` (and diffed against it by
   `test/text-parity.test.ts`).
2. **One string = one line.** No `\n` inside an element; chafa output is split.
3. **chafa flags are load-bearing.** `--probe off` (otherwise chafa waits ~5 s
   for a device-attributes reply and eats pi's stdin), `--animate off` (one frame
   per file), `--symbols solid` (foreground-only, so the art aligns everywhere),
   and no `--clear` (its `ESC[2J`/`ESC[0H` must never reach the TUI).
4. **`render()` is synchronous.** Frames are pre-rendered; nothing spawns there.
5. **The component only implements `render`/`invalidate`/`dispose`.** No input
   handling, no focus, no overlay — the splash must stay in the document flow so
   it scrolls away with the conversation.
6. **Timers are `unref()`ed and cleared** in `dispose()`, on `/splash off` and on
   `session_shutdown`; they pause during streaming (`agent_start`/`agent_end`).
7. **Never write the user's pi settings or patch pi's dist.** Configuration is
   the JSON file only; the only in-memory intrusion is `host.ts`.
8. **Writes go to `<agent dir>/tmp/pi-chafa-banner/<sha1>/`** and nowhere else;
   scratch directories are removed by explicit path, never by glob.
9. **Degrade, don't throw.** Missing binaries, missing GIF, corrupt cache, narrow
   terminal: placeholder card, compact splash, or the built-in header.
10. **A picture line and the following `r-1` lines are the only rows exempt from
    padding/truncation/centring.** They must be literal `""` — pi's
    `getKittyImageReservedRows()` stops counting at the first non-empty cell, and
    the sequence must come from `renderImage(..., { imageId, moveCursor: false })`
    so pi can crop and reuse the placement.
11. **Native mode is a full-width band on top.** Text cannot sit beside a kitty
    image: the reserved rows after it must be empty.
12. **The picture is never cropped or shrunk.** A band taller than the window is
    emitted whole and pi scrolls it; the info/RESOURCES block yields instead
    (`lowerLines()` returns nothing below `MIN_BOX_ROWS`, the height of the info card). A shortened `r=`/`c=`
    would also desynchronise the `rows` pi registered for the placement via
    `renderImage()`, and pi then erases the picture as soon as the band is
    partially scrolled.
13. **A resize must retransmit with a fresh image id.** `syncTerminalShape()`
    compares `${columns}x${rows}`; on change it re-targets the sequence with
    `fallbackImageId()` and clears the line cache. Reason: kitty drops or moves
    placements when the viewport changes, and pi's alt-screen path replaces our
    `a=T` with a payload-less `a=p` as soon as it believes the id is already
    uploaded (`tui-alt-screen.js prepareKittyScreen` + `terminal-image.js:353`).
    A replaced id is *retired*, not deleted: pi may still re-place it, and a
    placement for freed data is a band that never comes back (`MAX_RETIRED_IDS`).
14. **Teardown deletes every image we ever sent.** `dispose()` and `/splash off`
    emit one `a=d,d=I,i=<id>,q=2` (`encodeKittyDelete()`) per owned or retired id,
    synchronously when the process may exit, otherwise on a `setTimeout(…, 0)`.
    Never `d=A` or `d=a` — those would clear other extensions' images.

## 5. Configuration

`pi-chafa-banner.json` lives next to the installed extension (global install:
`~/.pi/agent/`; project install: `<project>/.pi/`). `config/validate.ts` is a
tolerant reader: a missing key uses the default, a wrong type/enum uses the
default plus a `path.key: …` warning, an out-of-range number is clamped, unknown
keys are ignored. `/splash status` prints the source file and every warning.

`image.height: "auto"` is resolved from the GIF's real aspect ratio (one ffmpeg
probe, cached), because chafa needs a fixed canvas while the kitty grid is
computed from pixels — without it the character and native layouts would differ
in height.

## 6. Upstream credit (item by item)

- **[beautiful-pi](https://github.com/danielmrdev/beautiful-pi)** (MIT, © 2026
  Daniel Muñoz): the *idea* of a two-column `setHeader` splash with a
  `╭─ RESOURCES ─╮` box, and the policy of shrinking a section's lines before
  truncating names. Our `distributeLines()` is an independent water-filling
  implementation; the borders, colours and layout are ours.
- **[pi-splash](https://github.com/mavam/pi-splash)** (MIT, © 2026 Matthias
  Vallentin): the *approach* of putting the splash in `headerContainer` (in the
  document flow, so it scrolls), `unref()`ed animation timers, and a compact
  fallback for narrow terminals. No file was copied; `host.ts` (detaching pi's
  own resource listing) has no equivalent upstream.
- **[@earendil-works/pi-tui](https://github.com/earendil-works/pi)** (Apache-2.0):
  the kitty/iTerm2 encoders (`renderImage`), capability probe, cell metrics and
  the width tables we mirror. The extension does not vendor it; it is a peer
  dependency resolved from the running pi.
- **chafa** (LGPL-3.0, executed as a binary) and **ffmpeg** (executed as a
  binary): no code is linked, only spawned.

## 7. Testing

`bun test` runs the suite in `test/`. No test starts pi or a real terminal:

- `test/splash.test.ts`, `test/banner-*.test.ts`, `test/layout*.test.ts`:
  composition contracts (width ≤ render width, centring, stacking, band sizing,
  placeholder fallbacks) against a stub TUI and a synthesized frame set.
- `test/kitty.test.ts`, `test/images.test.ts`: protocol encoding, re-targeting,
  re-targeting, cache payloads.
- `test/text-parity.test.ts`: compares `visibleWidth()` with pi-tui's real
  implementation when the package is installed (skipped otherwise).
- `test/index.test.ts`: `/splash` dispatch and degradation paths, using
  `setConfigLoader()` to inject configs instead of touching the real one.
- `test/frames.test.ts`, `test/images.test.ts`: real ffmpeg/chafa runs when the
  binaries exist (otherwise skipped).

`bun run scripts/preview.ts` renders the splash without pi — the fast loop for
layout work. Two manual checks remain: `pi -e .` for the real header, and
`PI_TUI_DEBUG_REDRAW=1 pi -e .` plus the pty probe described in `AGENTS.md` §8.8
for resize/teardown of native images.

## 8. Known limits

- iTerm2 inline images are detected but not rendered (falls back to chafa).
- `image.native.mode: "frames"` re-sends a picture per tick; if the header scrolls
  out of the viewport pi falls back to a full render each tick. Use `anim` unless
  the terminal ignores `a=f`/`a=a`.
- Native mode assumes `a=f` animation support; terminals that only honour the
  root frame show a still picture (expected degradation).
- Cached frames are keyed by the GIF's `path+mtime+size`; moving a file with
  identical metadata reuses the old cache entry (harmless, just stale keys).
