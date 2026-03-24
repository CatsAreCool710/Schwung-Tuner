# Schwung Tuner

Chromatic and instrument tuner for Ableton Move hardware. GPLv3, Copyright 2026 Jeremiah Ticket.

## Architecture

- **DSP plugin** (C, Plugin API v2): Reads audio input via `mapped_memory + audio_in_offset`, runs YIN pitch detection, generates feedback tones (step guide, reference sine/pluck/soft-pluck), outputs via `render_block`. 22 presets across 8 categories defined in `tuner_presets.h`.
- **JS UI** (QuickJS): Polls DSP for detection results via `host_module_get_param()`, drives 128x64 monochrome display, handles user input (arrows, jog, knobs, menu), screen reader announcements via ME shared utilities.
- **Audio format**: 44100 Hz, 128 frames/block, stereo interleaved int16.
- **Target**: aarch64 Linux (Ableton Move ARM64).

## Key Constraints

- **ME framework coalesces `set_param` calls**: Only one `host_module_set_param()` per tick reaches the DSP. Use `queueParam()` for commands that must not be dropped (preset changes, mode switches). Use `sendParamNow()` for real-time knob values where only the latest matters. Pattern borrowed from DJ Deck module.
- **Reserved key `mode`**: Intercepted by ME host framework, never reaches plugin `set_param`. Use `tn_inst` (integer preset index) instead.
- **No `chain_params`**: No other ME tool module uses them. They cause the framework to intercept params. Removed entirely.
- **`component_type: "tool"`**: Must be a top-level field in `module.json`, NOT inside `capabilities`.
- **`plugin_api_v2_t`**: Must have exactly 8 fields including `get_error`.
- **Import paths**: Must use absolute paths (`/data/UserData/schwung/shared/...`), never relative.
- **Knob touches**: Arrive as MIDI Note On (note 0-7, velocity > 0). Filtered by `shouldFilterMessage()` by default — must handle BEFORE the filter call.
- **State persistence**: `get_param("state")` returns JSON blob of all settings, `set_param("state", json)` restores them.
- **GPLv3 license headers** required on all source files. Copyright holder: Jeremiah Ticket.

## File Layout

```
src/
  module.json          Module metadata and UI hierarchy (v0.1.0)
  help.json            On-device help content
  ui.js                JavaScript UI (interactive tool)
  dsp/
    tuner_plugin.c     Plugin entry, V2 API, set_param/get_param, state JSON
    tuner_engine.h/c   YIN pitch detection
    tuner_audio.h/c    Audio feedback generator (step guide + reference tone)
    tuner_presets.h    22 instrument presets grouped by 8 categories
scripts/
  build.sh             Docker cross-compilation
  Dockerfile           ARM64 build environment
  install.sh           Deploy to Move device
```

## Build & Deploy

```bash
./scripts/build.sh          # Build via Docker (recommended)
./scripts/install.sh        # Deploy to Move device via SSH
```

On Windows/Git Bash with path issues:
```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/build" -w /build tuner-builder ./scripts/build.sh
```

Debug log: `ssh ableton@move.local "tail -f /data/UserData/schwung/debug.log"`

## Code Style

- **C**: `snake_case`, `tuner_` prefix for public engine/audio functions. Log: `g_host->log("[tuner] message")`.
- **JS**: `camelCase` for local vars, `snake_case` for host API calls. Log: `console.log()`.
- Use `cat` instead of `cp` in build scripts (Docker volume compatibility).

## Control Mapping (Tuner View)

| Control | Action |
|---------|--------|
| Up/Down arrows | Select note (chromatic) or string (instrument) |
| Left/Right arrows | Change octave (chromatic mode) |
| Jog wheel | Cycle presets within current category |
| Shift+Jog wheel | Jump between categories |
| Jog click | Announce current tuning state |
| Shift+Jog click | Cycle feedback mode (Step Guide / Reference / Off) |
| Shift+Back | Toggle autospeak |
| Back | Exit tuner |
| Menu | Open settings |
| Knob 1 | Feedback volume |
| Knob 2 | Passthrough volume |
| Knob 3 | A4 reference |
| Knob 4 | Noise gate |
| Knob 5 | Tune threshold |

## Key Constants

- Arrow CCs: `MoveUp=55`, `MoveDown=54`, `MoveLeft=62`, `MoveRight=63`
- `MoveMainKnob=14`, `MoveMainButton=3`, `MoveBack=51`, `MoveMenu=50`, `MoveShift=49`
- `MoveKnob1=71` through `MoveKnob8=78`
- Feedback modes: `TUNER_FB_STEP_GUIDE=0`, `TUNER_FB_REFERENCE=1`, `TUNER_FB_OFF=2`
- Reference styles: `TUNER_REF_SINE=0`, `TUNER_REF_PLUCK=1`, `TUNER_REF_SOFT_PLUCK=2`
- 22 presets, 8 categories (Chromatic, Guitar, 12-String, Bass, Ukulele, Lap Steel, Bowed, Other)
- Guide timing defaults: 200ms tone, 40ms gap, 800ms cooldown
- Feedback volume default: 40%
- Detection hold: 689 blocks (~2 seconds)

## Preset Categories

| Category | Indices | Presets |
|----------|---------|---------|
| Chromatic | 0 | Chromatic |
| Guitar | 1-9 | Standard, Half Step Down, D Standard, Drop D, Drop DG, Open D, Open G, DADGAD, Nick Drake |
| 12-String | 10-11 | Standard, D Standard |
| Bass | 12-13 | 4-String, 5-String |
| Ukulele | 14-15 | Standard, Half Step Down |
| Lap Steel | 16 | C6 |
| Bowed | 17-19 | Violin, Viola, Cello |
| Other | 20-21 | Mandolin, Banjo |

## Move Hardware Notes

- Move mic/speaker feedback loop: Speaker output feeds back into mic at ~0.65 peak. Detector MUST be frozen during tone playback AND 800ms cooldown.
- Ambient noise floor: ~0.03-0.05 peak. Noise gate default 0.002 RMS.
- Quiet threshold for step guide: 0.12 peak (above ambient, catches feedback ringing).
- `mapped_memory=0x7f8f851000, audio_in_offset=2304, audio_out_offset=256, sr=44100, fpb=128`
- Display API: `clear_screen()`, `print(x,y,text,color)`, `fill_rect(x,y,w,h,color)`, `set_pixel(x,y,color)`, `text_width(str)`. 128x64 mono, 5x7 font (6px wide, 8px tall).

## Testing

Manual testing on hardware only. Deploy with `./scripts/install.sh`, then:
```bash
ssh ableton@move.local "tail -f /data/UserData/schwung/debug.log"
```
