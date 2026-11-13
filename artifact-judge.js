/**
 * artifact-judge.js — 圣遗物筛选系统 v2.5 判定引擎（唯一文档《圣遗物筛选系统最终方案.md》配套）
 * 用法：
 *   node artifact-judge.js                     运行内置演示件（默认 最大档口径/毕业期）
 *   node artifact-judge.js --scale avg --stage 新手
 *   断言回归：node artifact-judge.test.js
 *   作为模块：const { judge, scoreArtifact, validateArt } = require('./artifact-judge');
 *
 * 判定管线（定版文档 §3）：
 *   G0 锁定闸  游戏内锁定/收藏 → 保护
 *   G1 极品闸  通用词条(暴击/暴伤/精通/大小攻生防)单词条当量≥4.5 或 双暴≥4.5 或 通用总当量≥10
 *   G2 稀缺闸  杯/头 且 双暴词条≥3 → 观察·稀缺散件
 *   G3 评分闸  双视角（全库默认 / opts.char 角色特例）；阈值随类别+账号阶段+凑套修正；
 *              未满级期望分模型 E[S] = S + nRem×0.85×0.9×mean(w|既有词条行)
 *   G4 回收站  候选狗粮 30 天冷静期（调用方落地）
 *
 * v2.5 凑套进度（2026-11-04）：judge 新增 opts.setInv（套装名→筛选列表拥有件数），
 *      4件套推荐加分按已集件数打折（1/2/3/4件 = 35%/55%/80%/100%），2件套适配凑满 2 件前只算一半，
 *      理由链标注"已集 N/4"；未传 setInv 时按满分处理（向后兼容，旧调用/测试不受影响）
 * v2.4 参考评分（2026-11-04）：G1 保护件也计算最优流派评分/归属/可穿角色（state 仍为"保护"，
 *      不参与分流），方便和「当前穿戴」列对比；G0 锁定件保持无评分（可能无词条数据）
 * v2.1 自检修正（详见文档附录D）：
 *   A1 换算系数仅用于最大档口径（平均档按配置原值），修复 avg 模式阈值宽松 14.5%
 *   A2 输入校验：非法槽位/词条键/行数/重复行/数值 → 抛出可读错误（不再 NaN 崩溃）
 *   A3 omp 改为整槽覆盖（基线偏好不再泄漏进角色视角）
 *   B1 3 词条未满级件豁免"死胚直接狗粮"（+4 必新开第 4 行）
 *   B3 G1 总当量只计通用词条（与单词条检查同一原则）
 *   B4 nRem 向上取整（13 级 = 剩 2 档）
 *   B5 所有返回统一携带 crit/total
 * v2.2 二次检验修正（详见文档附录D）：
 *   D1 文档附录A 补齐 18 行（奥黛塔/卡维/雷电将军/米卡等），规则改为"每挂载流派都列出"
 *   E1 锁定闸先于输入校验（锁定件无需词条数据即可保护）
 *   E2 拒绝"等级≥4 却只有 3 行"的不可能数据
 *   E3 锁定返回补 crit/total（null）
 *   E4 凑套修正改为观察线×0.85（随阶段等比，修复新手期降 31% 的过激问题）
 * v2.3 套装适配层（详见文档附录D）：
 *   2件套效果文本自动解析成等效词条（parse2pc），× 流派权重 = 适配分（与副词条同一套权重语义）；
 *   4件套流派推荐表（配置 reco4）命中 +0.8；2件套适配 ≤0.5；总加分上限 1.0。
 *   只加分不扣分（散件 2+2+1 不惩罚）；散件/无关套装为 0；
 *   通过 opts.setDB 传入套装数据库（缺省不启用，向后兼容），参与 G3 argmax。
 */

const fs = require('fs');
const path = require('path');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '流派配置.json'), 'utf8'));

// 特例类型 → 中文短标签（理由链用）
const SP_SHORT = {
  no_er: '充能零收益', er_as_damage: '充能即伤害', no_crit: '双暴零收益',
  atk_scale_support: '攻击拐/攻击盾', base_atk_buff: '增益只吃白值',
  def_scale_support: '防御拐', hp_offfield: '后台吃生命', hp_heal: '治疗吃生命',
  hp_threshold: '生命阈值转化', atk_threshold: '攻击阈值天赋', em_heal: '治疗挂精通',
  crit_head_required: '双暴头刚需', hybrid_em_carry: '精通副收益', er_heavy: '高充能阈值',
  dual_form: '多形态'
};

const SLOTS = ['生之花', '死之羽', '沙', '杯', '头'];
const SLOT_ALIAS = { '时之沙': '沙', '空之杯': '杯', '理之冠': '头' };
const FIXED_SLOTS = { '生之花': true, '死之羽': true };
const UNIVERSAL = ['暴击', '暴伤', '精通', '大攻', '大生', '大防']; // 通用词条：G1 单词条/总当量检查范围
/* 主词条 → 同类的副词条键（同一种属性不能同时出现在主副词条；
   攻击力% 与 固定攻击力 是两种属性，可共存） */
const MAIN_SUB_CONFLICT = {
  '固定生命值': '小生', '固定攻击力': '小攻',
  '攻击力%': '大攻', '生命值%': '大生', '防御力%': '大防',
  '元素充能效率': '充能', '元素精通': '精通',
  '暴击率': '暴击', '暴击伤害': '暴伤'
};

// 主词条名 → 主词条偏好键（与 流派配置.json main_pref 的键对应）
function mainKey(main) {
  if (/元素伤害加成|物理伤害加成/.test(main)) return '元素伤';
  if (/暴击/.test(main)) return '双暴';
  if (main === '治疗加成') return '治疗加成';
  if (main === '元素充能效率') return '充能';
  if (main === '元素精通') return '精通';
  if (main === '攻击力%') return '大攻';
  if (main === '生命值%') return '大生';
  if (main === '防御力%') return '大防';
  return null; // 花/羽固定主词条走独立分支
}

// ---- A2/B5 输入校验（v2.1）：非法输入抛可读错误，绝不让 NaN 进入评分 ----
function validateArt(art) {
  if (!art || typeof art !== 'object') throw new Error('圣遗物输入必须为对象');
  const slot = SLOT_ALIAS[art.slot] || art.slot;
  if (!SLOTS.includes(slot)) throw new Error(`非法槽位：${art.slot}（允许：生之花/死之羽/沙/杯/头，可写全称）`);
  if (typeof art.main !== 'string' || !art.main) throw new Error('缺少主词条 main（字符串）');
  if (art.level != null && (!Number.isInteger(art.level) || art.level < 0 || art.level > 20))
    throw new Error(`非法等级：${art.level}（应为 0~20 整数）`);
  const subs = art.subs || [];
  if (!Array.isArray(subs) || subs.length < 1 || subs.length > 4)
    throw new Error(`副词条行数应为 1~4，实际 ${Array.isArray(subs) ? subs.length : '非数组'}`);
  const seen = new Set();
  for (const s of subs) {
    if (!s || typeof s.stat !== 'string' || !(s.stat in CFG.roll_base.max))
      throw new Error(`非法副词条类型：${s && s.stat}（允许：${Object.keys(CFG.roll_base.max).join('/')}）`);
    if (!Number.isFinite(s.value) || s.value <= 0)
      throw new Error(`非法词条数值：${s.stat}=${s.value}（应为正数）`);
    if (seen.has(s.stat)) throw new Error(`重复词条行：${s.stat}（同一圣遗物不可能出现两行同词条）`);
    /* 单行词条上限：初始 1 次 + 至多 5 次强化 = 6 档（数值取该词条最高档 × 6） */
    if (s.value > CFG.roll_base.max[s.stat] * 6 + 1e-9)
      throw new Error(`副词条「${s.stat}」数值 ${s.value} 超过可能上限（单条最多 6 次强化 ≈ ${(CFG.roll_base.max[s.stat] * 6).toFixed(1)}）——请核对数值`);
    seen.add(s.stat);
  }
  if ((art.level ?? 20) >= 4 && subs.length < 4)
    throw new Error(`等级≥4 的圣遗物必有 4 行副词条（+4 新开第4行），实际 ${subs.length} 行`);
  /* v2.3：副词条不能与主词条同类（同一种属性；攻击力% 与 固定攻击力 是两种属性可共存） */
  const mainConflict = MAIN_SUB_CONFLICT[art.main];
  if (mainConflict && subs.some(s => s.stat === mainConflict))
    throw new Error(`副词条「${mainConflict}」与主词条「${art.main}」同类——同一种属性不能同时出现在主副词条`);
  return { ...art, slot };
}

// 口径换算：配置阈值为平均档口径；最大档口径按比值均值等比缩放（A1：平均档不缩放）
function scaleFactor(scale) {
  if (scale === 'avg') return 1;
  if (scale === 'max') {
    const a = CFG.roll_base.avg, m = CFG.roll_base.max;
    const keys = Object.keys(a);
    return keys.reduce((s, k) => s + a[k] / m[k], 0) / keys.length;
  }
  throw new Error(`非法口径：${scale}（应为 avg 或 max）`);
}

// 副词条数组 → 词条当量表（value / 基准值）
function rollEq(subs, scale) {
  const base = CFG.roll_base[scale];
  const eq = {};
  for (const s of subs) eq[s.stat] = (eq[s.stat] || 0) + s.value / base[s.stat];
  return eq;
}

// 单件 × 单流派 评分：S = f_main × (3 + Σ w×当量)
// 固定值词条（小攻/小生/小防）按实际增益折算到父属性的权重：
//   90级基础属性下 攻%_roll≈固定攻_roll（折0.9），生命%_roll≈3×固定生_roll（折0.35），防御%_roll≈2.4×固定防_roll（折0.4）
const FLAT_FOLD = { "小攻": 0.9, "小生": 0.35, "小防": 0.4 };
function scoreArtifact(art, T, eq) {
  let fMain = 0;
  if (FIXED_SLOTS[art.slot]) fMain = 1;
  else {
    const pref = T.main_pref[art.slot] || {};
    const k = mainKey(art.main);
    if (k && pref[k] != null) fMain = pref[k];
    else if (pref['任意'] != null) fMain = pref['任意'];
  }
  let sSub = 0;
  for (const [stat, v] of Object.entries(eq)) {
    const parent = stat[0] === '小' ? '大' + stat.slice(1) : stat;   // 小防 → 大防（父属性权重）
    const fold = FLAT_FOLD[stat] || 1;
    sSub += (T.weights[parent] || 0) * fold * v;
  }
  return fMain * (3 + sSub);
}

// ---- 角色特例层 ----
function getChar(name) { return CFG.char_map.find(c => c.n === name) || null; }

function specialOf(char) {
  if (!char) return [];
  return Object.entries(CFG.special_cases)
    .filter(([, v]) => Array.isArray(v.chars) &&
      v.chars.some(n => char.n === n || (n === '旅行者' && char.n.startsWith('旅行者'))))
    .map(([k]) => SP_SHORT[k] || k);
}

// 角色特例覆盖后的流派模板：ow 并入权重；omp 整槽覆盖（v2.1 A3：不再与基线合并）
function charEff(T, char) {
  if (!char) return T;
  const weights = char.ow ? { ...T.weights, ...char.ow } : T.weights;
  let main_pref = T.main_pref;
  if (char.omp) {
    main_pref = { ...T.main_pref };
    for (const slot of Object.keys(char.omp)) main_pref[slot] = { ...char.omp[slot] };
  }
  return { ...T, weights, main_pref };
}

// ---- 未满级期望分模型（B4：nRem 向上取整）----
function expectedGain(art, T) {
  const nRem = Math.ceil((20 - (art.level ?? 20)) / 4);
  const lines = (art.subs || []).map(s => s.stat);
  if (!lines.length || nRem <= 0) return { eds: 0, nRem };
  const meanW = lines.reduce((a, st) => a + (T.weights[st] || 0), 0) / lines.length;
  return { eds: nRem * 0.85 * 0.9 * meanW, nRem };
}

// ---- v2.3 套装适配层 ----
const ATTR_SHOW = { "大攻": "攻击%", "大生": "生命%", "大防": "防御%", "充能": "充能", "精通": "精通" };
/* 2件套效果文本 → 等效词条（数值 ÷ 对应词条的强化基准），与副词条同一套量纲 */
const SET_2PC_PATTERNS = [
  [/攻击力[提升提高增加加成]*(\d+(?:\.\d+)?)%/, "大攻", 5.8],
  [/生命值[提升提高增加加成]*(\d+(?:\.\d+)?)%/, "大生", 5.8],
  [/防御力[提升提高增加加成]*(\d+(?:\.\d+)?)%/, "大防", 7.3],
  [/元素充能效率[提升提高增加加成]*(\d+(?:\.\d+)?)%/, "充能", 6.5],
  [/元素精通[提升提高增加加成]*(\d+(?:\.\d+)?)(?!%)/, "精通", 23]
];
function parse2pc(text) {
  if (!text) return null;
  for (const [re, attr, base] of SET_2PC_PATTERNS) {
    const m = text.match(re);
    if (m) return { attr, rolls: Number(m[1]) / base };
  }
  if (/伤害|反应/.test(text)) return { attr: "伤加成", rolls: 0 };   // 条件型/伤害型2件套：标签近似
  return null;
}
/* 套装适配分（对某一流派）：
   B4 = 0.8  该件套装 ∈ 流派推荐4件套（毕业套装件）
   B2 = min(0.15 × 2件套等效词条 × 流派权重, 0.5)；「伤加成」标签型 = +0.3（该流派杯位吃元素伤时）
   总加分上限 1.0；散件 / 套装属性与流派无关 = 0。只加分不扣分。 */
function setBonus(art, T, setDB, owned = 4, include4 = true) {
  const empty = { bonus: 0, label: "" };
  if (!art.set || !setDB || !setDB[art.set]) return empty;
  const info = setDB[art.set];
  const parts = [];
  let bonus = 0;
  /* v2.5 凑套进度：4件套推荐加分按玩家已拥有的件数打折（1件35% / 2件55% / 3件80% / ≥4件满分）；
     2件套适配在凑满 2 件前只算一半——2件套效果要凑到 2 件才真正生效
     v2.6 include4=false 时只算 2件套适配（"假设只有2件套"场景用） */
  owned = Math.max(1, Math.min(owned || 4, 9));
  const f4 = include4 ? (owned >= 4 ? 1 : owned === 3 ? 0.8 : owned === 2 ? 0.55 : 0.35) : 0;
  const f2 = owned >= 2 ? 1 : 0.5;
  if (Array.isArray(T.reco4) && T.reco4.includes(art.set)) { bonus += 0.8 * f4; parts.push("4件套推荐·已集" + Math.min(owned, 4) + "/4"); }
  const p2 = parse2pc(info.pc2 || "");
  if (p2) {
    if (p2.attr === "伤加成") {
      if (((T.main_pref["杯"] || {})["元素伤"] >= 0.6)) { bonus += 0.3 * f2; parts.push("2件套伤害类适配"); }
    } else if ((T.weights[p2.attr] || 0) > 0) {
      const b2 = Math.min(0.15 * p2.rolls * T.weights[p2.attr], 0.5) * f2;
      if (b2 > 0.005) { bonus += b2; parts.push("2件套" + (ATTR_SHOW[p2.attr] || p2.attr) + "适配"); }
    }
  }
  bonus = Math.min(bonus, 1.0);
  return { bonus, label: parts.join("+") };
}

function judge(artInput, opts = {}) {
  const scale = opts.scale || 'max';
  const k = scaleFactor(scale);                 // A1：avg=1，max≈0.855
  const stage = opts.stage || '毕业';
  if (!CFG.account_stage[stage]) throw new Error(`非法账号阶段：${stage}`);
  const char = opts.char ? getChar(opts.char) : null;
  if (opts.char && !char) throw new Error(`角色不存在：${opts.char}`);
  const sp = specialOf(char);
  const charInfo = char ? { char: char.n, special: sp } : {};

  // ---- G0 锁定闸（v2.2 E1：先于输入校验——锁定件无需词条数据即可保护）----
  if (artInput && artInput.locked)
    return { state: '保护', why: '游戏内锁定/收藏', eq: {}, crit: null, total: null, ...charInfo };

  const art = validateArt(artInput);
  const eq = rollEq(art.subs || [], scale);
  /* v2.5 凑套进度：玩家筛选列表里该套装已拥有的件数（含本件）；未传库存时按满分 4 件处理（向后兼容） */
  const owned = opts.setInv ? Math.max(1, opts.setInv[art.set] || 1) : 4;

  const crit = (eq['暴击'] || 0) + (eq['暴伤'] || 0);
  const total = Object.values(eq).reduce((a, b) => a + b, 0);
  const g = CFG.gates;

  // ---- G1 通用极品闸（单词条与总当量均只计通用词条，B3）----
  const g1Single = g.G1_protect_single * k, g1Crit = g.G1_protect_crit * k, g1Total = g.G1_protect_total * k;
  const totalU = UNIVERSAL.reduce((s, st) => s + (eq[st] || 0), 0);
  if (Math.max(...UNIVERSAL.map(s => eq[s] || 0)) >= g1Single || crit >= g1Crit || totalU >= g1Total) {
    /* v2.4：保护件同样给出参考评分（state 不变，仅供对比"它穿在谁身上 vs 它最适合谁"） */
    let ref = {};
    try {
      const pool = char ? CFG.archetypes.filter(T => char.t.includes(T.id)) : CFG.archetypes;
      let best = -1, bestT = null;
      for (const T of pool) {
        const s = scoreArtifact(art, charEff(T, char), eq) + setBonus(art, T, opts.setDB, owned).bonus;
        if (s > best) { best = s; bestT = T; }
      }
      if (bestT) ref = { score: best, tag: bestT.tag, tid: bestT.id,
        chars: CFG.char_map.filter(c => c.t.includes(bestT.id)).map(c => c.n) };
    } catch (e) { /* 评分失败不影响保护判定 */ }
    return { state: '保护', why: '通用极品（G1）', crit, total, eq, ...ref, ...(char && { char: char.n, special: sp }) };
  }

  // ---- G2 稀缺槽散件闸 ----
  const g2Crit = g.G2_crit_min * k;
  if (g.G2_scary_slots.includes(art.slot) && crit >= g2Crit) {
    /* v2.4：与 G1 同理——观察件也给出参考评分（state 不变） */
    let ref = {};
    try {
      const pool = char ? CFG.archetypes.filter(T => char.t.includes(T.id)) : CFG.archetypes;
      let best = -1, bestT = null;
      for (const T of pool) {
        const s = scoreArtifact(art, charEff(T, char), eq) + setBonus(art, T, opts.setDB, owned).bonus;
        if (s > best) { best = s; bestT = T; }
      }
      if (bestT) ref = { score: best, tag: bestT.tag, tid: bestT.id,
        chars: CFG.char_map.filter(c => c.t.includes(bestT.id)).map(c => c.n) };
    } catch (e) { /* 评分失败不影响观察判定 */ }
    return { state: '观察', why: '稀缺槽双暴散件（G2）', crit, total, eq, ...ref, ...(char && { char: char.n, special: sp }) };
  }

  // ---- G3 评分闸 ----
  const pool = char ? CFG.archetypes.filter(T => char.t.includes(T.id)) : CFG.archetypes;
  if (!pool.length) throw new Error(`角色 ${char.n} 无有效流派标签`);
  let best = -1, bestT = null;
  for (const T of pool) {
    /* 套装适配分参与 argmax：不同流派推荐不同，骑墙件的归属可能因套装改变（正确行为） */
    const s = scoreArtifact(art, charEff(T, char), eq) + setBonus(art, T, opts.setDB, owned).bonus;
    if (s > best) { best = s; bestT = T; }
  }
  const cls = CFG.threshold_class[bestT.cls];
  const stg = CFG.account_stage[stage];
  const setOn = !!(opts.setCounts && art.set && (opts.setCounts[art.set] || 0) >= 2); // P3 凑套修正（v2.2 E4：观察线×0.85，随阶段等比）
  const keep = cls.keep * stg.keep * k;
  const watch = cls.watch * stg.watch * k * (setOn ? 0.85 : 1);

  const erLow = bestT.er_need === '低' && (eq['充能'] || 0) >= 2 &&
                !(char && char.ow && char.ow['充能'] === 0);
  /* v2.3 套装适配：对归属流派重算一遍以取详情（加分已在 argmax 中计入） */
  const setB = setBonus(art, bestT, opts.setDB, owned);
  const hint = (erLow ? '｜⚠该流派充能需求低，充能词条可能溢出' : '') +
               (setOn ? '｜含凑套修正（观察线×0.85）' : '') +
               (setB.label ? `｜套装适配 +${setB.bonus.toFixed(2)}（${setB.label}）` : '') +
               (sp.length ? `｜特例: ${sp.join('/')}` : '');

  // 未满级期望分模型
  const level = art.level ?? 20;
  let effScore = best, conf = null, eds = 0;
  if (level < 20) {
    ({ eds } = expectedGain(art, bestT));
    effScore = best + eds;
    conf = level <= 4 ? '低' : level <= 12 ? '中' : '高';
  }
  const expNote = level < 20 ? `｜未满级：当前 ${best.toFixed(2)} + 期望 ${eds.toFixed(2)} = 潜力 ${effScore.toFixed(2)}（置信${conf}）` : '';

  // P2 双条件判定；B1：3 词条未满级件下限为观察（+4 新开第 4 行）
  let state, why;
  if (level < 20 && effScore >= keep) { state = '观察·高潜'; why = '潜力达保留线，满级后重判' }
  else if (effScore >= keep) { state = '★保留'; why = `归属「${bestT.tag}」过保留线` }
  else if (effScore >= watch || crit >= 2) { state = '观察'; why = `归属「${bestT.tag}」过渡/双暴兜底` }
  else if (level < 20 && (art.subs || []).length < 4) { state = '观察'; why = '3词条胚子：+4 将新开第4行，先强化观察' }
  else { state = '候选狗粮'; why = `最高仅 ${effScore.toFixed(2)}（${bestT.tag}${level < 20 ? '含期望' : ''}）且无双暴兜底` }

  // G4：候选狗粮 → 回收站 30 天冷静期（调用方落地），建议去向由 UI 层生成
  const mapped = CFG.char_map.filter(c => c.t.includes(bestT.id)).map(c => c.n);   // 全量返回，UI 层负责截断展示
  return { state, score: best, potential: level < 20 ? effScore : undefined, conf,
           tag: bestT.tag, tid: bestT.id, setBonus: setB.bonus,
           chars: mapped, ...charInfo, crit, total,
           why: `${why}${expNote}｜双暴合计 ${crit.toFixed(1)} 条｜折合词条 ${total.toFixed(1)} 条${hint}`, eq };
}

/* v2.6 三场景推荐：这件圣遗物在"只当散件 / 凑成2件套 / 凑成4件套"三种假设下分别最适合谁。
   不看真实库存——每个场景都按"假设已凑齐"计算（solo=纯单件无套装分；pc2=只吃2件套属性；pc4=吃2+4件套属性）。
   返回 { solo, pc2, pc4 }，每项 = { score, tag, chars }（该场景下得分最高的流派 + 可穿角色全量） */
function bestFit(artInput, opts = {}) {
  const art = validateArt(artInput);
  const eq = rollEq(art.subs || [], opts.scale || 'max');
  const char = opts.char ? getChar(opts.char) : null;
  const pool = char ? CFG.archetypes.filter(T => char.t.includes(T.id)) : CFG.archetypes;
  const fit = (mode) => {
    let best = -1, bestT = null;
    for (const T of pool) {
      let b = 0;
      if (mode !== 'solo' && art.set) {
        b = setBonus(art, T, opts.setDB, mode === 'pc2' ? 2 : 4, mode === 'pc4').bonus;
      }
      const s = scoreArtifact(art, charEff(T, char), eq) + b;
      if (s > best) { best = s; bestT = T; }
    }
    const chars = bestT ? CFG.char_map.filter(c => c.t.includes(bestT.id)).map(c => c.n) : [];
    return { score: best, tag: bestT ? bestT.tag : '—', chars };
  };
  return { solo: fit('solo'), pc2: fit('pc2'), pc4: fit('pc4') };
}


/* v2.6 得分明细：复现 judge 最优流派评分的构成（现实凑套进度），供 UI 点击得分展开查看。
   返回 { tag, fMain, mainMatch, base, sSub, items[], setBonus, score, crit, total } */
function scoreDetail(artInput, opts = {}) {
  const art = validateArt(artInput);
  const eq = rollEq(art.subs || [], opts.scale || 'max');
  const char = opts.char ? getChar(opts.char) : null;
  const owned = opts.setInv ? Math.max(1, opts.setInv[art.set] || 1) : 4;
  const pool = char ? CFG.archetypes.filter(T => char.t.includes(T.id)) : CFG.archetypes;
  let best = -1, bestT = null, bestSet = null;
  for (const T of pool) {
    const sb = setBonus(art, T, opts.setDB, owned);
    const s = scoreArtifact(art, charEff(T, char), eq) + sb.bonus;
    if (s > best) { best = s; bestT = T; bestSet = sb; }
  }
  /* 主词条匹配度（与 scoreArtifact 同逻辑，展开成可读文本） */
  let fMain, mainMatch;
  if (FIXED_SLOTS[art.slot]) { fMain = 1; mainMatch = "花/羽主词条固定，匹配度 1"; }
  else {
    const pref = bestT.main_pref[art.slot] || {};
    const key = mainKey(art.main);
    if (key && pref[key] != null) { fMain = pref[key]; mainMatch = "流派吃「" + art.main + "」主词条，匹配度 " + fMain; }
    else if (pref['任意'] != null) { fMain = pref['任意']; mainMatch = "该流派主词条不限，匹配度 " + fMain; }
    else { fMain = 0; mainMatch = "该流派不吃「" + art.main + "」主词条，匹配度 0（主词条不对，得分归零）"; }
  }
  /* 逐条词条加权：小X 折算到父属性（FLAT_FOLD），权重 0 的词条列出但计 0 分 */
  const items = [];
  let sSub = 0;
  for (const [stat, v] of Object.entries(eq)) {
    const parent = stat[0] === '小' ? '大' + stat.slice(1) : stat;
    const fold = FLAT_FOLD[stat] || 1;
    const w = bestT.weights[parent] || 0;
    const contrib = w * fold * v;
    sSub += contrib;
    items.push({ stat, v, w, fold, contrib });
  }
  items.sort((a, b) => b.contrib - a.contrib);
  return { tag: bestT.tag, tid: bestT.id, fMain, mainMatch, base: 3, sSub, items,
           setBonus: bestSet, score: fMain * (3 + sSub) + bestSet.bonus,
           crit: (eq['暴击'] || 0) + (eq['暴伤'] || 0),
           total: Object.values(eq).reduce((a, b) => a + b, 0) };
}


// ---------------- 内置演示件 ----------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const scale = args.includes('--scale') ? args[args.indexOf('--scale') + 1] : 'max';
  const stage = args.includes('--stage') ? args[args.indexOf('--stage') + 1] : '毕业';
  console.log(`口径=${scale}（阈值系数 ${scaleFactor(scale).toFixed(3)}） 账号阶段=${stage}\n`);

  const cases = [
    { name: '案例1·防御双暴杯（会被白名单误删的散件）',
      art: { slot: '杯', main: '防御力%', level: 20, locked: false,
        subs: [{ stat: '暴击', value: 6.2 }, { stat: '暴伤', value: 13.2 }, { stat: '充能', value: 11.0 }, { stat: '大防', value: 6.2 }] } },
    { name: '案例2·鸡肋生命沙（该清理的，满级）',
      art: { slot: '沙', main: '生命值%', level: 20, locked: false,
        subs: [{ stat: '小防', value: 23 }, { stat: '小生', value: 269 }, { stat: '小攻', value: 19 }, { stat: '大防', value: 5.1 }] } },
    { name: '案例3·双暴天堂花（谁都能穿的极品）',
      art: { slot: '生之花', main: '固定生命值', level: 20, locked: false,
        subs: [{ stat: '暴击', value: 9.4 }, { stat: '暴伤', value: 21.1 }, { stat: '大攻', value: 19.3 }, { stat: '精通', value: 37 }] } },
    { name: '案例4·精通羽毛（P8 非双暴极品保护）',
      art: { slot: '死之羽', main: '固定攻击力', level: 20, locked: false,
        subs: [{ stat: '精通', value: 90 }, { stat: '充能', value: 15.0 }, { stat: '大攻', value: 5.8 }, { stat: '小攻', value: 18 }] } },
    { name: '案例5·+0火伤杯胚子（期望分模型：高潜）',
      art: { slot: '杯', main: '火元素伤害加成', level: 0, locked: false,
        subs: [{ stat: '暴击', value: 3.9 }, { stat: '暴伤', value: 7.8 }, { stat: '大攻', value: 5.8 }, { stat: '充能', value: 6.5 }] } },
    { name: '案例9·+0死词条生命沙（期望分模型：死胚救不活→直接狗粮）',
      art: { slot: '沙', main: '生命值%', level: 0, locked: false,
        subs: [{ stat: '小防', value: 23 }, { stat: '小生', value: 269 }, { stat: '小攻', value: 19 }, { stat: '大防', value: 5.1 }] } },
    { name: '案例6·充能冰伤杯（丝柯克不吃充能）',
      art: { slot: '杯', main: '冰元素伤害加成', level: 20, locked: false,
        subs: [{ stat: '充能', value: 19.5 }, { stat: '暴击', value: 3.9 }, { stat: '暴伤', value: 7.8 }, { stat: '大攻', value: 5.8 }] },
      char: '丝柯克' },
    { name: '案例7·双暴精通羽毛（心海暴击零收益）',
      art: { slot: '死之羽', main: '固定攻击力', level: 20, locked: false,
        subs: [{ stat: '暴击', value: 7.8 }, { stat: '暴伤', value: 7.8 }, { stat: '精通', value: 46 }, { stat: '充能', value: 13 }] },
      char: '珊瑚宫心海' },
    { name: '案例8·生命充能沙（夏沃蕾生命阈值特例）',
      art: { slot: '沙', main: '生命值%', level: 20, locked: false,
        subs: [{ stat: '大生', value: 17.4 }, { stat: '充能', value: 13 }, { stat: '暴击', value: 3.9 }, { stat: '大防', value: 7.3 }] },
      char: '夏沃蕾' },
  ];

  for (const { name, art, char } of cases) {
    const r = judge(art, { scale, stage });
    console.log(`【${name}】`);
    console.log(`  全流派视角：${r.state}｜${r.why}${r.score != null && r.state !== '候选狗粮' ? `｜${r.score.toFixed(2)}（${r.tag}）` : ''}`);
    if (char) {
      const rc = judge(art, { scale, stage, char });
      console.log(`  ${char}视角：${rc.state}｜${rc.why}${rc.score != null && rc.state !== '候选狗粮' ? `｜${rc.score.toFixed(2)}（${rc.tag}）` : ''}`);
    }
    console.log('');
  }
}

module.exports = { judge, bestFit, scoreDetail, scoreArtifact, rollEq, getChar, specialOf, charEff, expectedGain, validateArt, scaleFactor, parse2pc, setBonus, CFG };
