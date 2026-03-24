/*
 * tuner_plugin.c - Schwung Tuner plugin entry point
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
 * Plugin API v2 tool module that:
 *   1. Reads audio from mic/line-in via mapped_memory + audio_in_offset
 *   2. Runs YIN pitch detection
 *   3. Generates step guide feedback tones
 *   4. Optionally passes through input audio
 *   5. Exposes detection results via get_param for the JS UI
 *
 * Supports two target modes:
 *   - Manual (default): UI sets target via manual_midi or string_index
 *   - Auto-detect: nearest detected note becomes the target (chromatic),
 *     or nearest string is selected (instrument mode)
 */

#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <stdarg.h>

#include "tuner_engine.h"
#include "tuner_audio.h"
#include "tuner_presets.h"
#include "tuner_debug.h"

/* -------------------------------------------------------------------------- */
/* Host API v1 (provided to Plugin API v2 modules, layout must match exactly) */
/* -------------------------------------------------------------------------- */

typedef void (*move_mod_emit_value_fn)(void *ctx, int source_id, float value);
typedef void (*move_mod_clear_source_fn)(void *ctx, int source_id);

typedef struct host_api_v1 {
    uint32_t api_version;
    int      sample_rate;
    int      frames_per_block;
    uint8_t *mapped_memory;
    int      audio_out_offset;
    int      audio_in_offset;
    void   (*log)(const char *msg);
    int    (*midi_send_internal)(const uint8_t *msg, int len);
    int    (*midi_send_external)(const uint8_t *msg, int len);
    int    (*get_clock_status)(void);
    move_mod_emit_value_fn   mod_emit_value;
    move_mod_clear_source_fn mod_clear_source;
    void  *mod_host_ctx;
} host_api_v1_t;

typedef struct {
    uint32_t api_version;
    void *(*create_instance)(const char *module_dir, const char *json_defaults);
    void (*destroy_instance)(void *instance);
    void (*on_midi)(void *instance, const uint8_t *msg, int len, int source);
    void (*set_param)(void *instance, const char *key, const char *val);
    int  (*get_param)(void *instance, const char *key, char *buf, int buf_len);
    int  (*get_error)(void *instance, char *buf, int buf_len);
    void (*render_block)(void *instance, int16_t *out_lr, int frames);
} plugin_api_v2_t;

static const host_api_v1_t *g_host = NULL;

#ifdef TUNER_DEBUG
void tuner_dlog_impl(const char *fmt, ...) {
    if (!g_host || !g_host->log) return;
    char buf[512];
    char final[540];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    snprintf(final, sizeof(final), "[tuner] %s", buf);
    g_host->log(final);
}
#endif

/* -------------------------------------------------------------------------- */
/* Instance state                                                              */
/* -------------------------------------------------------------------------- */

#define DETECTION_HOLD_BLOCKS 689  /* ~2 seconds at 128 frames/block, 44100 Hz */

typedef struct {
    /* Subsystems */
    tuner_engine_t *engine;
    tuner_audio_t  *audio;

    /* Current preset */
    int preset_index;
    int string_index;

    /* Cached detection result */
    tuner_detection_t detection;
    int               has_detection;
    int               detection_hold_blocks;

    /* Target note */
    int   target_midi;
    float target_freq;

    /* Settings */
    float a4_ref;
    int   feedback_mode;        /* 0=step_guide, 1=reference, 2=off */
    float feedback_volume;
    int   passthrough;
    float passthrough_volume;
    int   tune_threshold;       /* cents */
    float noise_gate;           /* RMS threshold */
    int   autospeak;
    int   guide_octave;         /* 0=auto, 1=match */
    int   ref_style;            /* 0=sine, 1=pluck, 2=soft_pluck */
    int   ref_style_auto;       /* 1=reset ref_style to preset default on switch */
    int   auto_detect;          /* 0=manual (default), 1=auto */
    int   manual_midi;          /* Manual target MIDI note (chromatic mode) */
    int   guide_tone_ms;        /* Step guide note duration (ms) */
    int   guide_gap_ms;         /* Step guide gap between notes (ms) */
    int   ref_mute_input;       /* 1=mute input knobs in reference mode */
    int   target_dirty;         /* 1 = target needs recomputation */
    int   prev_in_tune;         /* Previous in_tune state for change logging */
    int   prev_string_index;    /* Previous string_index for auto-detect logging */

    /* Working buffer for feedback tones */
    float feedback_buf[256];

    /* Module directory */
    char module_dir[256];

    /* Diagnostics */
    int   render_count;
    float debug_peak_in;
    float debug_peak_out;
} tuner_instance_t;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/* Use tuner_streq from tuner_presets.h to avoid duplication */
#define str_eq tuner_streq

/* Simple JSON helpers for state restore (no external deps) */
static int json_get_int(const char *json, const char *key, int def) {
    char pat[64];
    snprintf(pat, sizeof(pat), "\"%s\":", key);
    const char *p = strstr(json, pat);
    if (!p) return def;
    p += strlen(pat);
    return atoi(p);
}

static void json_get_str(const char *json, const char *key, char *out, int out_len, const char *def) {
    char pat[64];
    snprintf(pat, sizeof(pat), "\"%s\":\"", key);
    const char *p = strstr(json, pat);
    if (!p) { strncpy(out, def, out_len - 1); out[out_len - 1] = 0; return; }
    p += strlen(pat);
    int i = 0;
    while (*p && *p != '"' && i < out_len - 1) { out[i++] = *p++; }
    out[i] = 0;
}

static void update_target(tuner_instance_t *inst) {
    const tuner_preset_t *preset = &TUNER_PRESETS[inst->preset_index];

    if (preset->num_strings == 0) {
        /* Chromatic mode */
        if (inst->auto_detect) {
            /* Auto: target is the nearest detected note */
            if (inst->has_detection) {
                inst->target_midi = inst->detection.midi_note;
                inst->target_freq = tuner_midi_to_freq(inst->target_midi, inst->a4_ref);
            }
        } else {
            /* Manual: target is the user-selected note */
            inst->target_midi = inst->manual_midi;
            inst->target_freq = tuner_midi_to_freq(inst->manual_midi, inst->a4_ref);
        }
    } else {
        /* Instrument mode */
        if (inst->auto_detect && inst->has_detection) {
            /* Auto: find closest string to detected note */
            int closest = tuner_find_closest_string(preset, inst->detection.midi_note);
            if (closest >= 0) {
                inst->string_index = closest;
                if (closest != inst->prev_string_index) {
                    DLOG("auto: string %d->%d", inst->prev_string_index, closest);
                    inst->prev_string_index = closest;
                }
            }
        }
        /* Target is always the selected string's note */
        if (inst->string_index >= 0 && inst->string_index < preset->num_strings) {
            inst->target_midi = preset->notes[inst->string_index];
            inst->target_freq = tuner_midi_to_freq(inst->target_midi, inst->a4_ref);
        }
    }
}

/* Compute whole-octave shift so the lowest string in a preset lands at
 * MIDI >= 35 (B1, ~62 Hz). Preserves relative intervals between strings
 * while keeping notes audible on the Move's small speaker.
 *
 * Results with threshold 35:
 *   Guitar:        E2(40)–E4(64)  (shift +0, natural pitch)
 *   Bass 4-string: E2(40)–G3(55)  (shift +12)
 *   Bass 5-string: B1(35)–G3(55)  (shift +12)
 *   Cello:         C2(36)–A3(57)  (shift +0)
 *   Violin:        G3(55)–E5(76)  (shift +0)
 */
static int compute_ref_shift(int preset_index) {
    const tuner_preset_t *p = &TUNER_PRESETS[preset_index];
    if (p->num_strings == 0) return 0;  /* chromatic: no shift */
    int lowest = 127;
    for (int i = 0; i < p->num_strings; i++) {
        if (p->notes[i] < lowest) lowest = p->notes[i];
    }
    int shift = 0;
    while (lowest + shift < 35) shift += 12;
    return shift;
}

/* -------------------------------------------------------------------------- */
/* Plugin API v2 callbacks                                                     */
/* -------------------------------------------------------------------------- */

static void *v2_create_instance(const char *module_dir, const char *json_defaults) {
    (void)json_defaults;
    tuner_instance_t *inst = (tuner_instance_t *)calloc(1, sizeof(tuner_instance_t));
    if (!inst) return NULL;

    inst->engine = tuner_engine_create();
    inst->audio  = tuner_audio_create(TUNER_SAMPLE_RATE);
    if (!inst->engine || !inst->audio) {
        if (inst->engine) tuner_engine_destroy(inst->engine);
        if (inst->audio)  tuner_audio_destroy(inst->audio);
        free(inst);
        return NULL;
    }

    /* Defaults */
    inst->preset_index       = 0;       /* chromatic */
    inst->string_index       = 0;
    inst->a4_ref             = 440.0f;
    inst->feedback_mode      = 0;       /* step_guide */
    inst->feedback_volume    = 0.4f;
    inst->passthrough        = 0;
    inst->passthrough_volume = 0.0f;
    inst->tune_threshold     = 3;
    inst->noise_gate         = 0.002f;
    inst->autospeak          = 1;
    inst->guide_octave       = 0;       /* auto */
    inst->ref_style          = 0;       /* sine (chromatic default) */
    inst->ref_style_auto     = 1;       /* auto-select ref style per instrument */
    inst->auto_detect        = 0;       /* manual */
    inst->manual_midi        = 60;      /* C4 */
    inst->guide_tone_ms      = 200;     /* step guide note duration */
    inst->guide_gap_ms       = 40;      /* step guide gap between notes */
    inst->ref_mute_input     = 1;       /* mute input knobs in reference mode */
    inst->target_dirty       = 1;       /* compute target on first render */
    inst->prev_in_tune       = -1;      /* no previous state */
    inst->prev_string_index  = -1;      /* no previous state */

    tuner_engine_set_a4(inst->engine, inst->a4_ref);
    tuner_engine_set_noise_gate(inst->engine, inst->noise_gate);
    tuner_audio_set_mode(inst->audio, (tuner_feedback_mode_t)inst->feedback_mode);
    tuner_audio_set_volume(inst->audio, inst->feedback_volume);
    tuner_audio_set_guide_octave(inst->audio, (tuner_guide_octave_t)inst->guide_octave);
    tuner_audio_set_ref_style(inst->audio, (tuner_ref_style_t)inst->ref_style);
    tuner_audio_set_ref_shift(inst->audio, compute_ref_shift(0));
    tuner_audio_set_guide_tone_ms(inst->audio, inst->guide_tone_ms);
    tuner_audio_set_guide_gap_ms(inst->audio, inst->guide_gap_ms);

    if (module_dir) {
        strncpy(inst->module_dir, module_dir, sizeof(inst->module_dir) - 1);
    }

    if (g_host && g_host->log) {
        char msg[256];
        snprintf(msg, sizeof(msg),
            "[tuner] created: mem=%p in_off=%d out_off=%d sr=%d fpb=%d",
            (void *)g_host->mapped_memory,
            g_host->audio_in_offset, g_host->audio_out_offset,
            g_host->sample_rate, g_host->frames_per_block);
        g_host->log(msg);
    }

    return inst;
}

static void v2_destroy_instance(void *instance) {
    tuner_instance_t *inst = (tuner_instance_t *)instance;
    if (!inst) return;
    tuner_engine_destroy(inst->engine);
    tuner_audio_destroy(inst->audio);
    free(inst);
    if (g_host && g_host->log) {
        g_host->log("[tuner] destroyed");
    }
}

static void v2_on_midi(void *instance, const uint8_t *msg, int len, int source) {
    (void)instance; (void)msg; (void)len; (void)source;
}

static void v2_set_param(void *instance, const char *key, const char *val) {
    tuner_instance_t *inst = (tuner_instance_t *)instance;
    if (!inst || !key || !val) return;

    DLOG("set_param '%s'='%s'", key, val);

    if (str_eq(key, "tn_inst") || str_eq(key, "preset_idx")) {
        /* Integer preset index — reliable path that bypasses host interception */
        int idx = atoi(val);
        if (idx >= 0 && idx < TUNER_NUM_PRESETS) {
            inst->preset_index = idx;
            inst->string_index = 0;

            /* Apply preset-specific ref shift for octave transposition */
            int shift = compute_ref_shift(idx);
            tuner_audio_set_ref_shift(inst->audio, shift);

            /* Auto-select ref style for this instrument family */
            if (inst->ref_style_auto) {
                inst->ref_style = TUNER_PRESETS[idx].default_ref_style;
                tuner_audio_set_ref_style(inst->audio, (tuner_ref_style_t)inst->ref_style);
            }

            update_target(inst);
            inst->target_dirty = 1;
            DLOG("preset idx=%d name=%s shift=%d ref=%d tgt_midi=%d",
                 idx, TUNER_PRESETS[idx].name, shift,
                 inst->ref_style, inst->target_midi);
        }
    } else if (str_eq(key, "tuning_preset")) {
        /* String-based fallback */
        int idx = tuner_find_preset_index(val);
        if (idx >= 0) {
            inst->preset_index = idx;
            inst->string_index = 0;
            int shift = compute_ref_shift(idx);
            tuner_audio_set_ref_shift(inst->audio, shift);
            if (inst->ref_style_auto) {
                inst->ref_style = TUNER_PRESETS[idx].default_ref_style;
                tuner_audio_set_ref_style(inst->audio, (tuner_ref_style_t)inst->ref_style);
            }
            update_target(inst);
            inst->target_dirty = 1;
        }
    } else if (str_eq(key, "string_index")) {
        int v = atoi(val);
        const tuner_preset_t *preset = &TUNER_PRESETS[inst->preset_index];
        if (v >= 0 && v < preset->num_strings) {
            inst->string_index = v;
            update_target(inst);
            inst->target_dirty = 1;
        }
    } else if (str_eq(key, "a4_ref")) {
        int v = atoi(val);
        if (v >= 410 && v <= 480) {
            inst->a4_ref = (float)v;
            tuner_engine_set_a4(inst->engine, inst->a4_ref);
            update_target(inst);
            inst->target_dirty = 1;
        }
    } else if (str_eq(key, "feedback_mode")) {
        if (str_eq(val, "step_guide")) {
            inst->feedback_mode = 0;
        } else if (str_eq(val, "reference")) {
            inst->feedback_mode = 1;
        } else {
            inst->feedback_mode = 2;  /* off */
        }
        tuner_audio_set_mode(inst->audio, (tuner_feedback_mode_t)inst->feedback_mode);
    } else if (str_eq(key, "feedback_volume")) {
        inst->feedback_volume = atoi(val) / 100.0f;
        tuner_audio_set_volume(inst->audio, inst->feedback_volume);
    } else if (str_eq(key, "passthrough")) {
        inst->passthrough = (str_eq(val, "on") || str_eq(val, "1")) ? 1 : 0;
    } else if (str_eq(key, "passthrough_volume")) {
        inst->passthrough_volume = atoi(val) / 100.0f;
    } else if (str_eq(key, "tune_threshold")) {
        int v = atoi(val);
        if (v >= 1 && v <= 10) inst->tune_threshold = v;
    } else if (str_eq(key, "noise_gate")) {
        inst->noise_gate = atoi(val) / 100.0f * 0.01f;  /* 0-100 -> 0.0-0.01 RMS */
        tuner_engine_set_noise_gate(inst->engine, inst->noise_gate);
    } else if (str_eq(key, "autospeak")) {
        inst->autospeak = (str_eq(val, "on") || str_eq(val, "1")) ? 1 : 0;
    } else if (str_eq(key, "guide_octave")) {
        inst->guide_octave = (str_eq(val, "match") || str_eq(val, "1")) ? 1 : 0;
        tuner_audio_set_guide_octave(inst->audio, (tuner_guide_octave_t)inst->guide_octave);
    } else if (str_eq(key, "ref_style")) {
        if (str_eq(val, "soft_pluck") || str_eq(val, "2")) {
            inst->ref_style = 2;
        } else if (str_eq(val, "pluck") || str_eq(val, "1")) {
            inst->ref_style = 1;
        } else {
            inst->ref_style = 0;
        }
        tuner_audio_set_ref_style(inst->audio, (tuner_ref_style_t)inst->ref_style);
    } else if (str_eq(key, "ref_style_auto")) {
        inst->ref_style_auto = (str_eq(val, "on") || str_eq(val, "1")) ? 1 : 0;
    } else if (str_eq(key, "guide_tone_ms")) {
        int v = atoi(val);
        if (v >= 50 && v <= 500) {
            inst->guide_tone_ms = v;
            tuner_audio_set_guide_tone_ms(inst->audio, v);
        }
    } else if (str_eq(key, "guide_gap_ms")) {
        int v = atoi(val);
        if (v >= 10 && v <= 200) {
            inst->guide_gap_ms = v;
            tuner_audio_set_guide_gap_ms(inst->audio, v);
        }
    } else if (str_eq(key, "ref_mute_input")) {
        inst->ref_mute_input = (str_eq(val, "on") || str_eq(val, "1")) ? 1 : 0;
    } else if (str_eq(key, "auto_detect")) {
        inst->auto_detect = (str_eq(val, "on") || str_eq(val, "1")) ? 1 : 0;
        inst->target_dirty = 1;
    } else if (str_eq(key, "manual_midi")) {
        int v = atoi(val);
        if (v >= 0 && v <= 127) {
            inst->manual_midi = v;
            update_target(inst);
            inst->target_dirty = 1;
        }
    } else if (str_eq(key, "state")) {
        /* Restore all settings from JSON state blob */
        char str_val[32];
        int v;

        v = json_get_int(val, "preset", 0);
        if (v >= 0 && v < TUNER_NUM_PRESETS) {
            inst->preset_index = v;
            tuner_audio_set_ref_shift(inst->audio, compute_ref_shift(v));
        }
        inst->string_index = json_get_int(val, "string", 0);
        v = json_get_int(val, "midi", 60);
        if (v >= 0 && v <= 127) inst->manual_midi = v;

        json_get_str(val, "fb_mode", str_val, sizeof(str_val), "step_guide");
        if (str_eq(str_val, "reference")) inst->feedback_mode = 1;
        else if (str_eq(str_val, "off")) inst->feedback_mode = 2;
        else inst->feedback_mode = 0;
        tuner_audio_set_mode(inst->audio, (tuner_feedback_mode_t)inst->feedback_mode);

        v = json_get_int(val, "a4", 440);
        if (v >= 410 && v <= 480) {
            inst->a4_ref = (float)v;
            tuner_engine_set_a4(inst->engine, inst->a4_ref);
        }

        v = json_get_int(val, "fb_vol", 40);
        inst->feedback_volume = (float)v / 100.0f;
        tuner_audio_set_volume(inst->audio, inst->feedback_volume);

        v = json_get_int(val, "pt_vol", 0);
        inst->passthrough_volume = (float)v / 100.0f;

        inst->passthrough = json_get_int(val, "pt", 0);
        v = json_get_int(val, "threshold", 3);
        if (v >= 1 && v <= 10) inst->tune_threshold = v;

        v = json_get_int(val, "gate", 20);
        inst->noise_gate = (float)v / 100.0f * 0.01f;
        tuner_engine_set_noise_gate(inst->engine, inst->noise_gate);

        inst->autospeak = json_get_int(val, "autospeak", 1);
        inst->guide_octave = json_get_int(val, "guide_oct", 0);
        tuner_audio_set_guide_octave(inst->audio, (tuner_guide_octave_t)inst->guide_octave);

        json_get_str(val, "ref_style", str_val, sizeof(str_val), "sine");
        if (str_eq(str_val, "soft_pluck")) inst->ref_style = 2;
        else if (str_eq(str_val, "pluck")) inst->ref_style = 1;
        else inst->ref_style = 0;
        tuner_audio_set_ref_style(inst->audio, (tuner_ref_style_t)inst->ref_style);

        inst->ref_style_auto = json_get_int(val, "ref_auto", 1);
        inst->auto_detect = json_get_int(val, "auto_det", 0);

        v = json_get_int(val, "tone_ms", 200);
        if (v >= 50 && v <= 500) {
            inst->guide_tone_ms = v;
            tuner_audio_set_guide_tone_ms(inst->audio, v);
        }
        v = json_get_int(val, "gap_ms", 40);
        if (v >= 10 && v <= 200) {
            inst->guide_gap_ms = v;
            tuner_audio_set_guide_gap_ms(inst->audio, v);
        }

        inst->ref_mute_input = json_get_int(val, "ref_mute", 1);

        update_target(inst);
        inst->target_dirty = 1;

        if (g_host && g_host->log) {
            g_host->log("[tuner] state restored");
        }
        DLOG("state: preset=%d string=%d midi=%d fb=%d a4=%d",
             inst->preset_index, inst->string_index, inst->manual_midi,
             inst->feedback_mode, (int)inst->a4_ref);
    }
}

static int v2_get_param(void *instance, const char *key, char *buf, int buf_len) {
    tuner_instance_t *inst = (tuner_instance_t *)instance;
    if (!inst || !key || !buf || buf_len < 1) return 0;

    if (str_eq(key, "detected_freq")) {
        return snprintf(buf, buf_len, "%.2f", inst->detection.frequency);
    } else if (str_eq(key, "detected_note")) {
        if (inst->has_detection) {
            return snprintf(buf, buf_len, "%s%d",
                TUNER_NOTE_NAMES[inst->detection.note_index], inst->detection.octave);
        }
        return snprintf(buf, buf_len, "---");
    } else if (str_eq(key, "cents_offset")) {
        return snprintf(buf, buf_len, "%d", (int)roundf(inst->detection.cents_offset));
    } else if (str_eq(key, "in_tune")) {
        int in = inst->has_detection &&
                 fabsf(inst->detection.cents_offset) <= (float)inst->tune_threshold;
        return snprintf(buf, buf_len, "%d", in);
    } else if (str_eq(key, "confidence")) {
        return snprintf(buf, buf_len, "%.2f", inst->detection.confidence);
    } else if (str_eq(key, "has_signal")) {
        return snprintf(buf, buf_len, "%d", inst->has_detection);
    } else if (str_eq(key, "target_note")) {
        if (inst->target_midi > 0) {
            int idx = inst->target_midi % 12;
            if (idx < 0) idx += 12;
            int oct = (inst->target_midi / 12) - 1;
            return snprintf(buf, buf_len, "%s%d", TUNER_NOTE_NAMES[idx], oct);
        }
        return snprintf(buf, buf_len, "---");
    } else if (str_eq(key, "target_freq")) {
        return snprintf(buf, buf_len, "%.2f", inst->target_freq);
    } else if (str_eq(key, "target_midi")) {
        return snprintf(buf, buf_len, "%d", inst->target_midi);
    } else if (str_eq(key, "tuning_preset")) {
        return snprintf(buf, buf_len, "%s", TUNER_PRESETS[inst->preset_index].id);
    } else if (str_eq(key, "tuning_preset_name")) {
        return snprintf(buf, buf_len, "%s", TUNER_PRESETS[inst->preset_index].name);
    } else if (str_eq(key, "string_index")) {
        return snprintf(buf, buf_len, "%d", inst->string_index);
    } else if (str_eq(key, "string_count")) {
        return snprintf(buf, buf_len, "%d", TUNER_PRESETS[inst->preset_index].num_strings);
    } else if (str_eq(key, "string_label")) {
        const tuner_preset_t *p = &TUNER_PRESETS[inst->preset_index];
        if (p->num_strings > 0 && inst->string_index < p->num_strings) {
            return snprintf(buf, buf_len, "%s", p->labels[inst->string_index]);
        }
        return snprintf(buf, buf_len, "---");
    } else if (str_eq(key, "a4_ref")) {
        return snprintf(buf, buf_len, "%d", (int)inst->a4_ref);
    } else if (str_eq(key, "feedback_mode")) {
        const char *fb_str = "off";
        if (inst->feedback_mode == 0) fb_str = "step_guide";
        else if (inst->feedback_mode == 1) fb_str = "reference";
        return snprintf(buf, buf_len, "%s", fb_str);
    } else if (str_eq(key, "feedback_volume")) {
        return snprintf(buf, buf_len, "%d", (int)(inst->feedback_volume * 100));
    } else if (str_eq(key, "passthrough")) {
        return snprintf(buf, buf_len, "%s", inst->passthrough ? "on" : "off");
    } else if (str_eq(key, "passthrough_volume")) {
        return snprintf(buf, buf_len, "%d", (int)(inst->passthrough_volume * 100));
    } else if (str_eq(key, "tune_threshold")) {
        return snprintf(buf, buf_len, "%d", inst->tune_threshold);
    } else if (str_eq(key, "noise_gate")) {
        return snprintf(buf, buf_len, "%d", (int)(inst->noise_gate / 0.01f * 100));
    } else if (str_eq(key, "autospeak")) {
        return snprintf(buf, buf_len, "%s", inst->autospeak ? "on" : "off");
    } else if (str_eq(key, "guide_octave")) {
        return snprintf(buf, buf_len, "%s", inst->guide_octave ? "match" : "auto");
    } else if (str_eq(key, "ref_style")) {
        const char *rs = "sine";
        if (inst->ref_style == 1) rs = "pluck";
        else if (inst->ref_style == 2) rs = "soft_pluck";
        return snprintf(buf, buf_len, "%s", rs);
    } else if (str_eq(key, "auto_detect")) {
        return snprintf(buf, buf_len, "%s", inst->auto_detect ? "on" : "off");
    } else if (str_eq(key, "ref_style_auto")) {
        return snprintf(buf, buf_len, "%s", inst->ref_style_auto ? "on" : "off");
    } else if (str_eq(key, "guide_tone_ms")) {
        return snprintf(buf, buf_len, "%d", inst->guide_tone_ms);
    } else if (str_eq(key, "guide_gap_ms")) {
        return snprintf(buf, buf_len, "%d", inst->guide_gap_ms);
    } else if (str_eq(key, "ref_mute_input")) {
        return snprintf(buf, buf_len, "%s", inst->ref_mute_input ? "on" : "off");
    } else if (str_eq(key, "manual_midi")) {
        return snprintf(buf, buf_len, "%d", inst->manual_midi);
    } else if (str_eq(key, "name")) {
        return snprintf(buf, buf_len, "Tuner");
    } else if (str_eq(key, "preset_count")) {
        return snprintf(buf, buf_len, "%d", TUNER_NUM_PRESETS);
    } else if (str_eq(key, "preset") || str_eq(key, "preset_idx")) {
        return snprintf(buf, buf_len, "%d", inst->preset_index);
    } else if (str_eq(key, "preset_name")) {
        return snprintf(buf, buf_len, "%s", TUNER_PRESETS[inst->preset_index].name);
    } else if (str_eq(key, "debug_peak_in")) {
        return snprintf(buf, buf_len, "%.4f", inst->debug_peak_in);
    } else if (str_eq(key, "debug_peak_out")) {
        return snprintf(buf, buf_len, "%.4f", inst->debug_peak_out);
    } else if (str_eq(key, "state")) {
        /* Serialize all user settings as JSON for session save/restore */
        const char *fb_str = "off";
        if (inst->feedback_mode == 0) fb_str = "step_guide";
        else if (inst->feedback_mode == 1) fb_str = "reference";
        const char *rs = "sine";
        if (inst->ref_style == 1) rs = "pluck";
        else if (inst->ref_style == 2) rs = "soft_pluck";
        return snprintf(buf, buf_len,
            "{\"preset\":%d,\"string\":%d,\"midi\":%d,"
            "\"fb_mode\":\"%s\",\"a4\":%d,\"fb_vol\":%d,\"pt_vol\":%d,"
            "\"pt\":%d,\"threshold\":%d,\"gate\":%d,"
            "\"autospeak\":%d,\"guide_oct\":%d,"
            "\"ref_style\":\"%s\",\"ref_auto\":%d,"
            "\"auto_det\":%d,\"tone_ms\":%d,\"gap_ms\":%d,"
            "\"ref_mute\":%d}",
            inst->preset_index, inst->string_index, inst->manual_midi,
            fb_str, (int)inst->a4_ref,
            (int)(inst->feedback_volume * 100),
            (int)(inst->passthrough_volume * 100),
            inst->passthrough, inst->tune_threshold,
            (int)(inst->noise_gate / 0.01f * 100),
            inst->autospeak, inst->guide_octave,
            rs, inst->ref_style_auto,
            inst->auto_detect, inst->guide_tone_ms, inst->guide_gap_ms,
            inst->ref_mute_input);
    }

    return 0;
}

/* -------------------------------------------------------------------------- */
/* Render block                                                                */
/* -------------------------------------------------------------------------- */

static void v2_render_block(void *instance, int16_t *out_lr, int frames) {
    tuner_instance_t *inst = (tuner_instance_t *)instance;

    if (!inst || !g_host || !g_host->mapped_memory) {
        memset(out_lr, 0, frames * 2 * sizeof(int16_t));
        return;
    }

    /* Read audio input from Move hardware */
    int16_t *audio_in = (int16_t *)(
        (uint8_t *)g_host->mapped_memory + g_host->audio_in_offset
    );

    /* Measure input peak */
    int16_t max_abs = 0;
    for (int i = 0; i < frames * 2; i++) {
        int16_t v = audio_in[i];
        if (v < 0) v = -v;
        if (v > max_abs) max_abs = v;
    }
    float peak_in = (float)max_abs / 32768.0f;
    inst->debug_peak_in = peak_in;

    /* Check if audio generator is producing tones (freeze detector if so) */
    int tones_playing = tuner_audio_is_playing(inst->audio);

    /* Pass input level to audio generator for quiet detection */
    tuner_audio_set_input_level(inst->audio, peak_in);

    /* Feed to pitch detection (only when not playing tones) */
    if (!tones_playing) {
        tuner_engine_feed(inst->engine, audio_in, frames);
    }

    /* Get detection result with hold timer.
     * In reference mode, detection is completely disabled — the speaker
     * output feeds back into the mic and would create false detections. */
    if (inst->feedback_mode == 1) {
        /* Reference mode: clear any held detection */
        inst->has_detection = 0;
        inst->detection_hold_blocks = 0;
    } else {
        tuner_detection_t det;
        int fresh = tuner_engine_get_result(inst->engine, &det);
        if (fresh && !tones_playing) {
            inst->detection = det;
            inst->has_detection = 1;
            inst->detection_hold_blocks = DETECTION_HOLD_BLOCKS;
        } else if (inst->has_detection && !tones_playing) {
            inst->detection_hold_blocks--;
            if (inst->detection_hold_blocks <= 0) {
                inst->has_detection = 0;
                DLOG("det: hold expired");
            }
        }
    }

    /* Mark target dirty when auto-detect is on (detection may have changed) */
    if (inst->auto_detect) {
        inst->target_dirty = 1;
    }

    /* Update target note */
    if (inst->target_dirty) {
        update_target(inst);
        inst->target_dirty = 0;
    }

    /* Compute tuning state */
    float cents = 0.0f;
    int in_tune = 0;
    if (inst->has_detection && inst->target_midi > 0) {
        cents = tuner_cents_offset(inst->detection.frequency,
                                   inst->target_midi, inst->a4_ref);
        if (cents > 50.0f) cents = 50.0f;
        if (cents < -50.0f) cents = -50.0f;
        inst->detection.cents_offset = cents;
        in_tune = (fabsf(cents) <= (float)inst->tune_threshold);
    }

    if (in_tune != inst->prev_in_tune) {
        DLOG("tune: cents=%.1f intune=%d", cents, in_tune);
        inst->prev_in_tune = in_tune;
    }

    /* Update audio feedback */
    tuner_audio_update(inst->audio,
                       inst->target_freq, inst->target_midi,
                       cents, inst->has_detection, in_tune,
                       inst->a4_ref);

    /* Check if guide wants detection cleared (breaks feedback loop) */
    if (tuner_audio_wants_clear(inst->audio)) {
        inst->has_detection = 0;
        inst->detection_hold_blocks = 0;
        inst->detection.frequency = 0.0f;
        inst->detection.confidence = 0.0f;
        DLOG("det: cleared by guide");
    }

    /* Render feedback tones */
    tuner_audio_render(inst->audio, inst->feedback_buf, frames);

    /* Mix output */
    float peak_out = 0.0f;
    for (int i = 0; i < frames; i++) {
        float sample = inst->feedback_buf[i];

        /* Mix in passthrough if enabled */
        if (inst->passthrough) {
            float in_l = audio_in[i * 2]     / 32768.0f;
            float in_r = audio_in[i * 2 + 1] / 32768.0f;
            sample += (in_l + in_r) * 0.5f * inst->passthrough_volume;
        }

        /* Clamp */
        if (sample >  1.0f) sample =  1.0f;
        if (sample < -1.0f) sample = -1.0f;

        float abs_s = sample < 0 ? -sample : sample;
        if (abs_s > peak_out) peak_out = abs_s;

        int16_t out_sample = (int16_t)(sample * 32767.0f);
        out_lr[i * 2]     = out_sample;
        out_lr[i * 2 + 1] = out_sample;
    }
    inst->debug_peak_out = peak_out;

    /* Throttled diagnostic logging (~every 2 seconds) */
    inst->render_count++;
    if (inst->render_count == 1 || inst->render_count % 689 == 0) {
        DLOG("blk=%d in=%.3f out=%.3f det=%d f=%.1f c=%.1f tgt=%d play=%d hold=%d auto=%d",
             inst->render_count, inst->debug_peak_in, inst->debug_peak_out,
             inst->has_detection, inst->detection.frequency,
             inst->detection.cents_offset, inst->target_midi,
             tones_playing, inst->detection_hold_blocks, inst->auto_detect);
    }
}

/* -------------------------------------------------------------------------- */
/* Plugin entry point                                                          */
/* -------------------------------------------------------------------------- */

static int v2_get_error(void *instance, char *buf, int buf_len) {
    (void)instance; (void)buf; (void)buf_len;
    return 0;
}

static plugin_api_v2_t g_api = {
    .api_version     = 2,
    .create_instance = v2_create_instance,
    .destroy_instance = v2_destroy_instance,
    .on_midi         = v2_on_midi,
    .set_param       = v2_set_param,
    .get_param       = v2_get_param,
    .get_error       = v2_get_error,
    .render_block    = v2_render_block,
};

plugin_api_v2_t *move_plugin_init_v2(const host_api_v1_t *host) {
    g_host = host;
    if (g_host && g_host->log) {
        g_host->log("[tuner] plugin initialized (API v2)");
    }
    return &g_api;
}
