/*
 * tuner_debug.h - Compile-time debug logging for the tuner
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
 * Debug logging macro that compiles to zero overhead in release builds.
 * Enable with -DTUNER_DEBUG (./scripts/build.sh --debug).
 *
 * All messages are prefixed with [tuner] and routed through the ME host
 * logging system (g_host->log). View with:
 *   ssh ableton@move.local "tail -f /data/UserData/schwung/debug.log"
 */

#ifndef TUNER_DEBUG_H
#define TUNER_DEBUG_H

#ifdef TUNER_DEBUG
void tuner_dlog_impl(const char *fmt, ...);
#define DLOG(...) tuner_dlog_impl(__VA_ARGS__)
#else
#define DLOG(...) ((void)0)
#endif

#endif /* TUNER_DEBUG_H */
