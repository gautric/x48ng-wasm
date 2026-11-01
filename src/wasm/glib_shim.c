/* Tiny GLib replacement for the WebAssembly build of x48ng.
   Only the handful of functions used by ui4x/src/api.c (plus a couple that
   native main.c would want) are implemented.  See src/wasm/shim/glib.h. */

#include <glib.h>

#include <stdarg.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

gchar* g_build_filename( const gchar* first_element, ... )
{
    if ( first_element == NULL )
        return strdup( "" );

    /* First pass: compute the needed length. */
    size_t len = strlen( first_element );
    va_list ap;
    va_start( ap, first_element );
    for ( ;; ) {
        const char* part = va_arg( ap, const char* );
        if ( part == NULL )
            break;
        len += 1 + strlen( part ); /* '/' + part */
    }
    va_end( ap );

    char* result = ( char* )malloc( len + 1 );
    if ( result == NULL )
        return NULL;

    strcpy( result, first_element );

    va_start( ap, first_element );
    for ( ;; ) {
        const char* part = va_arg( ap, const char* );
        if ( part == NULL )
            break;

        size_t cur = strlen( result );
        /* Avoid doubling the separator between "a/" and "/b". */
        bool left_slash = ( cur > 0 && result[ cur - 1 ] == '/' );
        bool right_slash = ( part[ 0 ] == '/' );
        if ( left_slash && right_slash )
            part++; /* drop leading '/' of the component */
        else if ( !left_slash && !right_slash && cur > 0 )
            strcat( result, "/" );
        strcat( result, part );
    }
    va_end( ap );

    return result;
}

gboolean g_file_test( const gchar* filename, GFileTest test )
{
    struct stat st;

    if ( filename == NULL )
        return FALSE;
    if ( stat( filename, &st ) != 0 )
        return FALSE;

    if ( test & G_FILE_TEST_IS_DIR )
        return S_ISDIR( st.st_mode ) ? TRUE : FALSE;
    if ( test & G_FILE_TEST_IS_REGULAR )
        return S_ISREG( st.st_mode ) ? TRUE : FALSE;
    if ( test & G_FILE_TEST_IS_EXECUTABLE )
        return ( st.st_mode & S_IXUSR ) ? TRUE : FALSE;
    /* G_FILE_TEST_EXISTS (and anything else): stat() succeeded. */
    return TRUE;
}

gchar* g_path_get_basename( const gchar* file_name )
{
    if ( file_name == NULL || *file_name == '\0' )
        return strdup( "." );

    const char* slash = strrchr( file_name, '/' );
    return strdup( slash ? slash + 1 : file_name );
}

gchar* g_path_get_dirname( const gchar* file_name )
{
    if ( file_name == NULL )
        return strdup( "." );

    const char* slash = strrchr( file_name, '/' );
    if ( slash == NULL )
        return strdup( "." );

    size_t len = ( size_t )( slash - file_name );
    if ( len == 0 )
        return strdup( "/" );

    char* dir = ( char* )malloc( len + 1 );
    if ( dir == NULL )
        return NULL;
    memcpy( dir, file_name, len );
    dir[ len ] = '\0';
    return dir;
}

const gchar* g_get_user_config_dir( void )
{
    const char* xdg = getenv( "XDG_CONFIG_HOME" );
    if ( xdg != NULL && *xdg != '\0' )
        return xdg;
    return "/.config";
}
