# AGENTS.md

Instructions for AI coding agents working on Schwung Tuner.

## Quick Reference

```bash
# Build release (Docker ARM64 cross-compilation)
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/build" -w /build tuner-builder ./scripts/build.sh

# Build debug (comprehensive logging enabled)
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/build" -w /build tuner-builder ./scripts/build.sh --debug

# Deploy to Move
./scripts/install.sh

# Debug log
ssh ableton@move.local "tail -f /data/UserData/schwung/debug.log"

# Update version
./scripts/version.sh X.X.X
```

## Critical Rules

- **ME framework coalesces back-to-back `host_module_set_param` calls.** Only the last call per tick reaches the DSP plugin. Use `queueParam()` for commands that must not be dropped, `sendParamNow()` for real-time knob values where only the latest matters.
- **Reserved key**: `mode` is intercepted by the ME host framework and never reaches the plugin's `set_param`. Use `tn_inst` (integer preset index) for preset switching.
- `component_type: "tool"` must be a **top-level field** in `module.json`, NOT inside `capabilities`.
- `plugin_api_v2_t` MUST include `get_error` field (8 fields total).
- Import paths MUST use **absolute paths** (`/data/UserData/schwung/shared/...`), not relative.
- Do NOT use `chain_params` in `module.json` -- no other ME tool module uses them and they cause parameter interception.
- Audio format: int16 stereo interleaved, 44100 Hz, 128 frames/block.
- Use `cat` instead of `cp` in build scripts (Docker volume compatibility).
- Display: 128x64 monochrome, 5x7 font (6px wide, 8px tall).
- Knob capacitive touches arrive as MIDI Note On (note 0-7, velocity > 0) and are filtered by `shouldFilterMessage()`. Handle them BEFORE the filter call.
- State persistence uses `get_param("state")` / `set_param("state", json)` JSON blob pattern.
- **Step button presses** and **pad presses** must also be handled BEFORE `shouldFilterMessage()` in the MIDI handler.
- **LED cleanup**: Always clear pad/step LEDs on mode change and module exit via `cleanupAllLeds()`.

## Architecture

- **DSP plugin** (C, Plugin API v2): Reads audio via `mapped_memory + audio_in_offset`, runs YIN pitch detection, generates feedback tones, outputs via `render_block`.
- **JS UI** (QuickJS): Polls DSP via `host_module_get_param()`, drives 128x64 display, handles input, screen reader announcements, controls pad/step LEDs.
- **22 presets** across 8 categories, defined in `tuner_presets.h`.
- **3 feedback modes**: Step Guide (0), Reference Tone (1), Off (2).
- **3 ref styles**: Sine (0), Pluck (1), Soft Pluck (2).
- **6 pad display modes**: Off, Meter, Strobe Loop, Strobe Ring, Strobe Fill, String Map.
- **5 step display modes**: Off, Meter, Strobe, Presets, Strings.
- **4 screen display modes**: Classic, Strobe, Needle, Offset.

## File Layout

```
src/
  module.json, help.json, ui.js
  dsp/
    tuner_plugin.c     Plugin entry, V2 API, set_param/get_param, state JSON, DLOG impl
    tuner_engine.h/c   YIN pitch detection (with best local estimate)
    tuner_audio.h/c    Audio feedback (step guide with guide_in_tune latch, reference tone, pluck)
    tuner_presets.h    22 instrument presets grouped by category
    tuner_debug.h      Compile-time debug macro (DLOG)
scripts/
  build.sh             Build script (--debug flag, JS stripping, ARM64 cross-compilation)
  install.sh           Deploy to Move hardware
  version.sh           Update version numbers
  Dockerfile           Docker build environment
```

## Build System

- **Release**: `./scripts/build.sh` -- DLOG compiles to `((void)0)`, `/*DEBUG*/` JS lines stripped
- **Debug**: `./scripts/build.sh --debug` -- Full DLOG logging, JS debug lines included
- **Compiler flags**: `-mcpu=cortex-a72 -ffast-math -flto` for NEON auto-vectorization and LTO

## Debug System

- **C-side**: `DLOG(fmt, ...)` macro in `tuner_debug.h`. Zero overhead in release. Enable with `-DTUNER_DEBUG`.
- **JS-side**: `/*DEBUG*/ console.log(...)` lines. Stripped by `grep -v` in release builds.
- **Always-on logs**: 4 lifecycle events (init, create, destroy, state restore) use `g_host->log()` directly.
- **Rate limiting**: Noise gate rejections every 50th, audio updates every 100th, render diagnostics every 689th block (~2s).

## Code Style

- **C**: `snake_case`, `tuner_` prefix for public functions. Debug: `DLOG("message")`. Always-on: `g_host->log("[tuner] message")`.
- **JS**: `camelCase` for locals, `snake_case` for host API. Debug: `/*DEBUG*/ console.log('[tuner-ui] message')`.
- GPLv3 license headers on all source files. Copyright: Jeremiah Ticket.

## Testing

Manual testing on hardware only. Deploy with `install.sh`, monitor debug log via SSH.
