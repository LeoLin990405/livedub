/**
 * livedub 扩展 UI 纯函数（浏览器 + Node 双端可用，零依赖）。
 *
 * v0.2 新增，供 content script / popup / 单测共用：
 * - 原生全屏宿主选择与迁移决策（fullscreenElement 能否承载浮层）；
 * - 字幕停靠（bottom/top）+ Y 偏移避让 + 横向位移布局计算；
 * - 字幕背景/不透明度/字号/压音等展示设置的规范化。
 *
 * 注意：content script 是 classic script（MV3 不能 import ESM），
 * content.js 里内联了等价实现；tests/extension.test.mjs 会做一致性/静态校验。
 */

/** 这些标签作为全屏元素时无法承载自定义 DOM 子节点（替换元素），浮层只能留在 document */
export const NON_HOSTABLE_FULLSCREEN_TAGS = Object.freeze([
  'VIDEO',
  'AUDIO',
  'IMG',
  'CANVAS',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'PICTURE',
  'SVG',
]);

/** 字幕停靠位置 */
export const SUBS_DOCKS = Object.freeze(['bottom', 'top']);
/** 字幕背景模式 */
export const SUBS_BACKGROUNDS = Object.freeze(['dark', 'light', 'none']);

/** Y 偏移范围（px）：正值 = 向远离停靠边的方向移动（bottom 上移 / top 下移） */
export const OFFSET_Y_MIN = -200;
export const OFFSET_Y_MAX = 320;
/** 横向位置范围（px） */
export const OFFSET_X_LIMIT = 480;
export const FONT_SIZE_MIN = 14;
export const FONT_SIZE_MAX = 32;
export const DUCK_RATIO_MIN = 0.02;
export const DUCK_RATIO_MAX = 1;
export const SUBS_OPACITY_MIN = 0.2;
export const SUBS_OPACITY_MAX = 1;

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/** @param {unknown} value @returns {'bottom'|'top'} */
export function normalizeSubsDock(value) {
  return value === 'top' ? 'top' : 'bottom';
}

/** @param {unknown} value @returns {'dark'|'light'|'none'} */
export function normalizeSubsBackground(value) {
  return SUBS_BACKGROUNDS.includes(value) ? value : 'dark';
}

/** 字幕 Y 偏移（px） */
export function clampOffsetY(value) {
  return Math.round(clampNumber(value, OFFSET_Y_MIN, OFFSET_Y_MAX, 0));
}

/** 字幕横向位移（px） */
export function clampOffsetX(value) {
  return Math.round(clampNumber(value, -OFFSET_X_LIMIT, OFFSET_X_LIMIT, 0));
}

/** 字号（px） */
export function clampFontSize(value) {
  return Math.round(clampNumber(value, FONT_SIZE_MIN, FONT_SIZE_MAX, 22));
}

/** 压音比例 */
export function clampDuckRatio(value) {
  return clampNumber(value, DUCK_RATIO_MIN, DUCK_RATIO_MAX, 0.18);
}

/** 字幕背景不透明度 */
export function clampSubsOpacity(value) {
  return clampNumber(value, SUBS_OPACITY_MIN, SUBS_OPACITY_MAX, 0.82);
}

/** 全屏元素能否承载浮层子节点（按 nodeType/tagName 判断，便于纯函数测试） */
export function isHostableFullscreenElement(element) {
  if (!element || typeof element !== 'object') return false;
  if (element.nodeType !== 1) return false;
  const tag = String(element.tagName || '').toUpperCase();
  if (!tag) return false;
  return !NON_HOSTABLE_FULLSCREEN_TAGS.includes(tag);
}

/**
 * 选择浮层宿主：
 * - 有可承载的原生全屏元素（容器 div 等）-> 迁入全屏元素内；
 * - 否则（无全屏 / 全屏元素是 <video> 等替换元素）-> document.documentElement。
 * @param {{fullscreenElement?:any, documentElement?:any, body?:any}} opts
 * @returns {{kind:'fullscreen'|'document', element:any|null, hostable:boolean, tagName:string}}
 */
export function selectOverlayHost({ fullscreenElement = null, documentElement = null, body = null } = {}) {
  if (isHostableFullscreenElement(fullscreenElement)) {
    return {
      kind: 'fullscreen',
      element: fullscreenElement,
      hostable: true,
      tagName: String(fullscreenElement.tagName || '').toUpperCase(),
    };
  }
  const element = documentElement || body || null;
  return {
    kind: 'document',
    element,
    hostable: false,
    tagName: fullscreenElement ? String(fullscreenElement.tagName || '').toUpperCase() : '',
  };
}

/**
 * 是否需要迁移宿主（纯决策，便于单测/日志）。
 * @param {{currentKind?:string|null, nextKind?:string, currentElement?:any, nextElement?:any}} opts
 * @returns {{action:'mount'|'move'|'keep', nextKind:string}}
 */
export function planHostMigration({ currentKind = null, nextKind = 'document', currentElement = null, nextElement = null } = {}) {
  if (currentKind == null) return { action: 'mount', nextKind };
  if (currentKind !== nextKind) return { action: 'move', nextKind };
  if (nextElement && currentElement !== nextElement) return { action: 'move', nextKind };
  return { action: 'keep', nextKind };
}

/**
 * 计算字幕容器的 CSS 位置。
 * - dock=bottom：离视口底部 basePx + offsetY（offsetY 正数=上移，避开平台原生字幕）
 * - dock=top：离视口顶部 basePx + offsetY（offsetY 正数=下移）
 * - dx：水平偏移（px，负左正右）
 * 返回值直接映射到 style.top/bottom/transform。
 *
 * @param {{dock?:string, offsetY?:number, dx?:number, viewportHeight?:number, baseVh?:number}} opts
 * @returns {{dock:'bottom'|'top', topPx:number|null, bottomPx:number|null, transform:string, offsetY:number, dx:number}}
 */
export function computeSubsLayout({ dock = 'bottom', offsetY = 0, dx = 0, viewportHeight = 800, baseVh = 0.08 } = {}) {
  const normalizedDock = normalizeSubsDock(dock);
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 800;
  const basePx = Math.round(height * clampNumber(baseVh, 0, 0.5, 0.08));
  const normalizedOffset = clampOffsetY(offsetY);
  const normalizedDx = clampOffsetX(dx);
  const transform = `translateX(-50%) translateX(${normalizedDx}px)`;
  if (normalizedDock === 'top') {
    return {
      dock: 'top',
      topPx: Math.max(8, basePx + normalizedOffset),
      bottomPx: null,
      transform,
      offsetY: normalizedOffset,
      dx: normalizedDx,
    };
  }
  return {
    dock: 'bottom',
    topPx: null,
    bottomPx: Math.max(8, basePx + normalizedOffset),
    transform,
    offsetY: normalizedOffset,
    dx: normalizedDx,
  };
}

/**
 * 字幕块背景/文字色规格（content 用它设置 data-bg 与 CSS 变量）。
 * opacity 只作用于背景，不影响文字可读性。
 * @param {{background?:string, opacity?:number}} opts
 * @returns {{background:'dark'|'light'|'none', opacity:number, alpha:number, lightText:boolean, className:string}}
 */
export function subsBackgroundSpec({ background = 'dark', opacity = 0.82 } = {}) {
  const normalized = normalizeSubsBackground(background);
  const alpha = normalized === 'none' ? 0 : clampSubsOpacity(opacity);
  return {
    background: normalized,
    opacity: alpha,
    alpha,
    lightText: normalized !== 'light',
    className: `bg-${normalized}`,
  };
}

/**
 * 规范化「展示类」设置（字幕位置/样式/压音），popup 与 content 共用同一套规则。
 * @param {object} [raw]
 */
export function normalizeDisplaySettings(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  // v0.1 的 subsPos = {dx, dy}（dy 正值=向下）；v0.2 改成 dock + offsetY（正值=远离停靠边）
  let dx = source.dx;
  let offsetY = source.offsetY;
  if (source.subsPos && typeof source.subsPos === 'object' && dx == null && offsetY == null) {
    dx = source.subsPos.dx;
    offsetY = -source.subsPos.dy;
  }
  return {
    dock: normalizeSubsDock(source.dock),
    offsetY: clampOffsetY(offsetY),
    dx: clampOffsetX(dx),
    subsOpacity: clampSubsOpacity(source.subsOpacity),
    subsBg: normalizeSubsBackground(source.subsBg),
    fontSize: clampFontSize(source.fontSize),
    showOriginal: source.showOriginal !== false,
    duckRatio: clampDuckRatio(source.duckRatio),
    panelCollapsed: source.panelCollapsed === true,
  };
}
