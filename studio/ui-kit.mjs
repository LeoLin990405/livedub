/**
 * studio 纯函数小工具（无 DOM 依赖，可在 node:test 里直接测）。
 *
 * - 主题 / 字幕样式预设的规范化（localStorage 里可能是旧版本或脏数据）
 * - 键盘快捷键解析（输入框内不触发、带修饰键不触发）
 * - 延迟 sparkline 的 SVG 折线点计算
 */

export const THEMES = Object.freeze(['dark', 'light']);

/** 主题值规范化：非法值回退 fallback（默认暗色） */
export function normalizeTheme(value, fallback = 'dark') {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (THEMES.includes(raw)) return raw;
  return THEMES.includes(fallback) ? fallback : 'dark';
}

export const SUBS_SIZES = Object.freeze(['s', 'm', 'l', 'xl']);
export const SUBS_SIZE_LABELS = Object.freeze({ s: '小', m: '中', l: '大', xl: '特大' });
/** 字号档 -> 相对 CSS 缩放（配合 --subs-scale 使用） */
export const SUBS_SIZE_SCALE = Object.freeze({ s: 0.78, m: 1, l: 1.25, xl: 1.55 });
export const SUBS_POSITIONS = Object.freeze(['bottom', 'mid', 'top']);
export const SUBS_POSITION_LABELS = Object.freeze({ bottom: '下', mid: '中下', top: '上' });

export const DEFAULT_SUBS_STYLE = Object.freeze({ size: 'm', opacity: 0.72, position: 'bottom' });

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** 字幕样式规范化：size/opacity/position 非法值回退默认 */
export function normalizeSubsStyle(input, fallback = DEFAULT_SUBS_STYLE) {
  const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_SUBS_STYLE;
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const size = SUBS_SIZES.includes(raw.size) ? raw.size : SUBS_SIZES.includes(base.size) ? base.size : DEFAULT_SUBS_STYLE.size;
  const position = SUBS_POSITIONS.includes(raw.position)
    ? raw.position
    : SUBS_POSITIONS.includes(base.position)
      ? base.position
      : DEFAULT_SUBS_STYLE.position;
  const opacity = clampNumber(raw.opacity, 0.15, 1, clampNumber(base.opacity, 0.15, 1, DEFAULT_SUBS_STYLE.opacity));
  return { size, opacity: Math.round(opacity * 100) / 100, position };
}

/** 是否在可编辑元素里（输入框聚焦时快捷键不应触发） */
export function isEditableTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable === true) return true;
  const tag = String(target.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  const role = String(target.getAttribute?.('role') ?? '').toLowerCase();
  return role === 'textbox' || role === 'combobox';
}

/**
 * 解析键盘事件为工作台动作；不满足条件返回 null。
 * 支持：Space 播放/暂停、S 字幕、D 配音、Escape 隐藏面板。
 * @returns {'toggle-play'|'toggle-subs'|'toggle-dub'|'escape'|null}
 */
export function resolveShortcut(event, { editable = false } = {}) {
  if (!event || editable) return null;
  if (event.defaultPrevented) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.repeat) return null;
  const code = String(event.code ?? '');
  const key = String(event.key ?? '').toLowerCase();
  if (code === 'Space' || key === ' ') return 'toggle-play';
  if (code === 'KeyS' || key === 's') return 'toggle-subs';
  if (code === 'KeyD' || key === 'd') return 'toggle-dub';
  if (code === 'Escape' || key === 'escape') return 'escape';
  return null;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * 计算 sparkline 的 SVG <polyline points>。
 * @param {number[]} values 按时间顺序的数值（负值/非数字会被忽略）
 * @param {{width?:number,height?:number,pad?:number}} [options]
 * @returns {{points:string,min:number,max:number,last:number|null,count:number}}
 */
export function buildSparkline(values, { width = 240, height = 44, pad = 3 } = {}) {
  const nums = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (nums.length === 0) return { points: '', min: 0, max: 0, last: null, count: 0 };
  const w = Math.max(2, Number(width) || 240);
  const h = Math.max(2, Number(height) || 44);
  const p = Math.max(0, Math.min(Number(pad) || 0, Math.floor(Math.min(w, h) / 3)));
  const innerW = Math.max(1, w - p * 2);
  const innerH = Math.max(1, h - p * 2);
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const step = nums.length > 1 ? innerW / (nums.length - 1) : 0;
  const points = nums
    .map((value, index) => {
      const x = nums.length === 1 ? p + innerW / 2 : p + index * step;
      const y = p + innerH - ((value - min) / span) * innerH;
      return `${round2(x)},${round2(y)}`;
    })
    .join(' ');
  return { points, min, max, last: nums[nums.length - 1], count: nums.length };
}

/** 生成 sparkline 的面积填充 points（首尾落到基线），用于 <polygon> */
export function buildSparklineArea(values, { width = 240, height = 44, pad = 3 } = {}) {
  const line = buildSparkline(values, { width, height, pad });
  if (!line.points) return { ...line, areaPoints: '' };
  const h = Math.max(2, Number(height) || 44);
  const p = Math.max(0, Math.min(Number(pad) || 0, Math.floor(Math.min(Math.max(2, Number(width) || 240), h) / 3)));
  const baseline = h - p;
  const first = line.points.split(' ')[0];
  const last = line.points.split(' ').slice(-1)[0];
  const firstX = first.split(',')[0];
  const lastX = last.split(',')[0];
  return { ...line, areaPoints: `${firstX},${round2(baseline)} ${line.points} ${lastX},${round2(baseline)}` };
}
