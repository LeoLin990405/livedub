/**
 * livedub 扩展 UI 静态预览用的最小 chrome API stub（只用于 preview/*.html，不参与打包逻辑）。
 *
 * 提供：runtime 消息（可把状态/事件派发给 content/popup 的监听器）、storage.local（预置设置）、
 * tabs/tabCapture/offscreen/commands/action 的空实现、manifest 版本。
 * 通过 window.__livedubPreviewState / __livedubPreviewSettings / __livedubPreviewHandleMessage 定制。
 */
(() => {
  const listeners = [];
  const settings = Object.assign({}, window.__livedubPreviewSettings || {});
  const localStore = { 'livedub:settings': settings };
  const sessionStore = {};
  const previewState = window.__livedubPreviewState || null;

  function storageArea(store) {
    return {
      get(defaultsOrKeys, callback) {
        const defaults = typeof defaultsOrKeys === 'object' && !Array.isArray(defaultsOrKeys) ? defaultsOrKeys : {};
        const keys = Array.isArray(defaultsOrKeys) ? defaultsOrKeys : Object.keys(defaults);
        const out = {};
        for (const key of keys) out[key] = store[key] !== undefined ? store[key] : defaults[key];
        const promise = Promise.resolve(out);
        if (typeof callback === 'function') callback(out);
        return promise;
      },
      set(items, callback) {
        Object.assign(store, items);
        const promise = Promise.resolve();
        if (typeof callback === 'function') callback();
        return promise;
      },
      remove(keys, callback) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
        const promise = Promise.resolve();
        if (typeof callback === 'function') callback();
        return promise;
      },
    };
  }

  const tab = { id: 1, windowId: 1, url: 'https://example.com/lecture/cs231n', title: 'CS231n Lecture 1 · 梯度下降' };
  const chromeStub = {
    runtime: {
      onMessage: { addListener(fn) { listeners.push(fn); } },
      sendMessage(message) {
        const handler = window.__livedubPreviewHandleMessage;
        if (typeof handler === 'function') return Promise.resolve(handler(message));
        return Promise.resolve({ ok: true, state: previewState, settings });
      },
      getManifest: () => ({ version: '0.7.0' }),
      getURL: (path) => new URL(path, location.href).href,
      getContexts: async () => [],
      lastError: null,
    },
    storage: {
      local: storageArea(localStore),
      session: storageArea(sessionStore),
      onChanged: { addListener() {} },
    },
    tabs: {
      query: async () => [tab],
      get: async () => tab,
      sendMessage: async () => ({ ok: true }),
      create: async () => ({}),
      captureVisibleTab: async () => 'data:image/png;base64,',
    },
    scripting: { executeScript: async () => {} },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
    tabCapture: { getMediaStreamId: async () => 'stub-stream-id' },
    commands: { onCommand: { addListener() {} } },
    action: { onClicked: { addListener() {} } },
  };
  window.chrome = chromeStub;
  window.__livedubPreview = {
    settings,
    state: previewState,
    /** 把一条 runtime 消息分发给页面内的监听器（模拟 background -> content/popup 广播） */
    dispatch(message) {
      for (const fn of listeners) {
        try {
          fn(message, { tab }, () => {});
        } catch (err) {
          console.error('[preview] dispatch failed', err);
        }
      }
    },
  };
})();
