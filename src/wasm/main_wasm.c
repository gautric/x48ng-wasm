/* WebAssembly entry point for x48ng.
 *
 * This replaces the native src/main.c.  The native build is driven by a
 * SIGALRM/setitimer at 64Hz and parks the CPU in a blocking pause() while the
 * calculator is in SHUTDN.  Neither works single-threaded in a browser, so:
 *
 *   - There are no POSIX signals.  Instead of a timer interrupt we run a fixed
 *     instruction budget per animation frame, raise sigalarm_triggered
 *     ourselves, call schedule() (which refreshes the LCD and handles input),
 *     then emscripten_sleep() to yield to the browser (requires -sASYNCIFY).
 *
 *   - The SHUTDN idle loop's pause() is redirected to x48ng_wasm_pause() (see
 *     emulate_wasm.c), which yields to the browser and re-arms the alarm flag
 *     so the idle loop keeps refreshing the display and polling input/serial.
 *
 * The HP's real-time clock stays accurate because the timer code (timers.c)
 * uses wall-clock time, which advances across emscripten_sleep().
 */

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten.h>

#include "core/emulate.h"
#include "core/init.h"
#include "core/persistence.h"
#include "core/timers.h"

#include "ui4x/src/api.h"

#include "emulator_api.h"
#include "options.h"
#include "romio.h"

/* Normally defined in native main.c. */
config_t x48ng_config;

/* ~15.6ms per frame at 64Hz. */
#define FRAME_SLEEP_MS ( 1000 / UI_REFRESH_RATE_Hz )

/* Bounds for the per-frame instruction budget. */
#define MIN_BUDGET 100000L
#define MAX_BUDGET 2000000L
#define DEFAULT_BUDGET 500000L

/* ---------------------------------------------------------------------- */
/* pause() replacement for the SHUTDN idle loop (see emulate_wasm.c).      */
/* Yields to the browser and re-arms the "alarm" so the idle loop runs its */
/* refresh + input + serial-poll body on the next iteration.               */
/* ---------------------------------------------------------------------- */
int x48ng_wasm_pause( void )
{
    emscripten_sleep( FRAME_SLEEP_MS );
    sigalarm_triggered = true;
    return 0;
}

/* ---------------------------------------------------------------------- */
/* Persistence hooks exported to JavaScript.                               */
/* ---------------------------------------------------------------------- */

/* Write the calculator state/RAM to the IDBFS-backed datadir and flush it to
   IndexedDB so it survives a reload or tab close. */
EMSCRIPTEN_KEEPALIVE
void wasm_save_state( void )
{
    write_files();
    EM_ASM( {
        if ( typeof FS !== 'undefined' && FS.syncfs )
            FS.syncfs( false, function ( err ) {
                if ( err )
                    console.warn( 'x48ng: syncfs(save) failed', err );
            } );
    } );
}

int main( int argc, char** argv )
{
    ( void )argc;
    ( void )argv;

    /* Core x48ng configuration (native main.c gets this from config_init). */
    x48ng_config.enable_wire = true; /* bridge the serial UART to Web Serial */
    x48ng_config.enable_ir = false;
    x48ng_config.enable_debugger = false;
    x48ng_config.throttle = false;
    x48ng_config.reset = false;
    x48ng_config.inhibit_shutdown = false; /* allow SHUTDN -> idle/yield */
    x48ng_config.print_config_and_exit = false;
    x48ng_config.ir_serial_device = NULL;

    ui4x_emulator_api_t emulator_api = {
        .press_key = press_key,
        .release_key = release_key,
        .is_key_pressed = is_key_pressed,
        .is_display_on = get_display_state,
        .get_annunciators = get_annunciators,
        .get_lcd_buffer = get_lcd_buffer,
        .get_contrast = get_contrast,
        .do_mount_sd = NULL,
        .do_unmount_sd = NULL,
        .is_sd_mounted = NULL,
        .get_sd_path = NULL,
        .do_reset = NULL,
        .do_stop = exit_emulator,
        .do_sleep = NULL,
        .do_wake = NULL,
        .do_debug = NULL,
    };

    /* Force the SDL frontend and the HP 48GX model; datadir is the IDBFS mount.
       The ROM is preloaded at "/rom" (CWD is "/"). */
    char* ui_argv[] = { ( char* )"x48ng", ( char* )"--sdl", ( char* )"--48gx", NULL };
    ui4x_init( 3, ui_argv, ( char* )"x48ng", ( char* )"/", ( char* )"/x48ng", &emulator_api );

    /* Start the emulator: loads ROM (+ saved state/RAM if present). */
    init_emulator();

    ui4x_config.model = opt_gx ? MODEL_48GX : MODEL_48SX;

    if ( ui4x_config.name == NULL )
        ui4x_config.name = strdup( "x48ng" );
    if ( ui4x_config.style_filename == NULL )
        ui4x_config.style_filename = opt_gx ? ( char* )"themes/48gx/style.css" : ( char* )"themes/48sx/style.css";

    ui4x_start(); /* sdl_ui4x_init(): create the canvas, draw the bezel */

    /* ---- scheduling / timer setup (mirrors native main.c) ---- */
    reset_timer( T1_TIMER );
    reset_timer( RUN_TIMER );
    reset_timer( IDLE_TIMER );

    set_accesstime();

    start_timer( T1_TIMER );
    start_timer( RUN_TIMER );

    sched_timer1 = t1_i_per_tick = saturn.t1_tick;
    sched_timer2 = t2_i_per_tick = saturn.t2_tick;

    set_t1 = saturn.timer1;

    /* ---- emulation loop (replaces SIGALRM-driven native loop) ---- */
    for ( ;; ) {
        long budget = ( saturn.i_per_s > 0 ) ? ( saturn.i_per_s / UI_REFRESH_RATE_Hz ) : DEFAULT_BUDGET;
        if ( budget < MIN_BUDGET )
            budget = MIN_BUDGET;
        if ( budget > MAX_BUDGET )
            budget = MAX_BUDGET;

        for ( long i = 0; i < budget; i++ ) {
            step_instruction();

            if ( schedule_event < 0 ) /* mirror native "bug" guard */
                schedule_event = 0;
            if ( schedule_event-- <= 0 )
                schedule();
        }

        /* Guarantee a 64Hz LCD refresh + input poll, then yield to the browser.
           (There is no SIGALRM in the browser, so we raise the flag ourselves.) */
        sigalarm_triggered = true;
        schedule();

        emscripten_sleep( FRAME_SLEEP_MS );
    }

    /* Not reached. */
    return 0;
}
