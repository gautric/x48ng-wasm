/* Minimal <lauxlib.h> replacement for the WebAssembly build of x48ng.
   See lua.h in this directory for the rationale. */
#ifndef _X48NG_WASM_LAUXLIB_SHIM_H
#define _X48NG_WASM_LAUXLIB_SHIM_H 1

#include <lua.h>

/* Returning NULL means "no config file": ui4x_load_lua_file() returns early and
   none of the other Lua calls run. */
#define luaL_newstate() ( ( lua_State* )0 )
#define luaL_loadfile( L, f ) ( 1 ) /* non-LUA_OK */
#define luaL_optstring( L, i, d ) ( d )
#define luaL_optnumber( L, i, d ) ( d )
#define luaL_optinteger( L, i, d ) ( d )

#endif /* _X48NG_WASM_LAUXLIB_SHIM_H */
