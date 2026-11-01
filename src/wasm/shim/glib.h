/* Minimal <glib.h> replacement for the WebAssembly build of x48ng.
 *
 * The only glib surface used by the compiled translation units (ui4x/src/api.c)
 * is g_build_filename(), g_file_test() and the GFileTest flags.  We provide a
 * tiny, dependency-free implementation so the emulator can be built with
 * Emscripten without pulling in the real GLib.
 *
 * This header is found before the system <glib.h> because src/wasm/shim is put
 * first on the include search path by Makefile.wasm.
 */
#ifndef _X48NG_WASM_GLIB_SHIM_H
#define _X48NG_WASM_GLIB_SHIM_H 1

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef int gboolean;
typedef char gchar;
typedef int gint;
typedef unsigned int guint;
typedef void* gpointer;
typedef const void* gconstpointer;

#ifndef TRUE
#  define TRUE 1
#endif
#ifndef FALSE
#  define FALSE 0
#endif

typedef enum {
    G_FILE_TEST_IS_REGULAR = 1 << 0,
    G_FILE_TEST_IS_SYMLINK = 1 << 1,
    G_FILE_TEST_IS_DIR = 1 << 2,
    G_FILE_TEST_IS_EXECUTABLE = 1 << 3,
    G_FILE_TEST_EXISTS = 1 << 4
} GFileTest;

/* Join path components with '/', NULL-terminated argument list.
   Caller owns the returned, malloc'd string. */
extern gchar* g_build_filename( const gchar* first_element, ... );

/* Mimic glib's g_file_test() for the flags used by x48ng. */
extern gboolean g_file_test( const gchar* filename, GFileTest test );

/* Provided for completeness / compatibility with native main.c. */
extern gchar* g_path_get_basename( const gchar* file_name );
extern gchar* g_path_get_dirname( const gchar* file_name );
extern const gchar* g_get_user_config_dir( void );

#ifdef __cplusplus
}
#endif

#endif /* _X48NG_WASM_GLIB_SHIM_H */
