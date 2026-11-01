/* Stubs for the WebAssembly build of x48ng.
 *
 * ui4x/src/api.c dispatches to the GTK and ncurses frontends unconditionally
 * (only the SDL frontend is guarded by #ifdef HAS_SDL).  We only build the SDL
 * frontend for the browser, so the GTK/ncurses entry points have to exist for
 * linking even though they are never selected at runtime (frontend is forced to
 * FRONTEND_SDL in main_wasm.c).
 *
 * Likewise, the Saturn core references the debugger globals enter_debugger and
 * in_debugger; we do not build debugger.c, so define them here.  The debugger
 * is disabled in the browser.
 */

#include <stdbool.h>

#include "ui4x/src/gtk.h"
#include "ui4x/src/ncurses.h"

/* ---- debugger globals (normally defined in core/debugger.c) ---- */
int enter_debugger = 0;
bool in_debugger = false;
int exec_flags = 0;

/* ---- GTK frontend stubs (never called: frontend == FRONTEND_SDL) ---- */
void gtk_ui_refresh_lcd( void ) {}
void gtk_ui4x_handle_pending_inputs( void ) {}
void gtk_ui4x_init( void ) {}
void gtk_exit( void ) {}

/* ---- ncurses frontend stubs (never called) ---- */
void ncurses_refresh_lcd( void ) {}
void ncurses_handle_pending_inputs( void ) {}
void ncurses_init( void ) {}
void ncurses_exit( void ) {}
