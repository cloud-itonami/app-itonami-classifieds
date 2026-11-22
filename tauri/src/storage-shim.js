// Memory storage shim for the restricted guest. The guest runs in an
// opaque-origin sandbox, which has no localStorage: the native accessor
// throws on touch. The board keeps postings only for this launch
// (descriptor local-state adapter "memory"), so install an in-memory
// localStorage before the app script runs. When localStorage works
// (future rebuilds running outside the sandbox), this is a no-op.
;(function () {
  try {
    localStorage.setItem("__itonami_probe__", "1");
    localStorage.removeItem("__itonami_probe__");
    return;
  } catch (e) {
    /* fall through to the memory store */
  }
  var store = Object.create(null);
  function memoryStorage() {
    return {
      getItem: function (key) {
        key = String(key);
        return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
      },
      setItem: function (key, value) {
        store[String(key)] = String(value);
      },
      removeItem: function (key) {
        delete store[String(key)];
      },
      clear: function () {
        for (var key in store) delete store[key];
      },
      key: function (index) {
        return Object.keys(store)[index] || null;
      },
      get length() {
        return Object.keys(store).length;
      },
    };
  }
  try {
    Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
  } catch (e) {
    /* keep the native throwing accessor; app code already guards reads */
  }
})();
