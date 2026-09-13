// Shared property-inspector glue: registers with Stream Deck, loads the
// action's settings into any element with data-setting="key", and writes
// changes back with setSettings. Elements with data-global="key" read and
// write the plugin's global settings instead.

(function () {
  "use strict";

  let ws = null;
  let uuid = null;
  let settings = {};
  let globalSettings = {};

  function send(message) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
  }

  function readValue(element) {
    if (element.type === "number") return Number(element.value);
    return element.value;
  }

  function render() {
    document.querySelectorAll("[data-setting]").forEach((element) => {
      const key = element.dataset.setting;
      if (key in settings) element.value = settings[key];
      else if (element.dataset.default !== undefined) element.value = element.dataset.default;
    });
    document.querySelectorAll("[data-global]").forEach((element) => {
      const key = element.dataset.global;
      if (key in globalSettings) element.value = globalSettings[key];
      else if (element.dataset.default !== undefined) element.value = element.dataset.default;
    });
  }

  document.addEventListener("change", (event) => {
    const element = event.target;
    if (!(element instanceof HTMLElement)) return;

    if (element.dataset.setting) {
      settings = { ...settings, [element.dataset.setting]: readValue(element) };
      send({ event: "setSettings", context: uuid, payload: settings });
    }

    if (element.dataset.global) {
      globalSettings = { ...globalSettings, [element.dataset.global]: readValue(element) };
      send({ event: "setGlobalSettings", context: uuid, payload: globalSettings });
    }
  });

  window.connectElgatoStreamDeckSocket = function (port, inUUID, registerEvent, info, actionInfo) {
    uuid = inUUID;
    try {
      settings = JSON.parse(actionInfo).payload.settings || {};
    } catch {
      settings = {};
    }

    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.onopen = () => {
      send({ event: registerEvent, uuid });
      send({ event: "getGlobalSettings", context: uuid });
      render();
    };
    ws.onmessage = (message) => {
      let data;
      try {
        data = JSON.parse(message.data);
      } catch {
        return;
      }
      if (data.event === "didReceiveGlobalSettings") {
        globalSettings = data.payload?.settings || {};
        render();
      } else if (data.event === "didReceiveSettings") {
        settings = data.payload?.settings || {};
        render();
      }
    };
  };
})();
