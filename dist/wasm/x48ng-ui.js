/* Browser glue for the x48ng (HP 48GX) WebAssembly build.
 *
 * Drives the "Greg. I/O" emulator page markup (#status, #progress,
 * #canvas.emscripten, #serial-btn, #serial-status) against this repo's
 * WebAssembly module:
 *   - configure the emscripten Module (canvas, status, IDBFS state persistence)
 *   - boot the emulator once IndexedDB-backed state is loaded
 *   - persist calculator state to IndexedDB periodically and on tab hide/unload
 *   - bridge the Saturn serial UART to the Web Serial API (poll-based ring
 *     buffers exported by serial_wasm.c)
 *   - "Clear memory & reload" wipes the persisted state and restarts empty
 *
 * This file must load *before* x48ng.js so that `Module` exists when the
 * emscripten runtime boots.
 */
(function () {
  "use strict";

  var DATADIR = "/x48ng";
  var SERIAL_BAUD = 9600;

  function $(id) {
    return document.getElementById(id);
  }
  var el = {
    status: $("status"),
    progress: $("progress"),
    canvas: $("canvas"),
    serialBtn: $("serial-btn"),
    serialLabel: $("serial-label"),
    serialStatus: $("serial-status"),
    clearBtn: $("clear-btn"),
  };

  /* ------------------------------------------------------------------ */
  /* keep the page <title>                                               */
  /*                                                                     */
  /* The emscripten SDL2 port mirrors the SDL window title to            */
  /* document.title (emscripten_set_window_title) when the emulator      */
  /* creates its window — SDL_CreateWindow is called with                */
  /* ui4x_config.progname (see src/ui4x/src/sdl.c), which would clobber  */
  /* our <title> at boot. Pin document.title to the page's own title so  */
  /* those writes are ignored and the browser tab keeps its name.        */
  /* ------------------------------------------------------------------ */
  (function pinTitle() {
    var desired = document.title;
    try {
      Object.defineProperty(document, "title", {
        configurable: true,
        get: function () {
          return desired;
        },
        set: function () {
          /* ignore SDL / emscripten window-title writes */
        },
      });
    } catch (e) {
      /* Fallback for engines that refuse the override: restore after boot. */
      var restore = function () {
        var t = document.getElementsByTagName("title")[0];
        if (t) t.textContent = desired;
      };
      restore();
      setTimeout(restore, 1500);
    }
  })();

  /* ------------------------------------------------------------------ */
  /* emscripten Module                                                   */
  /* ------------------------------------------------------------------ */
  window.Module = {
    canvas: el.canvas,
    // We run main() ourselves, only after the persisted state has been loaded
    // from IndexedDB (see onRuntimeInitialized). This avoids the data-file run
    // dependency ever blocking the boot.
    noInitialRun: true,
    print: function (text) {
      console.log("[x48ng]", text);
    },
    printErr: function (text) {
      console.warn("[x48ng]", text);
    },
    setStatus: setStatus,
    preRun: [
      function () {
        // Mount a persistent (IndexedDB-backed) filesystem for the calculator
        // state/RAM. The actual load happens in onRuntimeInitialized so we can
        // sequence it before callMain().
        try {
          Module.FS.mkdir(DATADIR);
        } catch (e) {
          /* already exists */
        }
        try {
          Module.FS.mount(Module.IDBFS, {}, DATADIR);
        } catch (e) {
          console.warn("x48ng: IDBFS mount failed, state will not persist", e);
        }
      },
    ],
    onRuntimeInitialized: function () {
      loadStateThenBoot();
    },
  };

  if (el.status) el.status.textContent = "Downloading…";

  /* ------------------------------------------------------------------ */
  /* status / progress                                                   */
  /* ------------------------------------------------------------------ */
  function setStatus(text) {
    if (!el.status) return;
    if (text) {
      var m = text.match(/([^(]+)\((\d+(\.\d+)?)\/(\d+)\)/);
      if (m) {
        el.status.textContent = m[1];
        if (el.progress) {
          el.progress.style.display = "";
          el.progress.value = parseInt(m[2], 10) * 100;
          el.progress.max = parseInt(m[4], 10) * 100;
        }
      } else {
        el.status.textContent = text;
      }
    } else {
      el.status.textContent = "";
      if (el.progress) el.progress.style.display = "none";
    }
  }

  /* ------------------------------------------------------------------ */
  /* boot: load persisted state from IndexedDB, then run main()          */
  /* ------------------------------------------------------------------ */
  var api = null;
  var booted = false;

  function loadStateThenBoot() {
    // State persistence is best-effort. If IndexedDB is missing/blocked, or the
    // syncfs callback never fires (private windows, some extensions), boot
    // anyway rather than hang on "Downloading data...".
    var started = false;
    function boot() {
      if (started) return;
      started = true;
      setStatus("");
      try {
        Module.callMain([]);
      } catch (e) {
        if (e && e.name === "ExitStatus") {
          console.log("[x48ng] exit status " + e.status);
        } else {
          el.status.className = "error";
          el.status.textContent = "Emulator error — see log.";
          console.error("[x48ng] fatal", e);
          throw e;
        }
      }
      onReady();
    }

    if (typeof indexedDB === "undefined" || !indexedDB) {
      console.warn("x48ng: IndexedDB unavailable; state will not persist");
      boot();
      return;
    }
    var timer = setTimeout(function () {
      if (!started) console.warn("x48ng: IDBFS load timed out; state will not persist this session");
      boot();
    }, 2500);
    try {
      Module.FS.syncfs(true, function (err) {
        if (err) console.warn("x48ng: syncfs(load) failed", err);
        clearTimeout(timer);
        boot();
      });
    } catch (e) {
      clearTimeout(timer);
      console.warn("x48ng: syncfs(load) threw", e);
      boot();
    }
  }

  function onReady() {
    if (booted) return;
    booted = true;

    api = {
      saveState: Module.cwrap("wasm_save_state", null, []),
      serialSetConnected: Module.cwrap("wasm_serial_set_connected", null, ["number"]),
      serialTxRead: Module.cwrap("wasm_serial_tx_read", "number", []),
      serialRxWrite: Module.cwrap("wasm_serial_rx_write", "number", ["number"]),
    };

    setupInput();
    setupPersistence();
    setupSerial();

    if ("serial" in navigator) {
      setSerialStatus("Serial: virtual wire ready", "");
    } else {
      setSerialStatus("Serial: unsupported here — use Chrome/Edge over 127.0.0.1 or HTTPS", "err");
      el.serialBtn.disabled = true;
    }
  }

  function setupInput() {
    // Keep keyboard focus on the calculator so physical-keyboard input flows.
    el.canvas.addEventListener("click", function () {
      el.canvas.focus();
    });
    el.canvas.focus();
  }

  function setSerialStatus(text, cls) {
    el.serialStatus.textContent = text;
    el.serialStatus.className = cls || "";
  }

  /* ------------------------------------------------------------------ */
  /* state persistence                                                   */
  /*                                                                     */
  /* The emulator keeps its RAM/ports/stack in the IDBFS-backed files    */
  /* under DATADIR. wasm_save_state() writes them and runs FS.syncfs so  */
  /* the next load (loadStateThenBoot) restores the session. Save on a   */
  /* timer and whenever the tab is hidden or unloaded.                   */
  /* ------------------------------------------------------------------ */
  var cleared = false;

  function save() {
    if (!api || cleared) return;
    try {
      api.saveState(); // writes files + FS.syncfs(false) internally
    } catch (e) {
      console.warn("x48ng: save failed", e);
    }
  }

  // Wipe the persisted state files and reload empty. `cleared` stops the
  // autosave timer from rewriting state between the unlink and the reload.
  function clearMemory() {
    if (
      !window.confirm(
        "Erase ALL HP 48 memory and restart empty?\n\nThis cannot be undone: variables, folders and the stack will be lost."
      )
    )
      return;
    cleared = true;
    try {
      ["state", "ram", "port1", "port2"].forEach(function (f) {
        try {
          Module.FS.unlink(DATADIR + "/" + f);
        } catch (e) {
          /* missing */
        }
      });
      Module.FS.syncfs(false, function (err) {
        if (err) console.error("[clear] syncfs error:", err);
        location.reload();
      });
    } catch (e) {
      console.warn("x48ng: clear failed", e);
      location.reload();
    }
  }

  function setupPersistence() {
    setInterval(save, 5000);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) save();
    });
    window.addEventListener("pagehide", save);
    if (el.clearBtn) el.clearBtn.addEventListener("click", clearMemory);
  }

  /* ------------------------------------------------------------------ */
  /* Web Serial bridge (poll-based ring buffers)                         */
  /* ------------------------------------------------------------------ */
  var serialPort = null;
  var serialWriter = null;
  var serialReader = null;
  var txPumpTimer = null;

  function setupSerial() {
    el.serialBtn.disabled = false;
    el.serialBtn.addEventListener("click", function () {
      if (serialPort) disconnectSerial();
      else connectSerial();
    });
  }

  async function connectSerial() {
    if (!("serial" in navigator)) {
      setSerialStatus("Serial: Web Serial not supported", "err");
      return;
    }
    try {
      serialPort = await navigator.serial.requestPort();
      await serialPort.open({ baudRate: SERIAL_BAUD, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none" });
      api.serialSetConnected(1);
      setSerialStatus("Serial: connected @ " + SERIAL_BAUD + " 8N1", "on");
      el.serialLabel.textContent = "Disconnect serial";
      startTxPump();
      startRxPump();
    } catch (e) {
      serialPort = null;
      if (e && e.name === "NotFoundError") {
        setSerialStatus("Serial: no port selected", "");
      } else {
        setSerialStatus("Serial: " + (e && e.message ? e.message : "connection failed"), "err");
        console.error("[serial]", e);
      }
    }
  }

  function startTxPump() {
    serialWriter = serialPort.writable.getWriter();
    txPumpTimer = setInterval(async function () {
      var bytes = [];
      var b;
      while ((b = api.serialTxRead()) >= 0) bytes.push(b);
      if (bytes.length && serialWriter) {
        try {
          await serialWriter.write(new Uint8Array(bytes));
        } catch (e) {
          console.warn("x48ng: serial write error", e);
        }
      }
    }, 20);
  }

  async function startRxPump() {
    try {
      serialReader = serialPort.readable.getReader();
      while (true) {
        var res = await serialReader.read();
        if (res.done) break;
        var v = res.value;
        for (var i = 0; i < v.length; i++) api.serialRxWrite(v[i]);
      }
    } catch (e) {
      /* reader cancelled on disconnect */
    } finally {
      if (serialReader) {
        try {
          serialReader.releaseLock();
        } catch (e) {}
        serialReader = null;
      }
    }
  }

  async function disconnectSerial() {
    if (txPumpTimer) {
      clearInterval(txPumpTimer);
      txPumpTimer = null;
    }
    if (serialReader) {
      try {
        await serialReader.cancel();
      } catch (e) {}
    }
    if (serialWriter) {
      try {
        serialWriter.releaseLock();
      } catch (e) {}
      serialWriter = null;
    }
    if (serialPort) {
      try {
        await serialPort.close();
      } catch (e) {}
      serialPort = null;
    }
    api.serialSetConnected(0);
    el.serialLabel.textContent = "Connect serial";
    setSerialStatus("Serial: virtual wire ready", "");
  }
})();
