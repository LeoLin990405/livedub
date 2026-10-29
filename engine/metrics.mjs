/**
 * 分段延迟埋点（wall clock，performance.now 毫秒）。
 * Session 记录原始时间点；summary() 用 session 时间轴 -> wall 的映射推导各项延迟。
 */
export function now() {
  return performance.now();
}

export function createMetrics() {
  /** @type {Map<string|number, Record<string, number>>} */
  const store = new Map();

  function marks(id) {
    let m = store.get(id);
    if (!m) {
      m = {};
      store.set(id, m);
    }
    return m;
  }

  return {
    mark(id, name, t = now()) {
      const m = marks(id);
      m[name] = t;
      return m;
    },
    get(id) {
      return store.get(id);
    },
    /**
     * @param {string|number} id
     * @param {{t0Ms?:number, t1Ms?:number, wallFor?:(tMs:number)=>number, extra?:object}} opts
     *   wallFor: 把会话时间轴毫秒映射到 wall clock（由 Session 提供）
     */
    summary(id, { t0Ms, t1Ms, wallFor, extra = {} } = {}) {
      const m = store.get(id) ?? {};
      const out = { ...extra };
      const wall = (t) => (typeof wallFor === 'function' ? wallFor(t) : null);
      const ms = (a, b) => (a != null && b != null ? Math.max(0, Math.round(a - b)) : undefined);
      const wallT0 = t0Ms != null ? wall(t0Ms) : null;
      const wallT1 = t1Ms != null ? wall(t1Ms) : null;
      // e2eLagMs 定义：从「这句话的语音结束」到「配音第一段可播」，这是用户真正感知的同传滞后。
      // e2eFromStartMs 则从语音开始算（长句会天然更大，仅用于诊断）。
      const derived = {
        asrFinalMs: ms(m.asrFinalAt, wallT1),
        mtFirstMs: ms(m.mtFirstAt, m.asrFinalAt),
        mtDoneMs: ms(m.mtDoneAt, m.asrFinalAt),
        ttsFirstMs: ms(m.ttsFirstAt, m.mtDoneAt),
        asrLagMs: ms(m.asrFinalAt, wallT0),
        e2eLagMs: ms(m.ttsFirstAt, wallT1),
        e2eFromStartMs: ms(m.ttsFirstAt, wallT0),
        dubLagMs: ms(m.dubFirstAt, wallT0),
      };
      for (const [k, v] of Object.entries(derived)) if (v !== undefined) out[k] = v;
      return out;
    },
    clear() {
      store.clear();
    },
    size() {
      return store.size;
    },
  };
}
