/**
 * livedub Chrome MV3 扩展 —— page-hook.js（MAIN world，document_start）。
 *
 * v0.3：裸 `<video>` 原生全屏兼容（尽力而为）。
 *
 * 背景：站点直接对 `<video>` 元素调用 `requestFullscreen()` 时，浏览器只渲染该替换元素，
 * 任何扩展都无法在其上叠加自定义 DOM（字幕浮层不可见）。本脚本运行在页面主世界，
 * 猴补 `Element.prototype.requestFullscreen`：当请求全屏的是无法承载子节点的元素时，
 * 先把该元素包进一个覆盖视口的 `<div>` 容器，再对容器 requestFullscreen，这样
 * content script 的 fullscreenchange 迁移逻辑就能把字幕浮层放进全屏容器里。
 *
 * 约束/安全：
 * - 仅在站点 JS 主动调用 requestFullscreen 时生效（用户手势仍在同一次调用栈里，全屏权限不受影响）；
 * - 包裹失败（浏览器拒绝 / 容器异常）自动回退原生 requestFullscreen，绝不阻断播放；
 * - 退出全屏 / 元素被移除时恢复原 DOM 结构与行内样式；
 * - 由 content script 通过 window.postMessage({source:'livedub-content', type:'config'}) 开关，
 *   默认开启；页面可伪造消息，但最坏情况只是多包一层 div，不涉及扩展权限。
 */

(() => {
  'use strict';

  if (window.__livedubPageHookLoaded) return;
  window.__livedubPageHookLoaded = true;

  const CONTENT_SOURCE = 'livedub-content';
  const HOOK_SOURCE = 'livedub-page-hook';
  /** 与 lib/ui.js 保持一致：不能承载 DOM 子节点的元素标签 */
  const NON_HOSTABLE_TAGS = ['VIDEO', 'AUDIO', 'IMG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'PICTURE', 'SVG'];
  /** 与 lib/ui.js#buildFullscreenWrapperStyle 等价（MAIN world 无法 import ESM） */
  const WRAPPER_STYLE =
    'position: fixed; inset: 0; z-index: 2147483646; background: #000; display: flex; align-items: center; justify-content: center;';
  /** 与 lib/ui.js#buildWrappedVideoStyle 等价 */
  const WRAPPED_VIDEO_STYLE = 'width: 100%; height: 100%; object-fit: contain;';

  const state = {
    workaroundEnabled: true,
    /** @type {null | {wrapper: HTMLDivElement, video: Element, parent: Node|null, nextSibling: Node|null, originalStyle: string|null}} */
    active: null,
  };

  try {
    if (document.documentElement) document.documentElement.setAttribute('data-livedub-page-hook', '1');
  } catch {
    /* ignore */
  }

  function notify(payload) {
    try {
      window.postMessage({ source: HOOK_SOURCE, ...payload }, '*');
    } catch {
      /* ignore */
    }
  }

  function isHostableElement(element) {
    if (!element || typeof element !== 'object' || element.nodeType !== 1) return false;
    const tag = String(element.tagName || '').toUpperCase();
    if (!tag) return false;
    return !NON_HOSTABLE_TAGS.includes(tag);
  }

  function currentFullscreenTag() {
    const element = document.fullscreenElement;
    return element ? String(element.tagName || '').toUpperCase() : '';
  }

  /** 与 lib/ui.js#planFullscreenRequest 等价（MAIN world 无法 import） */
  function planFullscreenRequest(element) {
    if (!state.workaroundEnabled) return 'native';
    if (currentFullscreenTag()) return 'native';
    if (!element || element.nodeType !== 1) return 'native';
    if (isHostableElement(element)) return 'native';
    return 'wrapper';
  }

  function ensureWrapper(video) {
    const active = state.active;
    if (active && active.video === video && active.wrapper && active.wrapper.isConnected) return active.wrapper;
    if (active) restore('replaced');
    const parent = video.parentNode;
    if (!parent) return null;
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-livedub-fullscreen-wrapper', '1');
    wrapper.style.cssText = WRAPPER_STYLE;
    const nextSibling = video.nextSibling;
    const originalStyle = video.getAttribute('style');
    try {
      parent.insertBefore(wrapper, video);
      wrapper.appendChild(video);
      video.style.cssText = WRAPPED_VIDEO_STYLE;
    } catch {
      try {
        wrapper.remove();
      } catch {
        /* ignore */
      }
      return null;
    }
    state.active = { wrapper, video, parent, nextSibling, originalStyle };
    return wrapper;
  }

  /** 恢复被包裹元素的 DOM 结构与行内样式；可重复调用 */
  function restore(reason = 'exit') {
    const active = state.active;
    if (!active) return false;
    state.active = null;
    const { video, wrapper, parent, nextSibling, originalStyle } = active;
    try {
      if (originalStyle == null) video.removeAttribute('style');
      else video.setAttribute('style', originalStyle);
    } catch {
      /* ignore */
    }
    try {
      if (wrapper.parentNode) {
        if (parent && parent.isConnected) {
          if (nextSibling && nextSibling.parentNode === parent) parent.insertBefore(video, nextSibling);
          else parent.appendChild(video);
        }
        wrapper.remove();
      }
    } catch {
      /* ignore */
    }
    notify({ type: 'restore', reason });
    return true;
  }

  // 退出全屏（或全屏元素换成别的东西）时恢复 DOM
  document.addEventListener(
    'fullscreenchange',
    () => {
      const active = state.active;
      if (!active) return;
      if (document.fullscreenElement === active.wrapper) return;
      restore('fullscreenchange');
    },
    true,
  );
  window.addEventListener('pagehide', () => restore('pagehide'));

  // content script <-> page hook 配置通道
  window.addEventListener('message', (event) => {
    const data = event && event.data;
    if (!data || typeof data !== 'object') return;
    if (data.source !== CONTENT_SOURCE || data.type !== 'config') return;
    if (typeof data.fullscreenWorkaround === 'boolean') state.workaroundEnabled = data.fullscreenWorkaround;
  });

  const elementProto = Element.prototype;
  const originalRequestFullscreen = elementProto.requestFullscreen;
  const originalWebkitRequestFullscreen = elementProto.webkitRequestFullscreen;

  if (typeof originalRequestFullscreen === 'function') {
    const patched = function requestFullscreen(...args) {
      const element = this;
      try {
        if (planFullscreenRequest(element) === 'wrapper') {
          const wrapper = ensureWrapper(element);
          if (wrapper) {
            notify({ type: 'wrap', tagName: String(element.tagName || '').toUpperCase() });
            const result = originalRequestFullscreen.apply(wrapper, args);
            if (result && typeof result.catch === 'function') {
              return result.catch((error) => {
                // 包裹层全屏失败：恢复 DOM 后回退原生全屏（尽力而为）
                try {
                  restore('request-failed');
                } catch {
                  /* ignore */
                }
                notify({ type: 'error', message: String((error && error.message) || error) });
                return originalRequestFullscreen.apply(element, args);
              });
            }
            return result;
          }
        }
      } catch (error) {
        notify({ type: 'error', message: String((error && error.message) || error) });
      }
      return originalRequestFullscreen.apply(element, args);
    };
    try {
      elementProto.requestFullscreen = patched;
    } catch {
      /* ignore */
    }
    if (typeof originalWebkitRequestFullscreen === 'function') {
      try {
        elementProto.webkitRequestFullscreen = patched;
      } catch {
        /* ignore */
      }
    }
    notify({ type: 'ready' });
  } else {
    notify({ type: 'unsupported' });
  }
})();
