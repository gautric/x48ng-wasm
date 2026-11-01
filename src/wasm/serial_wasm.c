/* WebAssembly serial backend for x48ng.
 *
 * Replaces core/serial.c (pty/termios/select based) with two byte ring buffers
 * bridged to the browser's Web Serial API:
 *
 *   calc  --transmit_char()-->  TX ring  --wasm_serial_tx_read()-->  JS writer
 *   calc  <--receive_char()---  RX ring  <--wasm_serial_rx_write()--  JS reader
 *
 * The emulator core keeps the exact same four entry points (init_serial,
 * serial_baud, transmit_char, receive_char) so nothing else in the core needs
 * to change.  The Saturn serial state machine (tcs/rcs/io_ctrl bits and the
 * do_interupt() calls) is driven identically to the native backend. */

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten.h>

#include "emulate.h"  /* saturn, do_interupt() */
#include "options.h"  /* x48ng_config, ui4x_config */

#define SERIAL_RING_SIZE 4096 /* must be a power of two */
#define SERIAL_RING_MASK ( SERIAL_RING_SIZE - 1 )

typedef struct serial_ring_t {
    unsigned char buf[ SERIAL_RING_SIZE ];
    unsigned int head; /* write index */
    unsigned int tail; /* read index  */
} serial_ring_t;

static serial_ring_t tx_ring; /* calc -> browser            */
static serial_ring_t rx_ring; /* browser -> calc            */

/* The "wire" is always virtually up: the calc can always clock bytes out (to
   the TX ring, drained by the browser when a Web Serial port is attached) and
   in (from the RX ring, fed by a physical port or by drag-and-dropped files).
   physical_connected only reflects whether a real Web Serial port is open, for
   display purposes. */
static const bool wire_up = true;
static bool physical_connected = false;
static int current_baud = 9600;

static inline unsigned int ring_count( const serial_ring_t* r ) { return ( r->head - r->tail ) & ( 2 * SERIAL_RING_SIZE - 1 ); }

static inline bool ring_empty( const serial_ring_t* r ) { return r->head == r->tail; }

static inline bool ring_full( const serial_ring_t* r ) { return ring_count( r ) >= SERIAL_RING_SIZE; }

static inline void ring_reset( serial_ring_t* r ) { r->head = r->tail = 0; }

static inline void ring_push( serial_ring_t* r, unsigned char c )
{
    r->buf[ r->head & SERIAL_RING_MASK ] = c;
    r->head = ( r->head + 1 ) & ( 2 * SERIAL_RING_SIZE - 1 );
}

static inline unsigned char ring_pop( serial_ring_t* r )
{
    unsigned char c = r->buf[ r->tail & SERIAL_RING_MASK ];
    r->tail = ( r->tail + 1 ) & ( 2 * SERIAL_RING_SIZE - 1 );
    return c;
}

static void update_wire_name( void )
{
    if ( ui4x_config.wire_name )
        free( ui4x_config.wire_name );
    ui4x_config.wire_name = strdup( physical_connected ? "WebSerial" : "WebSerial (virtual)" );
}

/* ----------------------------------------------------------------------- */
/* Core entry points (mirror core/serial.c)                                 */
/* ----------------------------------------------------------------------- */

int init_serial( void )
{
    ring_reset( &tx_ring );
    ring_reset( &rx_ring );
    physical_connected = false;
    update_wire_name();
    return 1;
}

void serial_baud( int baud )
{
    /* The real baud rate is chosen by the browser when opening the Web Serial
       port; we just remember what the calc asked for. */
    current_baud = baud;
}

void transmit_char( void )
{
    /* Queue the byte for the browser (dropped if no port is open or the buffer
       is full), then advance the Saturn transmit state machine exactly like the
       native backend does -- including when disconnected -- so the calc never
       stalls waiting for the UART. */
    if ( wire_up && !ring_full( &tx_ring ) )
        ring_push( &tx_ring, saturn.tbr );

    saturn.tcs &= 0x0e;
    if ( saturn.io_ctrl & 0x04 )
        do_interupt();
}

void receive_char( void )
{
    if ( !wire_up )
        return;

    /* Previous byte not yet read by the calc. */
    if ( saturn.rcs & 0x01 )
        return;

    if ( ring_empty( &rx_ring ) )
        return;

    /* Receiver disabled: discard pending input (matches native behaviour). */
    if ( !( saturn.io_ctrl & 0x08 ) ) {
        ring_reset( &rx_ring );
        return;
    }

    saturn.rbr = ring_pop( &rx_ring );
    saturn.rcs |= 0x01;

    if ( saturn.io_ctrl & 0x02 )
        do_interupt();
}

/* ----------------------------------------------------------------------- */
/* Bridge exported to JavaScript                                            */
/* ----------------------------------------------------------------------- */

/* Called from JS when a real Web Serial port is opened (1) or closed (0).
   Only affects the display label and flushes stale TX bytes on disconnect; the
   virtual wire itself is always up. */
EMSCRIPTEN_KEEPALIVE
void wasm_serial_set_connected( int connected )
{
    physical_connected = connected ? true : false;
    if ( !physical_connected )
        ring_reset( &tx_ring ); /* nobody left to drain queued output */
    update_wire_name();
}

EMSCRIPTEN_KEEPALIVE
int wasm_serial_is_connected( void ) { return physical_connected ? 1 : 0; }

EMSCRIPTEN_KEEPALIVE
int wasm_serial_get_baud( void ) { return current_baud; }

/* Number of bytes the calc wants to send to the browser. */
EMSCRIPTEN_KEEPALIVE
int wasm_serial_tx_available( void ) { return ( int )ring_count( &tx_ring ); }

/* Pop one outgoing byte, or -1 if none. */
EMSCRIPTEN_KEEPALIVE
int wasm_serial_tx_read( void )
{
    if ( ring_empty( &tx_ring ) )
        return -1;
    return ( int )ring_pop( &tx_ring );
}

/* Push one incoming byte from the browser; returns 1 on success, 0 if full. */
EMSCRIPTEN_KEEPALIVE
int wasm_serial_rx_write( int byte )
{
    if ( ring_full( &rx_ring ) )
        return 0;
    ring_push( &rx_ring, ( unsigned char )( byte & 0xff ) );
    return 1;
}

EMSCRIPTEN_KEEPALIVE
int wasm_serial_rx_available( void ) { return ( int )ring_count( &rx_ring ); }
