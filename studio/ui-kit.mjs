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
 * 支持：Space 播放/暂停、S 字幕、D 配音、N 新建笔记、Escape 隐藏面板/关闭面板。
 * @returns {'toggle-play'|'toggle-subs'|'toggle-dub'|'new-note'|'escape'|null}
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
  if (code === 'KeyN' || key === 'n') return 'new-note';
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

// =============================================================== v0.3
// ASR 引擎选择 / 隐私文案 / 桌面 App 引导 / 设置补丁（供工作台与测试复用）

/** 工作台可选的 ASR 引擎（与 server ASR_ENGINE_META 的展示字段保持一致） */
export const ASR_ENGINE_OPTIONS = Object.freeze([
  {
    id: 'whisper-local',
    label: '本地 whisper',
    shortLabel: '本地',
    cloud: false,
    privacyTitle: '音频不离开本机',
    privacyDetail: '本地 whisper 识别，音频与字幕只在你的电脑内处理，不上传云端。',
  },
  {
    id: 'minimax-cloud',
    label: '云端 MiniMax',
    shortLabel: '云端',
    cloud: true,
    privacyTitle: '音频会上传到 MiniMax',
    privacyDetail: '云端语音识别会把音频上传到 MiniMax 用于转写；不经过浏览器厂商等其它第三方。',
  },
]);

/** ASR provider 规范化：未知值回退本地 whisper（工作台只展示两种） */
export function normalizeAsrEngine(value, fallback = 'whisper-local') {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (ASR_ENGINE_OPTIONS.some((engine) => engine.id === raw)) return raw;
  return ASR_ENGINE_OPTIONS.some((engine) => engine.id === fallback) ? fallback : 'whisper-local';
}

/** ASR 引擎展示名；mock/未知值给出可读名称 */
export function asrEngineLabel(value) {
  const provider = typeof value === 'string' && value.trim() ? value.trim() : 'whisper-local';
  if (provider === 'mock') return 'Mock（开发用）';
  return ASR_ENGINE_OPTIONS.find((engine) => engine.id === provider)?.label ?? provider;
}

/** 隐私文案：{ tone:'local'|'cloud', title, detail, cloud } */
export function asrPrivacyCopy(value) {
  const provider = normalizeAsrEngine(value);
  const engine = ASR_ENGINE_OPTIONS.find((item) => item.id === provider) ?? ASR_ENGINE_OPTIONS[0];
  return {
    tone: engine.cloud ? 'cloud' : 'local',
    cloud: Boolean(engine.cloud),
    title: engine.privacyTitle,
    detail: engine.privacyDetail,
  };
}

/** 桌面 App 入口文案：已构建 -> open 命令；未构建 -> build 命令 */
export function desktopAppInstructions(desktopApp = {}) {
  const available = Boolean(desktopApp?.available);
  const appPath = String(desktopApp?.appPath ?? 'apps/macos/build/livedub.app');
  const buildCommand = String(desktopApp?.buildCommand ?? 'bash scripts/build-macos.sh');
  const openCommand = String(desktopApp?.openCommand ?? `open ${appPath}`);
  if (available) {
    return {
      available: true,
      badge: '已构建',
      title: '桌面 App 已就绪',
      command: openCommand,
      commandLabel: '启动命令',
      hint: String(desktopApp?.hint ?? '双击 .app，或在终端运行 open 命令启动桌面版；桌面版会复用本机 127.0.0.1 引擎。'),
      tone: 'ok',
    };
  }
  return {
    available: false,
    badge: '未构建',
    title: '桌面 App 未构建',
    command: buildCommand,
    commandLabel: '构建命令',
    hint: String(
      desktopApp?.hint ??
        '在项目根目录运行构建命令生成 apps/macos/build/livedub.app；需要 macOS + Xcode Command Line Tools。',
    ),
    tone: 'warn',
  };
}

/** 把工作台选择组装成 PUT /api/settings 的白名单补丁（空字段自动省略） */
export function buildSettingsPatch({ asrProvider, ttsVoiceMode, dubEnabled } = {}) {
  const patch = {};
  if (typeof asrProvider === 'string' && ASR_ENGINE_OPTIONS.some((engine) => engine.id === asrProvider)) {
    patch.asr = { provider: asrProvider };
  }
  if (ttsVoiceMode === 'clone-first' || ttsVoiceMode === 'preset') {
    patch.tts = { voiceMode: ttsVoiceMode };
  }
  if (typeof dubEnabled === 'boolean') {
    patch.dub = { enabled: dubEnabled };
  }
  return patch;
}

/** 从 /api/settings 响应合并出工作台状态（server 值优先，缺失回退 defaults） */
export function mergeSettingsSnapshot(snapshot = {}, defaults = ASR_ENGINE_OPTIONS[0].id) {
  const settings = snapshot?.settings ?? {};
  const overrides = snapshot?.overrides ?? {};
  const voiceMode = settings?.tts?.voiceMode === 'clone-first' || settings?.tts?.voiceMode === 'preset' ? settings.tts.voiceMode : 'clone-first';
  return {
    asrProvider: normalizeAsrEngine(settings?.asr?.provider ?? overrides?.asr?.provider, normalizeAsrEngine(defaults)),
    ttsVoiceMode: voiceMode,
    dubEnabled: settings?.dub?.enabled !== false,
    overrides,
    updatedAt: snapshot?.updatedAt ?? null,
    fileExists: Boolean(snapshot?.fileExists),
    warnings: Array.isArray(snapshot?.warnings) ? snapshot.warnings : [],
    asrEngine: snapshot?.asrEngine ?? null,
  };
}
