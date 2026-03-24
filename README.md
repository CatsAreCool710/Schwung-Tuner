# Schwung Tuner

Instrument tuner module for the [Schwung](https://github.com/charlesvestal/move-everything) framework on Ableton Move hardware. Accessibility-first design with screen reader integration and auditory feedback.

## Downloads

Available in the Schwung module store, via the [Schwung Installer](https://github.com/charlesvestal/move-everything-installer), or as manual downloads from the [Releases page](https://github.com/CatsAreCool710/Move-Everything-Tuner/releases).

## Introduction

Schwung Tuner brings a full-featured instrument tuner to Ableton Move. It detects pitch from the Move's built-in microphone or line input using the YIN algorithm and provides three auditory feedback modes so you can tune without looking at a screen. The module was designed from the ground up for blind and visually impaired musicians, with complete screen reader integration via the Schwung shared accessibility system.

## Features

- 22 instrument tuning presets across 8 categories (guitar, bass, 12-string, ukulele, lap steel, bowed strings, and more)
- Three feedback modes: Step Guide (melodic interval figure), Reference Tone, and Off
- Three reference tone styles: Sine, Pluck (Karplus-Strong), and Soft Pluck (gentle pizzicato for bowed instruments)
- Per-instrument default ref style with auto-selection (pluck for guitar/bass, soft pluck for violin/viola/cello, sine for chromatic)
- YIN pitch detection from mic or line-in with configurable noise gate
- Screen reader announcements for all controls, note detection, and tuning status
- Configurable step guide timing (tone length and gap)
- A4 reference frequency adjustment (410-480 Hz)
- Passthrough mode for headphone use with spoken tuning feedback
- State persistence via JSON serialization

## Requirements

- Ableton Move hardware
- [Schwung](https://github.com/charlesvestal/move-everything) framework installed on the Move
- SSH access to Move (for deployment)
- Docker (for building the DSP plugin)

## Installation

```bash
./scripts/build.sh        # Build via Docker (ARM64 cross-compilation)
./scripts/install.sh      # Deploy to Move device via SSH
```

On Windows/Git Bash, if `build.sh` fails with path issues:
```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/build" -w /build tuner-builder ./scripts/build.sh
```

## Controls

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
| Knob 3 | A4 reference frequency |
| Knob 4 | Noise gate |
| Knob 5 | Tune threshold |

## Instrument Categories

| Category | Presets |
|----------|---------|
| Chromatic | Chromatic (any note) |
| Guitar | Standard, Half Step Down, D Standard, Drop D, Drop DG, Open D, Open G, DADGAD, Nick Drake |
| 12-String | Standard, D Standard |
| Bass | 4-String, 5-String |
| Ukulele | Standard, Half Step Down |
| Lap Steel | C6 |
| Bowed | Violin, Viola, Cello |
| Other | Mandolin, Banjo |

## Settings

Available in the settings menu (Menu button):

- **Instrument** -- select tuning preset
- **Feedback Mode** -- Step Guide, Reference Tone, or Off
- **Auto Detect** -- auto-select nearest note/string from detected pitch
- **Autospeak** -- toggle screen reader announcements
- **A4 Reference** -- 410-480 Hz (default 440)
- **Guide Octave** -- Auto (shift to audible range) or Match (same octave as target)
- **Ref Style** -- Sine, Pluck, or Soft Pluck
- **Auto Ref Style** -- auto-select ref style per instrument
- **Tone Length** -- step guide note duration (50-500ms, default 200)
- **Tone Gap** -- step guide gap between notes (10-200ms, default 40)
- **Passthrough** -- pass mic input to speaker/headphones
- **Ref Mutes Input** -- disable input knobs in reference mode (for headphone override)
- **Feedback Vol** -- feedback tone volume (default 40%)
- **Passthru Vol** -- passthrough volume
- **Threshold** -- in-tune threshold in cents
- **Noise Gate** -- input noise gate level

## Project Structure

```
src/
  module.json          Module metadata and UI hierarchy
  help.json            On-device help content
  ui.js                JavaScript UI (interactive tool)
  dsp/
    tuner_plugin.c     Main plugin entry (V2 API)
    tuner_engine.h/c   YIN pitch detection
    tuner_audio.h/c    Audio feedback generator
    tuner_presets.h    Instrument tuning definitions (22 presets)
scripts/
  build.sh             Docker cross-compilation
  Dockerfile           ARM64 build environment
  install.sh           Deploy to Move device
```

## AI Assistance & Security

This project was developed with AI assistance (Claude by Anthropic) under human direction and review. While care has been taken to ensure correctness, AI-generated code may contain errors or security vulnerabilities. Users should review the source code and use this software at their own risk. No warranty is provided -- see the GPLv3 license for details.

## Third-Party Components

- Some instrument tuning definitions sourced from [bashtuner](https://git.stormux.org/storm/bashtuner) by Storm Dragon and Jeremiah Ticket, licensed under the [WTFPL](http://wtfpl.net).

## Disclaimer

This project is not affiliated with or endorsed by Ableton AG or the Schwung project. Ableton, Ableton Live, and Move are trademarks of Ableton AG.

## License

Copyright (C) 2026 Jeremiah Ticket

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

See [LICENSE](LICENSE) for the full license text.
