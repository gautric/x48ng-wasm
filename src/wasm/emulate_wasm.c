/* WebAssembly wrapper around the Saturn core's emulate.c.
 *
 * The HP48 SHUTDN instruction parks the CPU in an idle loop that calls pause()
 * and waits for the next SIGALRM.  There are no POSIX signals or a blocking
 * pause() in the browser, so we redirect pause() to x48ng_wasm_pause() (defined
 * in main_wasm.c), which yields to the browser event loop via Asyncify and
 * re-arms the "alarm" flag.  The #define is applied before including the
 * unmodified upstream emulate.c so the single pause() call inside SHUTDN -- and
 * the <unistd.h> prototype -- resolve to our replacement without touching the
 * original source. */

extern int x48ng_wasm_pause( void );
#define pause x48ng_wasm_pause

#include "../core/emulate.c"
