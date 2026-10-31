/**
 * 课程处理的三件事：翻译、笔记、因果。
 * 浏览器与 node:test 共用，不读 DOM、不发请求。
 *
 * 实时同传仍按模型顺序做备胎：第一家成功就用，不等其他模型。
 * 多个模型一起用，只发生在批量路径：已有字幕翻译、笔记要点、因果用词。
 */

export const COURSE_JOBS = Object.freeze(['translate', 'notes', 'causal']);
export const SUBTITLE_CUE_CAP = 40;
export const COURSE_MODEL_CAP = 3;

const AGREEMENT_LABEL = Object.freeze({
  unanimous: '全体一致',
  majority: '多数一致',
  primary: '采用主模型',
  none: '没有译文',
});

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function modelName(value) {
  return String(value ?? '').trim();
}

export function normalizeModelList(models) {
  const out = [];
  const list = Array.isArray(models) ? models : [];
  for (const item of list) {
    const name = modelName(item);
    if (!name || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** 配置里的翻译主模型和备胎链，去重后保持原顺序。 */
export function availableCourseModels(config) {
  const primary = modelName(config?.translate?.provider);
  const chain = normalizeModelList(config?.translate?.chain);
  const out = [];
  if (primary) out.push(primary);
  for (const name of chain) {
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function normalizeJobs(jobs) {
  if (jobs == null) return { translate: true, notes: true, causal: true };
  if (Array.isArray(jobs)) {
    const selected = new Set(jobs.map((job) => String(job)));
    return {
      translate: selected.has('translate'),
      notes: selected.has('notes'),
      causal: selected.has('causal'),
    };
  }
  if (typeof jobs === 'object') {
    return {
      translate: jobs.translate !== false,
      notes: jobs.notes !== false,
      causal: jobs.causal !== false,
    };
  }
  return { translate: true, notes: true, causal: true };
}

function pickModels(explicit, shared, available) {
  const chosen = normalizeModelList(explicit);
  const base = chosen.length ? chosen : normalizeModelList(shared);
  const pool = base.length ? base : normalizeModelList(available);
  const allowed = new Set(normalizeModelList(available));
  const filtered = allowed.size ? pool.filter((name) => allowed.has(name)) : pool;
  return filtered.slice(0, COURSE_MODEL_CAP);
}

function sharedModels(models) {
  return Array.isArray(models) ? models : [];
}

/**
 * 规划一次课程处理。
 * models 可以是共享数组，或 { translate, notes, causal }。
 * liveChain 只给视频语音：按这个顺序做备胎，不是并行。
 * batchTranslate 为真时，已有字幕要问过每一个选中的模型再合并。
 */
export function planCourseRun({ jobs, translateSource, models, availableModels } = {}) {
  const selected = normalizeJobs(jobs);
  const source = translateSource === 'subtitles' ? 'subtitles' : 'video';
  const available = normalizeModelList(availableModels);
  const perJob = models && typeof models === 'object' && !Array.isArray(models) ? models : null;
  const shared = perJob ? [] : sharedModels(models);
  const translate = pickModels(perJob?.translate, shared, available);
  const notes = pickModels(perJob?.notes, shared, available);
  const causal = pickModels(perJob?.causal, shared, available);
  const videoTranslate = selected.translate && source === 'video' && translate.length > 0;
  return {
    jobs: selected,
    translateSource: source,
    models: { translate, notes, causal },
    liveChain: videoTranslate ? translate.slice() : null,
    batchTranslate: Boolean(selected.translate && source === 'subtitles'),
  };
}

/**
 * 同一句的多份译文。candidates 按主模型在前的顺序。
 * 至少两家原文一致（空白折叠后）就用多数；否则用主模型。
 */
export function mergeTranslations(candidates) {
  const list = (Array.isArray(candidates) ? candidates : [])
    .map((item) => ({ provider: modelName(item?.provider) || 'model', text: cleanText(item?.text) }))
    .filter((item) => item.text);
  if (list.length === 0) return { text: '', provider: '', agreement: 'none', supporters: [] };
  const groups = new Map();
  for (const item of list) {
    const group = groups.get(item.text) ?? { text: item.text, providers: [], count: 0 };
    if (!group.providers.includes(item.provider)) group.providers.push(item.provider);
    group.count += 1;
    groups.set(item.text, group);
  }
  let best = null;
  for (const group of groups.values()) {
    if (group.count < 2) continue;
    if (!best || group.count > best.count) best = group;
  }
  if (best) {
    return {
      text: best.text,
      provider: best.providers[0],
      agreement: best.count === list.length ? 'unanimous' : 'majority',
      supporters: best.providers,
    };
  }
  return { text: list[0].text, provider: list[0].provider, agreement: 'primary', supporters: [list[0].provider] };
}

/**
 * 多份笔记草稿。要点在两家及以上一致时保留；没有一致的要点时用主模型（第一份）。
 * 总结同样：多数一致才替换主模型的总结。
 */
export function mergeNoteDrafts(drafts) {
  const list = (Array.isArray(drafts) ? drafts : []).filter((draft) => draft && typeof draft === 'object');
  if (list.length === 0) return { summary: '', keyPoints: [], providers: [], summaryAgreement: 'none' };
  const summaryMerge = mergeTranslations(list.map((draft) => ({ provider: draft.provider, text: draft.summary })));
  const counts = new Map();
  const order = [];
  for (const draft of list) {
    const seen = new Set();
    for (const point of draft.keyPoints ?? []) {
      const text = cleanText(point);
      const key = text.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (!counts.has(key)) {
        counts.set(key, { text, count: 0 });
        order.push(key);
      }
      counts.get(key).count += 1;
    }
  }
  let keyPoints;
  if (list.length < 2) {
    keyPoints = order.map((key) => counts.get(key).text);
  } else {
    const agreed = order.filter((key) => counts.get(key).count >= 2).map((key) => counts.get(key).text);
    const primary = (list[0].keyPoints ?? []).map((point) => cleanText(point)).filter(Boolean);
    keyPoints = agreed.length ? agreed : primary;
  }
  return {
    summary: summaryMerge.text,
    keyPoints: keyPoints.slice(0, 6),
    providers: list.map((draft) => modelName(draft.provider)).filter(Boolean),
    summaryAgreement: summaryMerge.agreement,
  };
}

function causalKey(relation, evidence) {
  return `${String(relation ?? '').trim()}|${String(evidence ?? '').trim().toLowerCase()}`;
}

/**
 * 因果投票不能发明规则没认出的关系。
 * 只有一个模型时，留下能对上规则的条目，交给 applyModelCausalLinks 核对原句。
 * 两个及以上时，relation + evidence 至少两家相同才留下；用词再有两家相同就用那一版，否则用主模型那一版。
 */
export function mergeCausalVotes({ deterministic, modelSets } = {}) {
  const allowed = new Set((Array.isArray(deterministic) ? deterministic : []).map((link) => causalKey(link?.relation, link?.evidence)));
  const sets = (Array.isArray(modelSets) ? modelSets : []).filter((set) => set && Array.isArray(set.links));
  if (sets.length === 0 || allowed.size === 0) return [];
  if (sets.length === 1) {
    return sets[0].links.filter((item) => item && allowed.has(causalKey(item.relation, item.evidence)));
  }
  const groups = new Map();
  for (const set of sets) {
    const seen = new Set();
    for (const item of set.links) {
      if (!item) continue;
      const key = causalKey(item.relation, item.evidence);
      if (!allowed.has(key) || seen.has(key)) continue;
      seen.add(key);
      const bucket = groups.get(key) ?? [];
      bucket.push({
        relation: String(item.relation).trim(),
        evidence: String(item.evidence).trim(),
        cause: cleanText(item.cause),
        effect: cleanText(item.effect),
      });
      groups.set(key, bucket);
    }
  }
  const agreed = [];
  for (const votes of groups.values()) {
    if (votes.length < 2) continue;
    const wording = new Map();
    for (const vote of votes) {
      const key = `${vote.cause}\n${vote.effect}`;
      const entry = wording.get(key) ?? { cause: vote.cause, effect: vote.effect, count: 0 };
      entry.count += 1;
      wording.set(key, entry);
    }
    let chosen = null;
    for (const entry of wording.values()) {
      if (entry.count >= 2 && (!chosen || entry.count > chosen.count)) chosen = entry;
    }
    const fallback = votes[0];
    agreed.push({
      relation: fallback.relation,
      evidence: fallback.evidence,
      cause: chosen?.cause || fallback.cause,
      effect: chosen?.effect || fallback.effect,
    });
  }
  return agreed;
}

function clock(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const seconds = Math.floor(total / 1000);
  const pad = (value) => String(value).padStart(2, '0');
  const hh = Math.floor(seconds / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  const ss = seconds % 60;
  return hh > 0 ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

/** 已有字幕的批量翻译。每个模型都问一遍；一家失败就弃权，不改用下一家。 */
export async function translateSubtitleCues({ cues, models, translate, cap = SUBTITLE_CUE_CAP, signal } = {}) {
  if (typeof translate !== 'function') throw new Error('translateSubtitleCues 需要 translate');
  const limit = Math.max(1, Math.min(SUBTITLE_CUE_CAP, Math.round(Number(cap) || SUBTITLE_CUE_CAP)));
  const limited = (Array.isArray(cues) ? cues : []).filter((cue) => cleanText(cue?.text ?? cue?.src)).slice(0, limit);
  const modelList = normalizeModelList(models).slice(0, COURSE_MODEL_CAP);
  if (modelList.length === 0) throw new Error('没有可用的翻译模型');
  const byModel = modelList.map((provider) => ({ provider, cues: [] }));
  for (const cue of limited) {
    if (signal?.aborted) {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      throw error;
    }
    const id = String(cue.id ?? cue.t0Ms ?? '');
    await Promise.all(modelList.map(async (provider, index) => {
      try {
        const result = await translate({ text: cleanText(cue.text ?? cue.src), provider, signal });
        byModel[index].cues.push({
          id,
          text: cleanText(result?.text),
          provider: modelName(result?.provider) || provider,
        });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        byModel[index].cues.push({ id, text: '', provider });
      }
    }));
  }
  return limited.map((cue) => {
    const id = String(cue.id ?? cue.t0Ms ?? '');
    const candidates = byModel.map((set) => {
      const found = set.cues.find((item) => item.id === id);
      return { provider: found?.provider || set.provider, text: found?.text ?? '' };
    });
    return {
      id,
      t0Ms: Number(cue.t0Ms) || 0,
      t1Ms: Number(cue.t1Ms) || Number(cue.t0Ms) || 0,
      src: cleanText(cue.text ?? cue.src),
      ...mergeTranslations(candidates),
    };
  });
}

export function formatTranslationMarkdown({ title, cues } = {}) {
  const heading = cleanText(title) || '字幕翻译';
  const lines = [
    `# ${heading} · 字幕翻译`,
    '',
    '> 每个勾选的模型都翻译了这些已有字幕。说法一致时采用多数，对不上时采用主模型（列表第一个）。实时同传不在这里合并。',
    '',
  ];
  const list = Array.isArray(cues) ? cues : [];
  if (list.length === 0) {
    lines.push('（范围内没有可翻译的字幕。）');
  } else {
    for (const cue of list) {
      const label = AGREEMENT_LABEL[cue.agreement] ?? AGREEMENT_LABEL.none;
      const who = cue.supporters?.length ? cue.supporters.join('、') : (cue.provider || '模型');
      lines.push(`- ${clock(cue.t0Ms)} **${label}**（${who}）`);
      lines.push(`  - 原文：${cue.src || ''}`);
      lines.push(`  - 译文：${cue.text || '（没有可用译文）'}`);
    }
  }
  return `${lines.join('\n').trim()}\n`;
}
