// Мост страницы «Подключение к складу» (connect.html) к программе. Только для своей страницы с диска:
// сайт склада грузится в то же окно, и ему переключать режим и сервер нельзя (main.js проверяет ещё раз).
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("flagman", {
    info: () => ipcRenderer.invoke("connect:info"),
    connect: (url) => ipcRenderer.invoke("connect:try", String(url ?? "")),
    back: () => ipcRenderer.invoke("connect:back"),
    useLocal: () => ipcRenderer.invoke("connect:local"),
  });
}
