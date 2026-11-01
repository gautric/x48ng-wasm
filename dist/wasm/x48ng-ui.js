/* Browser glue for the x48ng (HP 48GX) WebAssembly build.
 *
 * Drives the production "Greg. I/O" page markup (#status, #canvas.emscripten,
 * #serial-btn, #tree-panel, ...) against this repo's WebAssembly module:
 *   - configure the emscripten Module (canvas, status, IDBFS state persistence)
 *   - boot the emulator once IndexedDB-backed state is loaded
 *   - bridge the Saturn serial UART to the Web Serial API (poll-based ring
 *     buffers exported by serial_wasm.c)
 *   - drag-and-drop a file onto the HOME panel -> inject it over the serial wire
 *   - "Clear memory & reload"
 *
 * The live HOME tree, per-object export and keyboard-macro folder operations on
 * the production site rely on extra WASM exports (x48ng_wasm_home_tree_json,
 * x48ng_wasm_export_bin_b64, ...) that this build does not provide yet; those
 * controls degrade gracefully (see setupTree()).
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
    serialStatus: $("serial-status"),
    treeToggle: $("tree-toggle"),
    treePanel: $("tree-panel"),
    treeRefresh: $("tree-refresh"),
    newFolderBtn: $("newfolder-btn"),
    treeRoot: $("tree-root"),
    treeEmpty: $("tree-empty"),
    dndHint: $("dnd-hint"),
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
    setupTree();

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

  function setupPersistence() {
    setInterval(save, 5000);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) save();
    });
    window.addEventListener("pagehide", save);
    el.clearBtn.addEventListener("click", clearMemory);
  }

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
      el.serialBtn.textContent = "Disconnect serial";
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
    el.serialBtn.textContent = "Connect serial";
    setSerialStatus("Serial: virtual wire ready", "");
  }

  /* ------------------------------------------------------------------ */
  /* HOME tree panel                                                     */
  /*                                                                     */
  /* The live tree listing, per-object export and keyboard-macro folder  */
  /* operations need extra WASM exports this build does not have yet, so */
  /* those controls are disabled. The toggle and drag-and-drop upload    */
  /* over the serial wire work with the current module.                  */
  /* ------------------------------------------------------------------ */
  var DND_HINT = el.dndHint ? el.dndHint.textContent : "";

  function hasTreeApi() {
    return typeof Module._x48ng_wasm_home_tree_json === "function";
  }

  function setupTree() {
    el.treeToggle.addEventListener("click", function () {
      el.treePanel.classList.toggle("hidden");
    });

    if (!hasTreeApi()) {
      if (el.treeEmpty) el.treeEmpty.textContent = "Live HOME tree needs the extended WASM build.";
      if (el.treeRefresh) el.treeRefresh.disabled = true;
      if (el.newFolderBtn) el.newFolderBtn.disabled = true;
    }

    setupDragDrop();
  }

  function setupDragDrop() {
    window.addEventListener("dragover", function (e) {
      e.preventDefault();
    });
    window.addEventListener("drop", function (e) {
      e.preventDefault();
    });

    function dragOn(e) {
      e.preventDefault();
      e.stopPropagation();
      el.treePanel.classList.add("dragging");
    }
    function dragOff() {
      el.treePanel.classList.remove("dragging");
    }
    ["dragenter", "dragover"].forEach(function (ev) {
      el.treePanel.addEventListener(ev, dragOn);
    });
    el.treePanel.addEventListener("dragleave", dragOff);
    el.treePanel.addEventListener("drop", function (e) {
      e.preventDefault();
      e.stopPropagation();
      dragOff();
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) sendFileOverSerial(files[0]);
    });
  }

  async function sendFileOverSerial(file) {
    var buf = new Uint8Array(await file.arrayBuffer());
    setStatus("Put the HP 48 in receive mode, then sending " + file.name + " (" + buf.length + " bytes)…");
    if (el.dndHint) el.dndHint.textContent = "Uploading " + file.name + "…";
    var i = 0;
    (function pump() {
      var n = 0;
      while (i < buf.length && n < 512) {
        if (api.serialRxWrite(buf[i]) === 1) {
          i++;
          n++;
        } else {
          break; // ring full, retry shortly
        }
      }
      if (i < buf.length) {
        setTimeout(pump, 10);
      } else {
        setStatus("Sent " + file.name + " (" + buf.length + " bytes). Receive it on the HP 48.");
        if (el.dndHint) el.dndHint.textContent = DND_HINT;
      }
    })();
  }
})();
