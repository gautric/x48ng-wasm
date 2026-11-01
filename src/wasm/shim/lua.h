/* Minimal <lua.h> replacement for the WebAssembly build of x48ng.
 *
 * ui4x/src/api.c optionally reads a Lua config file.  The emulator calls
 * luaL_newstate() first and bails out immediately (returning NULL, i.e. "no
 * config file") if it yields NULL.  Our shim makes luaL_newstate() always
 * return NULL, so none of the other Lua calls are ever executed at runtime --
 * they only have to compile and link.  Defining the whole API as macros means
 * there is nothing to link and no real Lua dependency.
 *
 * Found before the system <lua.h> because src/wasm/shim is first on the
 * include search path (see Makefile.wasm).
 */
#ifndef _X48NG_WASM_LUA_SHIM_H
#define _X48NG_WASM_LUA_SHIM_H 1

typedef struct lua_State lua_State;
typedef double lua_Number;
typedef long long lua_Integer;

#ifndef LUA_OK
#  define LUA_OK 0
#endif

/* Non-LUA_OK so the "load + pcall" success path is never taken even if it were
   somehow reached. */
#define lua_pushliteral( L, s ) ( ( void )0 )
#define lua_pushnil( L ) ( ( void )0 )
#define lua_pop( L, n ) ( ( void )0 )
#define lua_setmetatable( L, i ) ( ( void )0 )
#define lua_getglobal( L, name ) ( ( void )0 )
#define lua_pcall( L, nargs, nres, errh ) ( 1 )
#define lua_tostring( L, i ) ( "" )
#define lua_toboolean( L, i ) ( 0 )

#endif /* _X48NG_WASM_LUA_SHIM_H */
