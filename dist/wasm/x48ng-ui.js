/* Browser glue for the x48ng (HP 48GX) WebAssembly build.
 *
 * Responsibilities:
 *   - configure the emscripten Module (canvas, status, IDBFS state persistence)
 *   - persist calculator state to IndexedDB (autosave + on hide)
 *   - bridge the Saturn serial UART to the Web Serial API
 *   - drag-and-drop file upload -> inject bytes onto the serial wire
 *   - "Clear memory & reload"
 *
 * This file must load *before* x48ng.js so that `Module` exists when the
 * emscripten runtime boots.
 */
(function () {
  "use strict";

  var DATADIR = "/x48ng";
  var SERIAL_BAUD = 9600;

  // This script tag sits at the end of <body>, after every element it needs,
  // so the lookups resolve synchronously.
  function $(id) {
    return document.getElementById(id);
  }
  var el = {
    serialBtn: $("btn-serial"),
    serialStatus: $("serial-status"),
    menuBtn: $("btn-menu"),
    uploadBtn: $("btn-upload"),
    clearBtn: $("btn-clear"),
    dropZone: $("drop-zone"),
    runStatus: $("run-status"),
    progress: $("dl-progress"),
    fileInput: $("file-input"),
  };

  /* ------------------------------------------------------------------ */
  /* emscripten Module                                                   */
  /* ------------------------------------------------------------------ */
  var canvas = document.getElementById("canvas");

  window.Module = {
    canvas: canvas,
    preRun: [
      function () {
        // Mount a persistent (IndexedDB-backed) filesystem for the calculator
        // state/RAM, and load any previously saved data before main() runs.
        //
        // State persistence is best-effort: if IndexedDB is missing or blocked
        // (private windows, "block third-party cookies/site data", some
        // extensions), the calculator must still boot. So nothing here is ever
        // allowed to leave a run dependency pending forever -- that would hang
        // the whole emulator on "Downloading data...".
        if (typeof indexedDB === "undefined" || !indexedDB) {
          console.warn("x48ng: IndexedDB unavailable; state will not persist");
          return;
        }
        try {
          try {
            Module.FS.mkdir(DATADIR);
          } catch (e) {
            /* already exists */
          }
          Module.FS.mount(Module.IDBFS, {}, DATADIR);
          Module.addRunDependency("idbfs-load");

          // Release the dependency exactly once, whichever happens first:
          // syncfs completing, or a short timeout. Some environments never
          // deliver the IndexedDB callback at all (it neither succeeds nor
          // errors); the timeout guarantees main() still starts.
          var released = false;
          function releaseIdbfs() {
            if (released) return;
            released = true;
            Module.removeRunDependency("idbfs-load");
          }
          var idbfsTimer = setTimeout(function () {
            if (!released) console.warn("x48ng: IDBFS load timed out; state will not persist this session");
            releaseIdbfs();
          }, 2500);

          Module.FS.syncfs(true, function (err) {
            if (err) console.warn("x48ng: syncfs(load) failed", err);
            clearTimeout(idbfsTimer);
            releaseIdbfs();
          });
        } catch (e) {
          console.warn("x48ng: IDBFS setup failed, state will not persist", e);
        }
      },
    ],
    print: function (text) {
      console.log("[x48ng]", text);
    },
    printErr: function (text) {
      console.warn("[x48ng]", text);
    },
    setStatus: function (text) {
      if (!el.runStatus) return;
      if (text) {
        el.runStatus.textContent = text;
        var m = text.match(/([^(]+)\((\d+(\.\d+)?)\/(\d+)\)/);
        if (m && el.progress) {
          el.progress.hidden = false;
          el.progress.value = parseInt(m[2], 10) * 100;
          el.progress.max = parseInt(m[4], 10) * 100;
        }
      } else {
        // Empty status == emscripten finished loading all run dependencies.
        // Clear the "Downloading data..." text immediately rather than waiting
        // for onRuntimeInitialized, so the message never appears to hang.
        el.runStatus.textContent = "";
        if (el.progress) el.progress.hidden = true;
      }
    },
    onRuntimeInitialized: function () {
      onReady();
    },
  };

  // Mirror emscripten's default download status wording before the runtime
  // has a chance to call setStatus.
  if (el.runStatus) el.runStatus.textContent = "Downloading…";

  /* ------------------------------------------------------------------ */
  /* once the wasm runtime is up                                         */
  /* ------------------------------------------------------------------ */
  var api = null;

  function onReady() {
    api = {
      saveState: Module.cwrap("wasm_save_state", null, []),
      serialSetConnected: Module.cwrap("wasm_serial_set_connected", null, ["number"]),
      serialIsConnected: Module.cwrap("wasm_serial_is_connected", "number", []),
      serialTxRead: Module.cwrap("wasm_serial_tx_read", "number", []),
      serialTxAvailable: Module.cwrap("wasm_serial_tx_available", "number", []),
      serialRxWrite: Module.cwrap("wasm_serial_rx_write", "number", ["number"]),
    };

    // The virtual wire is always up in the C backend, so the calculator can
    // transmit and can receive drag-and-dropped files even without a physical
    // serial port; no need to toggle it here.
    enableUi();
    setupPersistence();
    setupSerial();
    setupFileUpload();

    el.runStatus.textContent = "Calculator ready.";
    setTimeout(function () {
      if (el.runStatus.textContent === "Calculator ready.") el.runStatus.textContent = "";
    }, 1500);

    if ("serial" in navigator) {
      setSerialStatus("Serial: virtual wire ready", "");
    } else {
      setSerialStatus("Serial: Web Serial not supported", "error");
      el.serialBtn.disabled = true;
    }
  }

  function enableUi() {
    el.serialBtn.disabled = false;
    el.menuBtn.disabled = false;
    el.uploadBtn.disabled = false;
    el.clearBtn.disabled = false;
    el.clearBtn.classList.add("danger");
    el.serialBtn.classList.add("primary");
    // Give keyboard focus to the calculator so physical-keyboard input flows.
    el.menuBtn.addEventListener("click", function () {
      canvas.focus();
    });
    canvas.addEventListener("click", function () {
      canvas.focus();
    });
  }

  function setSerialStatus(text, cls) {
    el.serialStatus.textContent = text;
    el.serialStatus.className = "status" + (cls ? " " + cls : "");
  }
  function setRunStatus(text) {
    el.runStatus.textContent = text;
  }

  /* ------------------------------------------------------------------ */
  /* state persistence                                                   */
  /* ------------------------------------------------------------------ */
  function save() {
    if (!api) return;
    try {
      api.saveState();
    } catch (e) {
      console.warn("x48ng: save failed", e);
    }
  }

  function setupPersistence() {
    // Periodic autosave.
    setInterval(save, 5000);
    // Save when the tab is hidden or closed.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") save();
    });
    window.addEventListener("pagehide", save);

    el.clearBtn.addEventListener("click", clearMemory);
  }

  function clearMemory() {
    if (!confirm("Erase the calculator state and reload? This cannot be undone.")) return;
    try {
      ["state", "ram", "port1", "port2"].forEach(function (f) {
        try {
          Module.FS.unlink(DATADIR + "/" + f);
        } catch (e) {
          /* missing */
        }
      });
      Module.FS.syncfs(false, function () {
        location.reload();
      });
    } catch (e) {
      console.warn("x48ng: clear failed", e);
      location.reload();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Web Serial bridge                                                   */
  /* ------------------------------------------------------------------ */
  var serialPort = null;
  var serialWriter = null;
  var serialReader = null;
  var txPumpTimer = null;

  function setupSerial() {
    el.serialBtn.addEventListener("click", function () {
      if (serialPort) disconnectSerial();
      else connectSerial();
    });
  }

  async function connectSerial() {
    if (!("serial" in navigator)) {
      setSerialStatus("Serial: Web Serial not supported", "error");
      return;
    }
    try {
      serialPort = await navigator.serial.requestPort();
      await serialPort.open({ baudRate: SERIAL_BAUD });
      api.serialSetConnected(1);
      setSerialStatus("Serial: connected @ " + SERIAL_BAUD, "connected");
      el.serialBtn.textContent = "Disconnect serial";
      startTxPump();
      startRxPump();
    } catch (e) {
      serialPort = null;
      setSerialStatus("Serial: " + (e && e.message ? e.message : "connection failed"), "error");
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
        for (var i = 0; i < v.length; i++) {
          // Drop if the calc's RX ring is momentarily full.
          api.serialRxWrite(v[i]);
        }
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
    // Drop back to the always-on virtual wire (drag-and-drop still works).
    api.serialSetConnected(0);
    el.serialBtn.textContent = "Connect serial";
    setSerialStatus("Serial: virtual wire ready", "");
  }

  /* ------------------------------------------------------------------ */
  /* drag-and-drop upload -> serial wire                                 */
  /* ------------------------------------------------------------------ */
  function setupFileUpload() {
    ["dragenter", "dragover"].forEach(function (ev) {
      el.dropZone.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        el.dropZone.classList.add("dragover");
      });
    });
    ["dragleave", "dragend", "drop"].forEach(function (ev) {
      el.dropZone.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        el.dropZone.classList.remove("dragover");
      });
    });
    el.dropZone.addEventListener("drop", function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) sendFileOverSerial(files[0]);
    });

    el.uploadBtn.addEventListener("click", function () {
      el.fileInput.click();
    });
    el.fileInput.addEventListener("change", function () {
      if (el.fileInput.files.length) sendFileOverSerial(el.fileInput.files[0]);
      el.fileInput.value = "";
    });
  }

  async function sendFileOverSerial(file) {
    var buf = new Uint8Array(await file.arrayBuffer());
    setRunStatus("Sending " + file.name + " (" + buf.length + " bytes) over the wire…");
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
        setRunStatus("Sent " + file.name + " (" + buf.length + " bytes). Receive it on the HP 48.");
      }
    })();
  }
})();
