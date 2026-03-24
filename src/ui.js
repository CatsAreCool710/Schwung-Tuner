/*
 * ui.js - Schwung Tuner UI
 *
 * Copyright (C) 2026 Jeremiah Ticket
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * Interactive tool module UI that:
 *   - Polls DSP for pitch detection results
 *   - Renders tuner display (128x64, 1-bit monochrome)
 *   - Handles knob/button/jog/arrow input
 *   - Drives screen reader announcements (autospeak)
 *   - Uses ME shared utilities for menu system and input filtering
 *   - Drives pad LEDs, step LEDs, and multiple screen display modes
 */

/* -------------------------------------------------------------------------- */
/* Imports from Schwung shared utilities (absolute paths)              */
/* -------------------------------------------------------------------------- */

import { announce, announceParameter, announceView }
    from '/data/UserData/schwung/shared/screen_reader.mjs';
import { shouldFilterMessage, decodeDelta, setLED, setButtonLED }
    from '/data/UserData/schwung/shared/input_filter.mjs';
import {
    MidiCC, MidiNoteOn,
    MoveKnob1, MoveKnob5, MoveKnob8,
    MoveMainKnob, MoveMainButton, MoveShift, MoveBack, MoveMenu,
    MoveUp, MoveDown, MoveLeft, MoveRight,
    BrightGreen, VividYellow, BrightRed, Black, White, DullGreen,
    DarkGrassGreen, Bright, Cyan, MoveStep1, MoveStep16, MoveSteps,
    PaleCyan
} from '/data/UserData/schwung/shared/constants.mjs';
import { createValue, createToggle, createEnum, formatItemValue }
    from '/data/UserData/schwung/shared/menu_items.mjs';
import { createMenuState, handleMenuInput }
    from '/data/UserData/schwung/shared/menu_nav.mjs';
import { createMenuStack }
    from '/data/UserData/schwung/shared/menu_stack.mjs';
import { drawHierarchicalMenu }
    from '/data/UserData/schwung/shared/menu_render.mjs';

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const DISPLAY_W = 128;
const DISPLAY_H = 64;
const CHAR_W = 6;   /* 5x7 font, 6px per char including spacing */
const CHAR_H = 8;

/* Instrument preset IDs (must match tuner_presets.h order) */
const MODE_IDS = [
    'chromatic',                                                       /* 0  */
    'guitar', 'guitar_halfdown', 'guitar_dstd', 'guitar_dropd',       /* 1-4 */
    'guitar_dropdg', 'guitar_opend', 'guitar_openg', 'guitar_dadgad', /* 5-8 */
    'guitar_nickdrake',                                                /* 9  */
    '12string', '12string_d',                                          /* 10-11 */
    'bass', 'bass5',                                                   /* 12-13 */
    'ukulele', 'ukulele_halfdown',                                     /* 14-15 */
    'steel_c6',                                                        /* 16 */
    'violin', 'viola', 'cello',                                        /* 17-19 */
    'mandolin', 'banjo'                                                /* 20-21 */
];

const MODE_NAMES = [
    'Chromatic',
    'Guitar', 'Gtr Half Step Dn', 'Gtr D Standard', 'Gtr Drop D',
    'Gtr Drop DG', 'Gtr Open D', 'Gtr Open G', 'Gtr DADGAD',
    'Gtr Nick Drake',
    '12-String', '12-Str D Std',
    'Bass', 'Bass 5-String',
    'Ukulele', 'Uke Half Step Dn',
    'Lap Steel C6',
    'Violin', 'Viola', 'Cello',
    'Mandolin', 'Banjo'
];

/* String counts per preset (must match tuner_presets.h order) */
const MODE_STRING_COUNTS = [
    0,                         /* chromatic */
    6, 6, 6, 6, 6, 6, 6, 6, 6, /* guitar (9 tunings) */
    10, 10,                    /* 12-string */
    4, 5,                      /* bass */
    4, 4,                      /* ukulele */
    6,                         /* lap steel */
    4, 4, 4,                   /* bowed */
    4, 5                       /* mandolin, banjo */
];

/* Default ref style per preset (must match tuner_presets.h order) */
const PRESET_DEFAULT_REF_STYLES = [
    'sine',                                                   /* chromatic */
    'pluck', 'pluck', 'pluck', 'pluck', 'pluck',             /* guitar */
    'pluck', 'pluck', 'pluck', 'pluck',                       /* guitar cont. */
    'pluck', 'pluck',                                         /* 12-string */
    'pluck', 'pluck',                                         /* bass */
    'pluck', 'pluck',                                         /* ukulele */
    'pluck',                                                  /* lap steel */
    'soft_pluck', 'soft_pluck', 'soft_pluck',                 /* bowed */
    'pluck', 'pluck'                                          /* mandolin, banjo */
];

/* Preset categories for Shift+Jog navigation */
const CATEGORIES = [
    { name: 'Chromatic',  start: 0,  end: 0 },
    { name: 'Guitar',     start: 1,  end: 9 },
    { name: '12-String',  start: 10, end: 11 },
    { name: 'Bass',       start: 12, end: 13 },
    { name: 'Ukulele',    start: 14, end: 15 },
    { name: 'Lap Steel',  start: 16, end: 16 },
    { name: 'Bowed',      start: 17, end: 19 },
    { name: 'Other',      start: 20, end: 21 },
];

/* Feedback modes: step_guide, reference, off */
const FEEDBACK_IDS = ['step_guide', 'reference', 'off'];
const FEEDBACK_NAMES = ['Step Guide', 'Reference Tone', 'Off'];

const GUIDE_OCTAVE_IDS = ['auto', 'match'];
const GUIDE_OCTAVE_NAMES = ['Auto', 'Match'];

const REF_STYLE_IDS = ['sine', 'pluck', 'soft_pluck'];
const REF_STYLE_NAMES = ['Sine', 'Pluck', 'Soft Pluck'];

/* Chromatic note names for display and announcement */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/* Autospeak timing */
const AUTOSPEAK_DEBOUNCE_MS = 2000;
const AUTOSPEAK_CLOSE_DEBOUNCE_MS = 3000;
const NOTE_STABLE_MS = 800;

/* Pad display modes */
const PAD_OFF = 0;
const PAD_METER = 1;
const PAD_STROBE_LOOP = 2;
const PAD_STROBE_RING = 3;
const PAD_STROBE_FILL = 4;
const PAD_STRING_MAP = 5;
const PAD_MODE_NAMES = ['Off', 'Meter', 'Strobe Loop', 'Strobe Ring', 'Strobe Fill', 'String Map'];

/* Step display modes */
const STEP_OFF = 0;
const STEP_METER = 1;
const STEP_STROBE = 2;
const STEP_PRESETS = 3;
const STEP_STRINGS = 4;
const STEP_MODE_NAMES = ['Off', 'Meter', 'Strobe', 'Presets', 'Strings'];

/* Screen display modes */
const SCREEN_CLASSIC = 0;
const SCREEN_STROBE = 1;
const SCREEN_NEEDLE = 2;
const SCREEN_OFFSET = 3;
const SCREEN_MODE_NAMES = ['Classic', 'Strobe', 'Needle', 'Offset'];

/* Strobe animation speed factor */
const STROBE_SPEED = 0.15;

/* Pad note layout: 4 rows x 8 cols, bottom-left=68, top-right=99 */
const PAD_NOTE_START = 68;

/* Strobe paths (arrays of pad note numbers) */
const STROBE_LOOP_PATH = [84,85,86,87,88,89,90,91, 83, 82,81,80,79,78,77,76]; /* middle 16 ring */
const STROBE_RING_PATH = [92,93,94,95,96,97,98,99, 91,83,75, 74,73,72,71,70,69,68, 76,84]; /* all 32 perimeter, 22 unique */
const STROBE_FILL_PATH = [84,85,86,87,88,89,90,91, 83,82,81,80,79,78,77,76]; /* serpentine */

/* Meter color thresholds */
function centsToColor(absCents) {
    if (absCents <= 2) return BrightGreen;
    if (absCents <= 10) return VividYellow;
    if (absCents <= 25) return Bright; /* orange */
    return BrightRed;
}

/* Needle arc pre-computed points */
const ARC_POINTS = [];
for (let deg = -80; deg <= 80; deg += 3) {
    const rad = deg * Math.PI / 180;
    ARC_POINTS.push({
        x: 64 + Math.round(28 * Math.sin(rad)),
        y: 36 - Math.round(28 * Math.cos(rad)),
        deg: deg
    });
}

/* -------------------------------------------------------------------------- */
/* Drawing helpers                                                             */
/* -------------------------------------------------------------------------- */

function hLine(x, y, w, c) {
    fill_rect(x, y, w, 1, c);
}

function vLine(x, y, h, c) {
    fill_rect(x, y, 1, h, c);
}

function drawRectOutline(x, y, w, h, c) {
    fill_rect(x, y, w, 1, c);         /* top */
    fill_rect(x, y + h - 1, w, 1, c); /* bottom */
    fill_rect(x, y, 1, h, c);         /* left */
    fill_rect(x + w - 1, y, 1, h, c); /* right */
}

function printCentered(y, text, color) {
    const w = text.length * CHAR_W;
    const x = Math.max(0, Math.floor((DISPLAY_W - w) / 2));
    print(x, y, text, color === undefined ? 1 : color);
}

function printRight(y, text, color) {
    const w = text.length * CHAR_W;
    const x = Math.max(0, DISPLAY_W - w - 1);
    print(x, y, text, color === undefined ? 1 : color);
}

/* -------------------------------------------------------------------------- */
/* Utility: MIDI note to name                                                  */
/* -------------------------------------------------------------------------- */

function midiToNoteName(midi) {
    if (midi < 0 || midi > 127) return '---';
    const noteIdx = midi % 12;
    const octave = Math.floor(midi / 12) - 1;
    return NOTE_NAMES[noteIdx] + octave;
}

/* Screen-reader friendly: "C sharp 4" instead of "C#4" */
function midiToSpokenName(midi) {
    if (midi < 0 || midi > 127) return 'unknown';
    const noteIdx = midi % 12;
    const octave = Math.floor(midi / 12) - 1;
    const name = NOTE_NAMES[noteIdx].replace('#', ' sharp');
    return name + ' ' + octave;
}

/* Convert string label "E2" or "G#3" to spoken form "E 2" or "G sharp 3" */
function labelToSpoken(label) {
    if (!label || label === '---') return 'unknown';
    return label.replace('#', ' sharp').replace(/([A-G](?:\ssharp)?)(\d)/, '$1 $2');
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

let shiftHeld = false;
let inMenu = false;

/* Values polled from DSP */
let detectedNote = '---';
let detectedFreq = 0;
let centsOffset = 0;
let inTune = false;
let hasSignal = false;
let targetNote = '---';

/* Settings (mirrors DSP state) */
let modeIndex = 0;
let feedbackIndex = 0;     /* 0=step_guide */
let autospeakOn = true;
let a4Ref = 440;
let guideOctave = 'auto';
let refStyle = 'sine';
let passthrough = false;
let feedbackVolume = 40;
let passthroughVolume = 0;
let tuneThreshold = 3;
let noiseGate = 20;        /* matches module.json default */
let stringIndex = 0;
let stringCount = 0;
let stringLabel = '---';
let autoDetect = false;    /* manual note selection by default */
let manualMidi = 60;       /* C4 */
let refStyleAuto = true;   /* auto-select ref style per instrument */
let guideToneMs = 200;     /* step guide note duration */
let guideGapMs = 40;       /* step guide gap between notes */
let refMuteInput = true;   /* mute input knobs in reference mode */
let categoryIndex = 0;     /* current category (derived from modeIndex) */

/* Autospeak tracking */
let lastSpokenNote = '';
let lastSpokenCents = 0;
let lastSpeakTime = 0;
let noteStableStart = 0;
let noteStableNote = '';
let hasSpokenInitial = false;
let hasSpokenInTune = false;

/* Tick counter for polling rate */
let tickCount = 0;

/* Visual display modes */
let padDisplayMode = PAD_OFF;
let stepDisplayMode = STEP_OFF;
let screenDisplayMode = SCREEN_CLASSIC;

/* Strobe animation state */
let strobePhase = 0;
let stepStrobePhase = 0;
let prevPadLedIndex = -1;
let prevStepLedIndex = -1;

/* Screen strobe state */
let screenStrobePhase = 0;

/* LED tracking for cleanup */
let activePadLeds = new Set();
let activeStepLeds = new Set();

/* Pad block state */
let padBlocked = false;

/* Previous string index for auto-detect announce */
let prevAutoStringIndex = -1;

/* LED update throttle */
let ledTickCounter = 0;

/* -------------------------------------------------------------------------- */
/* Menu system                                                                 */
/* -------------------------------------------------------------------------- */

let menuState = null;
let menuStack = null;

function buildMenuItems() {
    return [
        createEnum('Instrument', {
            get: function() { return MODE_IDS[modeIndex]; },
            set: function(val) {
                modeIndex = MODE_IDS.indexOf(val);
                if (modeIndex < 0) modeIndex = 0;
                categoryIndex = getCategoryForPreset(modeIndex);
                stringIndex = 0;
                /* DSP resets string_index internally on preset change */
                queueParam('tn_inst', String(modeIndex));
                stringCount = MODE_STRING_COUNTS[modeIndex];
            },
            options: MODE_IDS,
            format: function(val) { return MODE_NAMES[MODE_IDS.indexOf(val)] || val; }
        }),
        createEnum('Feedback', {
            get: function() { return FEEDBACK_IDS[feedbackIndex]; },
            set: function(val) {
                feedbackIndex = FEEDBACK_IDS.indexOf(val);
                if (feedbackIndex < 0) feedbackIndex = 1; /* off */
                queueParam('feedback_mode', val);
            },
            options: FEEDBACK_IDS,
            format: function(val) { return FEEDBACK_NAMES[FEEDBACK_IDS.indexOf(val)] || val; }
        }),
        createToggle('Auto Detect', {
            get: function() { return autoDetect; },
            set: function(val) {
                autoDetect = val;
                queueParam('auto_detect', val ? 'on' : 'off');
            }
        }),
        createToggle('Autospeak', {
            get: function() { return autospeakOn; },
            set: function(val) {
                autospeakOn = val;
                queueParam('autospeak', val ? 'on' : 'off');
            }
        }),
        createValue('A4 Reference', {
            get: function() { return a4Ref; },
            set: function(val) {
                a4Ref = val;
                sendParamNow('a4_ref', String(val));
            },
            min: 410, max: 480, step: 1,
            format: function(v) { return v + ' Hz'; }
        }),
        createEnum('Guide Octave', {
            get: function() { return guideOctave; },
            set: function(val) {
                guideOctave = val;
                queueParam('guide_octave', val);
            },
            options: GUIDE_OCTAVE_IDS,
            format: function(val) { return GUIDE_OCTAVE_NAMES[GUIDE_OCTAVE_IDS.indexOf(val)] || val; }
        }),
        createEnum('Ref Style', {
            get: function() { return refStyle; },
            set: function(val) {
                refStyle = val;
                queueParam('ref_style', val);
            },
            options: REF_STYLE_IDS,
            format: function(val) { return REF_STYLE_NAMES[REF_STYLE_IDS.indexOf(val)] || val; }
        }),
        createToggle('Auto Ref Style', {
            get: function() { return refStyleAuto; },
            set: function(val) {
                refStyleAuto = val;
                queueParam('ref_style_auto', val ? 'on' : 'off');
            }
        }),
        createValue('Tone Length', {
            get: function() { return guideToneMs; },
            set: function(val) {
                guideToneMs = val;
                queueParam('guide_tone_ms', String(val));
            },
            min: 50, max: 500, step: 25,
            format: function(v) { return v + ' ms'; }
        }),
        createValue('Tone Gap', {
            get: function() { return guideGapMs; },
            set: function(val) {
                guideGapMs = val;
                queueParam('guide_gap_ms', String(val));
            },
            min: 10, max: 200, step: 10,
            format: function(v) { return v + ' ms'; }
        }),
        createToggle('Passthrough', {
            get: function() { return passthrough; },
            set: function(val) {
                passthrough = val;
                queueParam('passthrough', val ? 'on' : 'off');
            }
        }),
        createToggle('Ref Mutes Input', {
            get: function() { return refMuteInput; },
            set: function(val) {
                refMuteInput = val;
                queueParam('ref_mute_input', val ? 'on' : 'off');
            }
        }),
        createValue('Feedback Vol', {
            get: function() { return feedbackVolume; },
            set: function(val) {
                feedbackVolume = val;
                sendParamNow('feedback_volume', String(val));
            },
            min: 0, max: 100, step: 5,
            format: function(v) { return v + '%'; }
        }),
        createValue('Passthru Vol', {
            get: function() { return passthroughVolume; },
            set: function(val) {
                passthroughVolume = val;
                sendParamNow('passthrough_volume', String(val));
            },
            min: 0, max: 100, step: 5,
            format: function(v) { return v + '%'; }
        }),
        createValue('Threshold', {
            get: function() { return tuneThreshold; },
            set: function(val) {
                tuneThreshold = val;
                sendParamNow('tune_threshold', String(val));
            },
            min: 1, max: 10, step: 1,
            format: function(v) { return v + ' cents'; }
        }),
        createValue('Noise Gate', {
            get: function() { return noiseGate; },
            set: function(val) {
                noiseGate = val;
                sendParamNow('noise_gate', String(val));
            },
            min: 0, max: 100, step: 5,
            format: function(v) { return v + '%'; }
        }),
        createEnum('Pad Display', {
            get: function() { return padDisplayMode; },
            set: function(val) {
                cleanupPadLeds();
                padDisplayMode = val;
                onPadModeChange();
            },
            options: [0, 1, 2, 3, 4, 5],
            format: function(val) { return PAD_MODE_NAMES[val] || 'Off'; }
        }),
        createEnum('Step Display', {
            get: function() { return stepDisplayMode; },
            set: function(val) {
                cleanupStepLeds();
                stepDisplayMode = val;
            },
            options: [0, 1, 2, 3, 4],
            format: function(val) { return STEP_MODE_NAMES[val] || 'Off'; }
        }),
        createEnum('Screen Display', {
            get: function() { return screenDisplayMode; },
            set: function(val) { screenDisplayMode = val; },
            options: [0, 1, 2, 3],
            format: function(val) { return SCREEN_MODE_NAMES[val] || 'Classic'; }
        }),
    ];
}

let menuItems = [];

/* -------------------------------------------------------------------------- */
/* DSP communication                                                           */
/* -------------------------------------------------------------------------- */

/*
 * Parameter queue — the ME framework coalesces back-to-back set_param calls,
 * so only one param per tick is delivered to the DSP plugin. Use queueParam()
 * for commands that must not be dropped. Use sendParamNow() for real-time
 * controls where only the latest value matters (knobs, volume, etc).
 * Pattern borrowed from the DJ Deck module.
 */
let paramQueue = [];

function getParam(key) {
    try { return host_module_get_param(key); }
    catch (e) { return ''; }
}

/* Send immediately — use for real-time knob values */
function sendParamNow(key, val) {
    try { host_module_set_param(key, String(val)); }
    catch (e) { /* ignore */ }
}

/* Queue for next tick — use for commands that must not be dropped */
function queueParam(key, val) {
    paramQueue.push([key, String(val)]);
}

/* Drain one queued param per tick (called from tick()) */
function drainParamQueue() {
    if (paramQueue.length > 0) {
        let p = paramQueue.shift();
        try { host_module_set_param(p[0], p[1]); }
        catch (e) { /* ignore */ }
    }
}

function pollDSP() {
    detectedNote = getParam('detected_note') || '---';
    detectedFreq = parseFloat(getParam('detected_freq')) || 0;
    centsOffset = parseInt(getParam('cents_offset')) || 0;
    inTune = getParam('in_tune') === '1';
    hasSignal = getParam('has_signal') === '1';
    targetNote = getParam('target_note') || '---';

    /* String count from local table (always in sync with modeIndex) */
    stringCount = MODE_STRING_COUNTS[modeIndex];
    if (stringCount > 0) {
        stringLabel = getParam('string_label') || '---';
    }

    /* Sync string_index from DSP (auto-detect may change it) */
    if (autoDetect && stringCount > 0) {
        const dspIdx = parseInt(getParam('string_index'));
        if (!isNaN(dspIdx)) {
            if (dspIdx !== prevAutoStringIndex && prevAutoStringIndex >= 0) {
                const newLabel = getParam('string_label') || '---';
                announce('String ' + labelToSpoken(newLabel));
                /*DEBUG*/ console.log('[tuner-ui] auto string change: ' + prevAutoStringIndex + '->' + dspIdx);
            }
            prevAutoStringIndex = dspIdx;
            stringIndex = dspIdx;
            stringLabel = getParam('string_label') || '---';
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Autospeak logic                                                             */
/* -------------------------------------------------------------------------- */

function autospeakTick() {
    if (!autospeakOn || !hasSignal) {
        /* Reset tracking when no signal */
        noteStableNote = '';
        noteStableStart = 0;
        hasSpokenInitial = false;
        hasSpokenInTune = false;
        return;
    }

    const now = Date.now();

    /* Track note stability */
    if (detectedNote !== noteStableNote) {
        noteStableNote = detectedNote;
        noteStableStart = now;
        hasSpokenInitial = false;
        hasSpokenInTune = false;
    }

    const stableTime = now - noteStableStart;
    const timeSinceSpeak = now - lastSpeakTime;

    /* Speak initial detection after note is stable.
     * In reference mode (no detection), offset speech is gated on passthrough
     * since without hearing your instrument the spoken offset isn't actionable.
     * In step guide and off modes, always speak the full offset — the user
     * is actively playing and needs to know how far off they are. */
    const isRefMode = feedbackIndex === 1;
    const speakOffset = !isRefMode || passthrough;

    if (!hasSpokenInitial && stableTime >= NOTE_STABLE_MS) {
        if (speakOffset) {
            const dir = centsOffset > 0 ? 'sharp' : centsOffset < 0 ? 'flat' : '';
            if (inTune) {
                announce(detectedNote + ', in tune');
                /*DEBUG*/ console.log('[tuner-ui] speak: ' + detectedNote + ', in tune');
                hasSpokenInTune = true;
            } else {
                announce(detectedNote + ', ' + Math.abs(centsOffset) + ' cents ' + dir);
                /*DEBUG*/ console.log('[tuner-ui] speak: ' + detectedNote + ', ' + Math.abs(centsOffset) + ' cents ' + dir);
            }
        } else {
            /* Reference mode without passthrough — just announce the note name */
            announce(detectedNote);
            /*DEBUG*/ console.log('[tuner-ui] speak: ' + detectedNote);
        }
        hasSpokenInitial = true;
        lastSpokenNote = detectedNote;
        lastSpokenCents = centsOffset;
        lastSpeakTime = now;
        return;
    }

    /* Periodic cents updates: in reference mode, only with passthrough */
    if (!speakOffset) return;

    /* In-tune confirmation (speak once) */
    if (hasSpokenInitial && !hasSpokenInTune && inTune) {
        if (timeSinceSpeak >= 500) {
            announce(detectedNote + ', in tune');
            /*DEBUG*/ console.log('[tuner-ui] speak: ' + detectedNote + ', in tune (confirmed)');
            hasSpokenInTune = true;
            lastSpeakTime = now;
        }
        return;
    }

    /* Periodic updates while held — back off when close */
    if (hasSpokenInitial && !inTune) {
        const debounce = Math.abs(centsOffset) < 10
            ? AUTOSPEAK_CLOSE_DEBOUNCE_MS
            : AUTOSPEAK_DEBOUNCE_MS;

        if (timeSinceSpeak >= debounce) {
            const dir = centsOffset > 0 ? 'sharp' : 'flat';
            announce(Math.abs(centsOffset) + ' cents ' + dir);
            lastSpokenCents = centsOffset;
            lastSpeakTime = now;
        }
    }
}

/* -------------------------------------------------------------------------- */
/* LED Helper Functions                                                        */
/* -------------------------------------------------------------------------- */

function setPadLed(note, color) {
    activePadLeds.add(note);
    setLED(note, color);
}

function setStepLed(note, color) {
    activeStepLeds.add(note);
    setLED(note, color);
}

function cleanupPadLeds() {
    /*DEBUG*/ console.log('[tuner-ui] led: cleanup pads=' + activePadLeds.size + ' steps=' + activeStepLeds.size);
    for (const note of activePadLeds) {
        setLED(note, Black);
    }
    activePadLeds.clear();
    if (padBlocked) {
        try { host_pad_block(0); } catch(e) {}
        padBlocked = false;
    }
}

function cleanupStepLeds() {
    for (const note of activeStepLeds) {
        setLED(note, Black);
    }
    activeStepLeds.clear();
}

function cleanupAllLeds() {
    cleanupPadLeds();
    cleanupStepLeds();
}

function onPadModeChange() {
    if (padDisplayMode === PAD_STRING_MAP) {
        try { host_pad_block(1); } catch(e) {}
        padBlocked = true;
    } else if (padBlocked) {
        try { host_pad_block(0); } catch(e) {}
        padBlocked = false;
    }
    strobePhase = 0;
    prevPadLedIndex = -1;
}

/* -------------------------------------------------------------------------- */
/* Pad Display Renderers                                                       */
/* -------------------------------------------------------------------------- */

function updatePadDisplay() {
    switch (padDisplayMode) {
        case PAD_METER: updatePadMeter(); break;
        case PAD_STROBE_LOOP: updatePadStrobe(STROBE_LOOP_PATH); break;
        case PAD_STROBE_RING: updatePadStrobe(STROBE_RING_PATH); break;
        case PAD_STROBE_FILL: updatePadStrobe(STROBE_FILL_PATH); break;
        case PAD_STRING_MAP: updatePadStringMap(); break;
    }
}

function updatePadMeter() {
    /* Bottom row of 8 pads (notes 68-75) as segmented meter */
    const pads = [68, 69, 70, 71, 72, 73, 74, 75];
    if (!hasSignal) {
        for (let i = 0; i < 8; i++) setPadLed(pads[i], Black);
        return;
    }
    /* Map cents to meter: center = pads 3,4 (indices 3,4 = notes 71,72) */
    for (let i = 0; i < 8; i++) {
        if (inTune) {
            /* In tune: center 2 pads green */
            setPadLed(pads[i], (i === 3 || i === 4) ? BrightGreen : Black);
        } else {
            /* Map direction: left = flat, right = sharp */
            const needlePos = 3.5 + (centsOffset / 50) * 3.5;
            const dist = Math.abs(i - needlePos);
            if (dist < 1.5) {
                setPadLed(pads[i], centsToColor(Math.abs(centsOffset)));
            } else {
                setPadLed(pads[i], Black);
            }
        }
    }
}

function updatePadStrobe(path) {
    if (!hasSignal) {
        for (let i = 0; i < path.length; i++) setPadLed(path[i], Black);
        strobePhase = 0;
        return;
    }
    if (inTune) {
        /* In tune: all pads steady green */
        for (let i = 0; i < path.length; i++) setPadLed(path[i], BrightGreen);
        strobePhase = 0;
        return;
    }
    /* Chase animation */
    strobePhase += centsOffset * STROBE_SPEED;
    const len = path.length;
    const idx = ((Math.floor(strobePhase) % len) + len) % len;

    if (idx !== prevPadLedIndex) {
        /* Clear previous, light new */
        for (let i = 0; i < len; i++) {
            if (i === idx || i === (idx + 1) % len) {
                setPadLed(path[i], centsToColor(Math.abs(centsOffset)));
            } else {
                setPadLed(path[i], Black);
            }
        }
        prevPadLedIndex = idx;
    }
}

function updatePadStringMap() {
    if (stringCount <= 0) return;
    const absCents = Math.abs(centsOffset);

    for (let s = 0; s < stringCount && s < 8; s++) {
        const col = s;
        const color = (s === stringIndex && hasSignal) ? centsToColor(absCents) :
                      (s === stringIndex) ? White : DarkGrassGreen;
        for (let row = 0; row < 4; row++) {
            const note = 68 + (3 - row) * 8 + col;
            setPadLed(note, color);
        }
    }
    /* Clear unused columns */
    for (let col = stringCount; col < 8; col++) {
        for (let row = 0; row < 4; row++) {
            const note = 68 + (3 - row) * 8 + col;
            setPadLed(note, Black);
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Step Display Renderers                                                      */
/* -------------------------------------------------------------------------- */

function updateStepDisplay() {
    switch (stepDisplayMode) {
        case STEP_METER: updateStepMeter(); break;
        case STEP_STROBE: updateStepStrobe(); break;
        case STEP_PRESETS: updateStepPresets(); break;
        case STEP_STRINGS: updateStepStrings(); break;
    }
}

function updateStepMeter() {
    if (!hasSignal) {
        for (let i = 0; i < 16; i++) setStepLed(16 + i, Black);
        return;
    }
    const center = 7.5;
    for (let i = 0; i < 16; i++) {
        if (inTune) {
            setStepLed(16 + i, (i === 7 || i === 8) ? BrightGreen : Black);
        } else {
            const needlePos = center + (centsOffset / 50) * center;
            const dist = Math.abs(i - needlePos);
            if (dist < 1.5) {
                setStepLed(16 + i, centsToColor(Math.abs(centsOffset)));
            } else {
                setStepLed(16 + i, Black);
            }
        }
    }
}

function updateStepStrobe() {
    if (!hasSignal) {
        for (let i = 0; i < 16; i++) setStepLed(16 + i, Black);
        stepStrobePhase = 0;
        return;
    }
    if (inTune) {
        for (let i = 0; i < 16; i++) setStepLed(16 + i, BrightGreen);
        stepStrobePhase = 0;
        return;
    }
    stepStrobePhase += centsOffset * STROBE_SPEED;
    const idx = ((Math.floor(stepStrobePhase) % 16) + 16) % 16;
    if (idx !== prevStepLedIndex) {
        for (let i = 0; i < 16; i++) {
            if (i === idx || i === (idx + 1) % 16) {
                setStepLed(16 + i, centsToColor(Math.abs(centsOffset)));
            } else {
                setStepLed(16 + i, Black);
            }
        }
        prevStepLedIndex = idx;
    }
}

function updateStepPresets() {
    const cat = CATEGORIES[categoryIndex];
    const catSize = cat.end - cat.start + 1;
    for (let i = 0; i < 16; i++) {
        if (i < catSize) {
            const presetIdx = cat.start + i;
            if (presetIdx === modeIndex) {
                setStepLed(16 + i, BrightGreen);
            } else {
                setStepLed(16 + i, White);
            }
        } else {
            setStepLed(16 + i, Black);
        }
    }
}

function updateStepStrings() {
    if (stringCount <= 0) {
        /* Chromatic mode: fall back to meter */
        updateStepMeter();
        return;
    }
    for (let i = 0; i < 16; i++) {
        if (i < stringCount) {
            if (i === stringIndex && hasSignal) {
                setStepLed(16 + i, centsToColor(Math.abs(centsOffset)));
            } else if (i === stringIndex) {
                setStepLed(16 + i, White);
            } else {
                setStepLed(16 + i, DullGreen);
            }
        } else {
            setStepLed(16 + i, Black);
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Display rendering                                                           */
/* -------------------------------------------------------------------------- */

/* Shared header for all screen modes */
function drawHeader() {
    const modeName = MODE_NAMES[modeIndex] || 'Chromatic';
    print(1, 0, modeName, 1);
    printRight(0, 'A=' + a4Ref, 1);
    hLine(0, 9, DISPLAY_W, 1);
}

/* Shared footer for all screen modes */
function drawFooter() {
    hLine(0, 53, DISPLAY_W, 1);
    let footerLeft;
    if (stringCount > 0) {
        footerLeft = 'Str:' + stringLabel;
    } else if (!autoDetect) {
        footerLeft = midiToNoteName(manualMidi);
    } else {
        footerLeft = 'Auto';
    }
    const fbShort = feedbackIndex === 0 ? 'Stp' : feedbackIndex === 1 ? 'Ref' : 'Off';
    const footerRight = fbShort + (autospeakOn ? ' Spk' : '');
    print(1, 55, footerLeft, 1);
    printRight(55, footerRight, 1);
}

/* Screen display mode dispatcher */
function drawTuner() {
    clear_screen();
    switch (screenDisplayMode) {
        case SCREEN_CLASSIC: drawClassic(); break;
        case SCREEN_STROBE: drawScreenStrobe(); break;
        case SCREEN_NEEDLE: drawNeedle(); break;
        case SCREEN_OFFSET: drawOffsetDisplay(); break;
        default: drawClassic(); break;
    }
}

/* Classic tuner display (original drawTuner content) */
function drawClassic() {
    /* Header */
    drawHeader();

    if (!hasSignal) {
        /* No signal */
        if (autoDetect) {
            printCentered(22, 'Listening...', 1);
            printCentered(34, 'Play a note', 1);
        } else {
            /* Show the target note even when no signal */
            const tgt = (stringCount > 0) ? stringLabel : midiToNoteName(manualMidi);
            printCentered(16, 'Target: ' + tgt, 1);
            printCentered(30, 'Listening...', 1);
            printCentered(40, 'Play a note', 1);
        }
    } else {
        /* Detected note (large, centered) */
        printCentered(13, detectedNote, 1);

        /* Cents meter bar */
        const meterY = 28;
        const meterW = 100;
        const meterH = 5;
        const meterX = Math.floor((DISPLAY_W - meterW) / 2);
        const meterMid = meterX + Math.floor(meterW / 2);

        drawRectOutline(meterX, meterY, meterW, meterH, 1);
        vLine(meterMid, meterY - 2, meterH + 4, 1);

        const needlePos = meterMid + Math.round(centsOffset * (meterW / 2) / 50);
        const clampedNeedle = Math.max(meterX + 1, Math.min(meterX + meterW - 2, needlePos));

        if (inTune) {
            fill_rect(meterMid - 3, meterY + 1, 7, meterH - 2, 1);
        } else {
            vLine(clampedNeedle, meterY - 1, meterH + 2, 1);
            vLine(clampedNeedle - 1, meterY, meterH, 1);
        }

        /* Cents text */
        const centsStr = (centsOffset > 0 ? '+' : '') + centsOffset + 'c';
        printCentered(36, inTune ? 'IN TUNE' : centsStr, 1);

        /* Target note (instrument mode or manual chromatic) */
        if (stringCount > 0 && targetNote !== '---') {
            printCentered(46, 'Str: ' + stringLabel, 1);
        } else if (!autoDetect) {
            printCentered(46, 'Tgt: ' + midiToNoteName(manualMidi), 1);
        }
    }

    /* Footer */
    drawFooter();
}

/* Strobe screen display */
function drawScreenStrobe() {
    /* Header */
    drawHeader();

    if (!hasSignal) {
        printCentered(30, 'Play a note', 1);
        drawFooter();
        return;
    }

    /* Note name */
    printCentered(12, detectedNote, 1);

    /* Strobe bars - 8 vertical bars across the display */
    const barW = 6;
    const barH = 20;
    const barY = 24;
    const barSpacing = 14;
    const startX = 8;

    screenStrobePhase += centsOffset * 0.08;

    for (let b = 0; b < 8; b++) {
        const baseX = startX + b * barSpacing;
        const offset = Math.floor(screenStrobePhase) % barSpacing;
        const drawX = baseX + offset;
        if (drawX >= 0 && drawX + barW <= DISPLAY_W) {
            fill_rect(drawX, barY, barW, barH, 1);
        }
    }

    /* Status */
    if (inTune) {
        printCentered(48, 'IN TUNE', 1);
    } else {
        const centsStr = (centsOffset > 0 ? '+' : '') + centsOffset + 'c';
        printCentered(48, centsStr, 1);
    }

    drawFooter();
}

/* Needle (analog meter) screen display */
function drawNeedle() {
    /* Header */
    drawHeader();

    if (!hasSignal) {
        printCentered(30, 'Play a note', 1);
        drawFooter();
        return;
    }

    /* Draw arc using pre-computed points */
    for (let i = 0; i < ARC_POINTS.length; i++) {
        set_pixel(ARC_POINTS[i].x, ARC_POINTS[i].y, 1);
    }

    /* Tick marks at 0, ±25, ±50 cents */
    const ticks = [0, -25, 25, -50, 50];
    for (let t = 0; t < ticks.length; t++) {
        const deg = (ticks[t] / 50) * 80;
        const rad = deg * Math.PI / 180;
        const outerR = 30;
        const innerR = 26;
        const ox = 64 + Math.round(outerR * Math.sin(rad));
        const oy = 36 - Math.round(outerR * Math.cos(rad));
        const ix = 64 + Math.round(innerR * Math.sin(rad));
        const iy = 36 - Math.round(innerR * Math.cos(rad));
        if (typeof display !== 'undefined' && display.drawLine) {
            display.drawLine(ix, iy, ox, oy);
        } else {
            set_pixel(ox, oy, 1);
            set_pixel(ix, iy, 1);
        }
    }

    /* Needle */
    const needleDeg = (centsOffset / 50) * 80;
    const needleRad = needleDeg * Math.PI / 180;
    const nx = 64 + Math.round(26 * Math.sin(needleRad));
    const ny = 36 - Math.round(26 * Math.cos(needleRad));
    if (typeof display !== 'undefined' && display.drawLine) {
        display.drawLine(64, 36, nx, ny);
    } else {
        /* Fallback: plot pixels along the line */
        const steps = 20;
        for (let s = 0; s <= steps; s++) {
            const px = Math.round(64 + (nx - 64) * s / steps);
            const py = Math.round(36 + (ny - 36) * s / steps);
            set_pixel(px, py, 1);
        }
    }

    /* Note name below arc */
    printCentered(44, detectedNote, 1);

    /* Status */
    if (inTune) {
        printCentered(54, 'IN TUNE', 1);
    } else {
        const centsStr = (centsOffset > 0 ? '+' : '') + centsOffset + 'c';
        printCentered(54, centsStr, 1);
    }
}

/* Offset (large cents readout) screen display */
function drawOffsetDisplay() {
    /* Header */
    drawHeader();

    if (!hasSignal) {
        printCentered(22, 'Listening...', 1);
        printCentered(34, 'Play a note', 1);
        drawFooter();
        return;
    }

    /* Note name */
    printCentered(14, detectedNote, 1);

    /* Large cents display */
    if (inTune) {
        printCentered(28, 'IN TUNE', 1);
    } else {
        const centsStr = (centsOffset > 0 ? '+' : '') + centsOffset + 'c';
        printCentered(28, centsStr, 1);
    }

    /* Target info */
    if (stringCount > 0 && targetNote !== '---') {
        printCentered(42, 'Str: ' + stringLabel, 1);
    } else if (!autoDetect) {
        printCentered(42, 'Tgt: ' + midiToNoteName(manualMidi), 1);
    }

    drawFooter();
}

function drawMenu() {
    clear_screen();
    drawHierarchicalMenu({
        title: 'Tuner Settings',
        items: menuItems,
        state: menuState,
        footer: null
    });
}

/* -------------------------------------------------------------------------- */
/* Input handling                                                              */
/* -------------------------------------------------------------------------- */

function handleInput(cc, value) {
    /*DEBUG*/ console.log('[tuner-ui] input: cc=' + cc + ' val=' + value + ' shift=' + shiftHeld);

    /* Shift tracking */
    if (cc === MoveShift) {
        shiftHeld = (value > 0);
        return;
    }

    /* Menu toggle */
    if (cc === MoveMenu && value > 0) {
        inMenu = !inMenu;
        if (inMenu) {
            menuItems = buildMenuItems();
            menuState = createMenuState();
            announceView('Settings');
        } else {
            announceView('Tuner');
        }
        return;
    }

    /* Menu mode: delegate to shared menu system with screen reader announcements */
    if (inMenu) {
        const prevIndex = menuState.selectedIndex;
        const prevEditing = menuState.editing;
        const prevEditValue = menuState.editValue;

        const result = handleMenuInput({
            cc: cc,
            value: value,
            items: menuItems,
            state: menuState,
            stack: menuStack,
            onBack: function() {
                inMenu = false;
                announceView('Tuner');
            },
            shiftHeld: shiftHeld
        });

        if (result.needsRedraw) {
            const item = menuItems[menuState.selectedIndex];
            if (!item) { return; }
            const label = item.label || '';

            if (menuState.selectedIndex !== prevIndex && !menuState.editing) {
                /* Navigated to a different item — announce label + value */
                const val = formatItemValue(item, false, null);
                announceParameter(label, val);
            } else if (menuState.editing && !prevEditing) {
                /* Entered edit mode */
                const val = formatItemValue(item, true, menuState.editValue);
                announce('Editing ' + label + ', ' + val.replace(/[\[\]]/g, ''));
            } else if (menuState.editing && menuState.editValue !== prevEditValue) {
                /* Value changed while editing */
                const val = formatItemValue(item, true, menuState.editValue);
                announce(val.replace(/[\[\]]/g, ''));
            } else if (!menuState.editing && prevEditing) {
                /* Exited edit mode (confirmed or cancelled) */
                const val = formatItemValue(item, false, null);
                announceParameter(label, val);
            } else if (!menuState.editing && !prevEditing &&
                       menuState.selectedIndex === prevIndex) {
                /* Same index, not editing — toggle click or quick adjust */
                if (item.type === 'toggle' || item.type === 'value' ||
                    item.type === 'enum') {
                    const val = formatItemValue(item, false, null);
                    announceParameter(label, val);
                }
            }
        }
        return;
    }

    /* === Tuner view input === */

    /* Back button */
    if (cc === MoveBack && value > 0) {
        if (shiftHeld) {
            autospeakOn = !autospeakOn;
            sendParamNow('autospeak', autospeakOn ? 'on' : 'off');
            announce('Autospeak ' + (autospeakOn ? 'on' : 'off'));
        } else {
            cleanupAllLeds();
            try { host_exit_module(); } catch (e) { /* ignore */ }
        }
        return;
    }

    /* Jog click: announce tuning state, or Shift+click: cycle feedback mode */
    if (cc === MoveMainButton && value > 0) {
        if (shiftHeld) {
            /* Shift+Jog click: cycle feedback mode */
            feedbackIndex = (feedbackIndex + 1) % FEEDBACK_IDS.length;
            sendParamNow('feedback_mode', FEEDBACK_IDS[feedbackIndex]);
            announce('Feedback: ' + FEEDBACK_NAMES[feedbackIndex]);
            /*DEBUG*/ console.log('[tuner-ui] feedback: mode=' + feedbackIndex + ' name=' + FEEDBACK_NAMES[feedbackIndex]);
        } else {
            /* Jog click: announce current tuning state */
            if (hasSignal) {
                if (inTune) {
                    announce(detectedNote + ', in tune');
                } else {
                    const dir = centsOffset > 0 ? 'sharp' : centsOffset < 0 ? 'flat' : 'in tune';
                    announce(detectedNote + ', ' + Math.abs(centsOffset) + ' cents ' + dir);
                }
            } else {
                const tgt = (stringCount > 0) ? stringLabel : midiToNoteName(manualMidi);
                announce('No signal. Target: ' + tgt + '. Play a note to tune.');
            }
        }
        return;
    }

    /* Jog wheel: cycle presets within category, or Shift+Jog: jump categories */
    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);

        if (shiftHeld) {
            /* Shift+Jog: jump to next/previous category */
            categoryIndex = (categoryIndex + delta + CATEGORIES.length) % CATEGORIES.length;
            modeIndex = CATEGORIES[categoryIndex].start;
            stringIndex = 0;
            stringCount = MODE_STRING_COUNTS[modeIndex];
            queueParam('tn_inst', String(modeIndex));
            if (refStyleAuto) {
                refStyle = PRESET_DEFAULT_REF_STYLES[modeIndex];
            }
            if (stringCount > 0) {
                stringLabel = getParam('string_label') || '---';
            }
            announce(CATEGORIES[categoryIndex].name + '. ' + MODE_NAMES[modeIndex]);
            /*DEBUG*/ console.log('[tuner-ui] preset: idx=' + modeIndex + ' name=' + MODE_NAMES[modeIndex]);
        } else {
            /* Jog: cycle presets within current category */
            const cat = CATEGORIES[categoryIndex];
            const range = cat.end - cat.start + 1;
            const offset = modeIndex - cat.start;
            modeIndex = cat.start + ((offset + delta + range) % range);
            stringIndex = 0;
            stringCount = MODE_STRING_COUNTS[modeIndex];
            queueParam('tn_inst', String(modeIndex));
            if (refStyleAuto) {
                refStyle = PRESET_DEFAULT_REF_STYLES[modeIndex];
            }
            if (stringCount > 0) {
                stringLabel = getParam('string_label') || '---';
            }
            announce(MODE_NAMES[modeIndex]);
            /*DEBUG*/ console.log('[tuner-ui] preset: idx=' + modeIndex + ' name=' + MODE_NAMES[modeIndex]);
        }
        return;
    }

    /* Arrow buttons: note/string selection (only when auto-detect is OFF) */
    if ((cc === MoveUp || cc === MoveDown || cc === MoveLeft || cc === MoveRight)
        && value > 0 && !autoDetect) {

        /* Use local string count — always in sync with modeIndex */
        stringCount = MODE_STRING_COUNTS[modeIndex];

        if (stringCount > 0) {
            /* Instrument mode: up/down cycle strings */
            if (cc === MoveUp) {
                stringIndex = (stringIndex + 1) % stringCount;
            } else if (cc === MoveDown) {
                stringIndex = (stringIndex - 1 + stringCount) % stringCount;
            }
            /* Left/Right: unused in instrument mode */
            if (cc === MoveUp || cc === MoveDown) {
                sendParamNow('string_index', String(stringIndex));
                stringLabel = getParam('string_label') || '---';
                announce('String ' + (stringIndex + 1) + '. ' + labelToSpoken(stringLabel));
            }
        } else {
            /* Chromatic mode: up/down = semitone, left/right = octave */
            if (cc === MoveUp) {
                manualMidi = clamp(manualMidi + 1, 0, 127);
            } else if (cc === MoveDown) {
                manualMidi = clamp(manualMidi - 1, 0, 127);
            } else if (cc === MoveRight) {
                manualMidi = clamp(manualMidi + 12, 0, 127);
            } else if (cc === MoveLeft) {
                manualMidi = clamp(manualMidi - 12, 0, 127);
            }
            sendParamNow('manual_midi', String(manualMidi));
            announce(midiToSpokenName(manualMidi));
        }
        return;
    }

    /* Knobs (relative encoders) */
    if (cc >= MoveKnob1 && cc <= MoveKnob8) {
        const knobIndex = cc - MoveKnob1;
        const delta = decodeDelta(value);
        /* In reference mode with muting on, input knobs (1,3,4) are inactive */
        const isRef = feedbackIndex === 1;
        const muted = isRef && refMuteInput;

        switch (knobIndex) {
            case 0: {
                feedbackVolume = clamp(feedbackVolume + delta * 5, 0, 100);
                sendParamNow('feedback_volume', String(feedbackVolume));
                announceParameter('Volume', feedbackVolume + '%');
                break;
            }
            case 1: {
                if (muted) { announce('Passthru inactive in reference mode'); break; }
                passthroughVolume = clamp(passthroughVolume + delta * 5, 0, 100);
                sendParamNow('passthrough_volume', String(passthroughVolume));
                announceParameter('Passthru', passthroughVolume + '%');
                break;
            }
            case 2: {
                a4Ref = clamp(a4Ref + delta, 410, 480);
                sendParamNow('a4_ref', String(a4Ref));
                announceParameter('A4', a4Ref + ' Hz');
                break;
            }
            case 3: {
                if (muted) { announce('Gate inactive in reference mode'); break; }
                noiseGate = clamp(noiseGate + delta * 5, 0, 100);
                sendParamNow('noise_gate', String(noiseGate));
                announceParameter('Gate', noiseGate + '%');
                break;
            }
            case 4: {
                if (muted) { announce('Threshold inactive in reference mode'); break; }
                tuneThreshold = clamp(tuneThreshold + delta, 1, 10);
                sendParamNow('tune_threshold', String(tuneThreshold));
                announceParameter('Threshold', tuneThreshold + ' cents');
                break;
            }
            case 5: {
                cleanupPadLeds();
                padDisplayMode = (padDisplayMode + (delta > 0 ? 1 : PAD_MODE_NAMES.length - 1)) % PAD_MODE_NAMES.length;
                onPadModeChange();
                announceParameter('Pad Mode', PAD_MODE_NAMES[padDisplayMode]);
                break;
            }
            case 6: {
                cleanupStepLeds();
                stepDisplayMode = (stepDisplayMode + (delta > 0 ? 1 : STEP_MODE_NAMES.length - 1)) % STEP_MODE_NAMES.length;
                announceParameter('Step Mode', STEP_MODE_NAMES[stepDisplayMode]);
                break;
            }
            case 7: {
                screenDisplayMode = (screenDisplayMode + (delta > 0 ? 1 : SCREEN_MODE_NAMES.length - 1)) % SCREEN_MODE_NAMES.length;
                announceParameter('Screen Mode', SCREEN_MODE_NAMES[screenDisplayMode]);
                break;
            }
        }
        return;
    }
}

function clamp(val, min, max) {
    if (val < min) return min;
    if (val > max) return max;
    return val;
}

/* Find category index for a given preset index */
function getCategoryForPreset(presetIdx) {
    for (let i = 0; i < CATEGORIES.length; i++) {
        if (presetIdx >= CATEGORIES[i].start && presetIdx <= CATEGORIES[i].end) {
            return i;
        }
    }
    return 0;
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

globalThis.init = function() {
    menuItems = buildMenuItems();
    menuState = createMenuState();
    menuStack = createMenuStack();

    categoryIndex = getCategoryForPreset(modeIndex);

    /* Queue initial params to DSP (drained one per tick) */
    queueParam('tn_inst', String(modeIndex));
    queueParam('feedback_mode', FEEDBACK_IDS[feedbackIndex]);
    queueParam('autospeak', 'on');
    queueParam('a4_ref', String(a4Ref));
    queueParam('guide_octave', guideOctave);
    queueParam('ref_style', refStyle);
    queueParam('ref_style_auto', refStyleAuto ? 'on' : 'off');
    queueParam('passthrough', passthrough ? 'on' : 'off');
    queueParam('feedback_volume', String(feedbackVolume));
    queueParam('passthrough_volume', String(passthroughVolume));
    queueParam('tune_threshold', String(tuneThreshold));
    queueParam('noise_gate', String(noiseGate));
    queueParam('auto_detect', autoDetect ? 'on' : 'off');
    queueParam('manual_midi', String(manualMidi));
    queueParam('guide_tone_ms', String(guideToneMs));
    queueParam('guide_gap_ms', String(guideGapMs));
    queueParam('ref_mute_input', refMuteInput ? 'on' : 'off');

    announceView('Tuner');
    announce('Target ' + midiToSpokenName(manualMidi) +
             '. Use arrows to select note. Turn jog to change instrument. Press menu for settings.');

    /*DEBUG*/ console.log('[tuner-ui] init: preset=' + modeIndex + ' mode=' + feedbackIndex + ' autospeak=' + autospeakOn);
};

globalThis.tick = function() {
    tickCount++;

    /* Drain one queued param per tick (ME framework coalesces back-to-back calls) */
    drainParamQueue();

    /* Poll DSP every other tick (~30 Hz at 60fps) */
    if (tickCount % 2 === 0) {
        pollDSP();
    }

    /*DEBUG*/ if (tickCount % 120 === 0) console.log('[tuner-ui] poll: note=' + detectedNote + ' cents=' + centsOffset + ' inTune=' + inTune + ' hasSignal=' + hasSignal);

    autospeakTick();

    /* Update visual feedback LEDs (throttled to ~30Hz) */
    ledTickCounter++;
    if (ledTickCounter % 2 === 0) {
        if (padDisplayMode !== PAD_OFF) updatePadDisplay();
        if (stepDisplayMode !== STEP_OFF) updateStepDisplay();
    }

    if (inMenu) {
        drawMenu();
    } else {
        drawTuner();
    }
};

/* Knob parameter names for touch announcements (knobs 1-8) */
const KNOB_NAMES = ['Volume', 'Passthru', 'A4 Ref', 'Gate', 'Threshold', 'Pad Mode', 'Step Mode', 'Screen Mode'];

globalThis.onMidiMessageInternal = function(data) {
    if (!data || data.length < 3) return;

    const status = data[0] & 0xF0;
    const d1 = data[1];
    const d2 = data[2];

    /*DEBUG*/ console.log('[tuner-ui] midi: status=' + status.toString(16) + ' d1=' + d1 + ' d2=' + d2);

    /* Handle knob touch BEFORE filtering (touches are filtered by default).
     * Knob touches arrive as Note On with note 0-7, velocity > 0. */
    if (status === MidiNoteOn && d2 > 0 && d1 >= 0 && d1 <= 7) {
        const name = KNOB_NAMES[d1];
        if (name) {
            const isRef = feedbackIndex === 1;
            const muted = isRef && refMuteInput;
            /* Input-related knobs (1=passthru, 3=gate, 4=threshold) */
            if (muted && (d1 === 1 || d1 === 3 || d1 === 4)) {
                announce(name + ' inactive in reference mode');
                return;
            }
            let val = '';
            switch (d1) {
                case 0: val = feedbackVolume + '%'; break;
                case 1: val = passthroughVolume + '%'; break;
                case 2: val = a4Ref + ' Hz'; break;
                case 3: val = noiseGate + '%'; break;
                case 4: val = tuneThreshold + ' cents'; break;
                case 5: val = PAD_MODE_NAMES[padDisplayMode]; break;
                case 6: val = STEP_MODE_NAMES[stepDisplayMode]; break;
                case 7: val = SCREEN_MODE_NAMES[screenDisplayMode]; break;
            }
            announceParameter(name, val);
        }
        return;
    }

    /* Handle step button presses for preset/string selection */
    if (status === MidiNoteOn && d2 > 0 && d1 >= 16 && d1 <= 31) {
        const stepIdx = d1 - 16;
        if (stepDisplayMode === STEP_PRESETS) {
            const cat = CATEGORIES[categoryIndex];
            const catSize = cat.end - cat.start + 1;
            if (stepIdx < catSize) {
                modeIndex = cat.start + stepIdx;
                stringIndex = 0;
                stringCount = MODE_STRING_COUNTS[modeIndex];
                queueParam('tn_inst', String(modeIndex));
                if (refStyleAuto) refStyle = PRESET_DEFAULT_REF_STYLES[modeIndex];
                announce(MODE_NAMES[modeIndex] + ' selected');
                /*DEBUG*/ console.log('[tuner-ui] step preset: idx=' + modeIndex + ' name=' + MODE_NAMES[modeIndex]);
            }
            return;
        }
        if (stepDisplayMode === STEP_STRINGS && stringCount > 0) {
            if (stepIdx < stringCount) {
                stringIndex = stepIdx;
                sendParamNow('string_index', String(stringIndex));
                stringLabel = getParam('string_label') || '---';
                announce('String ' + labelToSpoken(stringLabel) + ' selected');
                /*DEBUG*/ console.log('[tuner-ui] step string: idx=' + stringIndex + ' label=' + stringLabel);
            }
            return;
        }
    }

    /* Handle pad presses for String Map mode */
    if (status === MidiNoteOn && d2 > 0 && d1 >= 68 && d1 <= 99 && padDisplayMode === PAD_STRING_MAP) {
        const padIdx = d1 - 68;
        const col = padIdx % 8;
        if (col < stringCount) {
            stringIndex = col;
            sendParamNow('string_index', String(stringIndex));
            stringLabel = getParam('string_label') || '---';
            announce('String ' + labelToSpoken(stringLabel) + ' selected');
            /*DEBUG*/ console.log('[tuner-ui] pad string: col=' + col + ' label=' + stringLabel);
        }
        return;
    }

    if (shouldFilterMessage(data)) return;

    if (status === MidiCC) {
        handleInput(d1, d2);
    }
};

globalThis.onMidiMessageExternal = function(data) {
    /* External MIDI not used by tuner */
};
