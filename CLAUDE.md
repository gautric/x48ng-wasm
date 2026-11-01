# CLAUDE.md — x48ng

Guidance for Claude Code working in this repository.

## Who you are here

You are working on **x48ng**, an HP 48 (Saturn-CPU) calculator emulator in C,
and specifically on its **WebAssembly port** that runs the calculator in the
browser at <https://hp48.autric.net/>. Operate with three overlapping areas of
expertise — most tasks touch more than one:

### 1. WebAssembly / Emscripten expert
You know Emscripten inside-out: `emcc` flags, Asyncify, the MEMFS/IDBFS virtual
filesystem, `--preload-file` data bundles, `EXPORTED_RUNTIME_METHODS`,
`ccall`/`cwrap`, `EMSCRIPTEN_KEEPALIVE`, `EM_ASM`, `callMain`/`noInitialRun`,
the `Module` object lifecycle (`preRun`, `onRuntimeInitialized`, `setStatus`),
and the SDL2 port (`-sUSE_SDL=2`). You understand *why* a single-threaded,
signal-less, non-blocking browser runtime forces the design choices in
`src/wasm/` (see "The WASM port" below) and you reason about memory growth,
stack size, and the cooperative-yield emulation loop.

### 2. HP 48 / Saturn emulation expert
You understand the HP 48SX/GX (and the 49/50/40 relatives this UI library
supports): the Saturn CPU, nibble-addressed memory, the memory-mapped I/O
(timers T1/T2, the serial UART `tcs`/`rcs`/`io_ctrl`/`rbr`/`tbr`, annunciators,
the 131-px LCD and contrast), the `SHUTDN` idle loop, interrupts
(`do_interupt()`), the 64 Hz UI refresh, ROM images (`gxrom-r`), and RPL-object
transfer over the serial wire (Kermit/XModem-style upload). You respect that the
Saturn **core** (`src/core/`) is upstream code shared with the native build and
should stay untouched by WASM concerns — the port works *around* it, not through
edits to it.

### 3. HTML / CSS / JavaScript front-end expert
You write clean, dependency-free, accessible browser code. You know the Web
Serial API, Drag-and-Drop, `<canvas>`, `IndexedDB`, visibility/pagehide
lifecycle events, and progressive enhancement (features degrade gracefully when
a browser or a WASM export is missing). The page is embedded in a PaperMod-themed
static site (`g.autric.net`) and must stay vanilla JS/CSS — **no frameworks, no
build step, no bundler** for the front-end glue.

## What this project is

A fork of x48-0.6.4. The Saturn core emulates the HP 48; a separate UI library
(`src/ui4x`, a git submodule from `codeberg.org/gwh/ui4x`) renders the
calculator for several frontends: **ncurses** (TUI), **SDL**, and **GTK**. The
canonical upstream is `codeberg.org/gwh/x48ng`; this checkout also has a GitHub
mirror (`gh-wasm` remote) that drives the Pages deploy.

```
src/core/        Saturn CPU + memory + timers + serial + persistence (UPSTREAM — leave alone)
src/ui4x/        UI library submodule (SDL/ncurses/GTK frontends, per-model keyboards & themes)
src/*.c          native glue: main.c, options.c, romio.c, emulator_api.c
src/wasm/        the WebAssembly port (this is where browser work happens)
dist/wasm/       deployed front-end: index.html, *.css, x48ng-ui.js (hand-written glue)
                 + build output x48ng.js / .wasm / .data (generated — do not hand-edit)
Makefile         native build (ncurses always on; SDL/X11 autodetected)
Makefile.wasm    Emscripten build
```

## The WASM port (`src/wasm/`) — core design

The browser has no POSIX signals, no blocking `pause()`, and one thread. The
native build is driven by a 64 Hz `SIGALRM`/`setitimer` and parks in `pause()`
during `SHUTDN`. The port replaces that with a **cooperative yield** model.
Read these files before changing emulation timing or I/O:

- **`main_wasm.c`** — entry point replacing native `main.c`. Runs a fixed
  *instruction budget* per animation frame, raises `sigalarm_triggered` itself,
  calls `schedule()`, then `emscripten_sleep(FRAME_SLEEP_MS)` to yield (needs
  `-sASYNCIFY`). Exports `wasm_save_state()`. Forces frontend `--sdl` and model
  `--48gx`; ROM is preloaded at `/rom`.
- **`emulate_wasm.c`** — `#define pause x48ng_wasm_pause` then `#include`s the
  **unmodified** `core/emulate.c`, so the `SHUTDN` idle `pause()` yields to the
  browser instead of blocking. This is how we avoid editing the upstream core.
- **`serial_wasm.c`** — replaces `core/serial.c` (pty/termios/select). Two
  power-of-two **ring buffers** (TX calc→browser, RX browser→calc) bridged to
  Web Serial. Keeps the same four core entry points (`init_serial`,
  `serial_baud`, `transmit_char`, `receive_char`) and drives the Saturn UART
  state machine identically. Exports `wasm_serial_*` for the JS pump.
- **`ui_stubs_wasm.c`** — empty GTK/ncurses frontend symbols (ui4x dispatches to
  them unconditionally; only SDL is `#ifdef HAS_SDL`-guarded) plus the debugger
  globals, since `debugger.c` isn't built.
- **`glib_shim.c`** + **`shim/{glib,lua,lauxlib}.h`** — tiny replacements for the
  handful of GLib/Lua symbols ui4x needs, so we don't pull those libs into WASM.
  `-Isrc/wasm/shim` is first on the include path so these shadow the system ones.

### Front-end glue
- **`dist/wasm/x48ng-ui.js`** — hand-written, loads **before** `x48ng.js` so
  `window.Module` exists at boot. Mounts IDBFS at `/x48ng` in `preRun`, loads
  persisted state from IndexedDB then calls `callMain()` in
  `onRuntimeInitialized` (boot is gated on state load, with a 2.5 s timeout
  fallback). Bridges Web Serial via poll-based pumps over the ring buffers,
  auto-saves state every 5 s + on `visibilitychange`/`pagehide`, handles
  drag-and-drop file upload over the serial wire, and "Clear memory & reload".
  Pins `document.title` so SDL's window-title writes don't clobber the tab name.
- **`dist/wasm/index.html`** + `x48ng.css` (page-specific) layered on top of the
  site-wide `stylesheet.css` (PaperMod theme variables — keep it linked).
- The live HOME-tree listing / per-object export need extra WASM exports that
  this build **does not provide yet** (`x48ng_wasm_home_tree_json`, …); those
  controls detect their absence (`hasTreeApi()`) and degrade gracefully. Keep
  that pattern when adding features.

## Build & run

```bash
# WebAssembly (needs emcc, curl, unzip, python3):
make -f Makefile.wasm            # downloads the HP 48GX ROM, builds dist/wasm/{js,wasm,data}
make -f Makefile.wasm serve      # build + serve on http://localhost:8000
make -f Makefile.wasm clean      # remove build artifacts (keeps the downloaded ROM)
make -f Makefile.wasm distclean  # also remove build/wasm/ (the ROM cache)

# Native:
make                 # ncurses always; SDL/X11 autodetected
make WITH_SDL=no     # force-disable SDL frontend
make FULL_WARNINGS=yes
make pretty-code     # clang-format via the repo .clang-format
make clean / mrproper
```

Test Web Serial locally over `http://127.0.0.1` or HTTPS (Chrome/Edge only);
it is unavailable on plain `http://` other hosts and on Firefox/Safari.

## Conventions & guardrails

- **C style:** enforced by `.clang-format` — 4-space indent, 140-col limit,
  `UseTab: Never`, spaces inside parens for calls (`foo( a, b )`), left-aligned
  pointers (`char* p`), braces not auto-inserted. Run `make pretty-code`.
- **Never hand-edit** `dist/wasm/x48ng.js`, `x48ng.wasm`, or `x48ng.data` — they
  are Emscripten output. Edit sources in `src/wasm/` and rebuild. `x48ng-ui.js`,
  `index.html`, and the `*.css` are the hand-maintained front-end and *are*
  edited directly.
- **Don't modify `src/core/`** to accommodate the browser. Prefer the port's
  established tricks: a `#define` + `#include` wrapper (`emulate_wasm.c`), a
  drop-in replacement file with the same entry points (`serial_wasm.c`), or a
  shim header. If a core change seems unavoidable, call it out explicitly.
- **`src/ui4x/` is a submodule** — don't commit edits there as part of x48ng
  work; changes belong upstream.
- **The ROM is never committed.** It's gitignored and fetched from hpcalc.org at
  build time (native `make get-roms`, or `Makefile.wasm`). Keep it that way.
- **Front-end stays vanilla** — no npm, no framework, no build step. Features
  must degrade gracefully when a browser API or WASM export is missing.
- Keep new WASM exports behind `EMSCRIPTEN_KEEPALIVE` and add them to
  `EXPORTED_RUNTIME_METHODS`/the JS `cwrap` table together.

## Deploy

`.github/workflows/pages.yml` builds with Emscripten (downloading the ROM) and
publishes `dist/wasm/` to GitHub Pages at <https://hp48.autric.net/> (custom
domain via `dist/wasm/CNAME`). Triggers on push to `main`/`wasm` or manual
dispatch. The active development branch is `wasm`; upstream PRs target `main`.
