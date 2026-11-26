/**
 * 「这个文件/这条搜索结果，到底是不是这首歌」——名字层面的判据。
 *
 * 只放在一个模块里，是因为有三处要用，而且必须用**同一套**规则，
 * 否则会出现「取链时判失败、缓存校验时判通过」这种自相矛盾：
 *   · `online.ts`  → 出链后核音频文件头里的 TITLE
 *   · `audioCache.ts` → 播缓存前核文件标签（缓存是永久性的，一次错就永远错）
 *   · 跨平台兜底打分时也参考同一套归一化
 *
 * 规则很简单：**去掉括号里的版本说明，再要求互相包含**。
 *   · 「花海」vs「花海 (DJ 阿若版)」→ 归一化后 `花海` ⊂ `花海dj阿若版` → 同一首
 *   · 「孤勇者」vs「唯一」→ 完全不沾边 → 不是同一首
 * 不做编辑距离：中文短标题上 bigram/Levenshtein 很容易把「孤勇」「孤勇者(Live)」
 * 之外的完全不同的两首歌判成相似，宁可只用「包含」这一条最硬的。
 */

/** 归一化：去括号后缀、去标点空白、统一小写 */
export function coreTitle(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/[（(【\[][^)）】\]]*[)）】\]]/g, '')
    .replace(/[\s·・\-—_/、,，.。'’"“”!！?？+&]+/g, '')
    .toLowerCase()
}

/**
 * 去掉括号里的版本说明，**其余原样保留**。
 *
 * 给「搜索词」用，所以不能归一化（`coreTitle` 会把空格也删掉，
 * 「晴天 周杰伦」变成「晴天周杰伦」，搜出来的结果会明显变差）。
 */
export function bareTitle(s: string | null | undefined): string {
  return String(s ?? '').replace(/[（(【\[][^)）】\]]*[)）】\]]/g, '').trim()
}

/**
 * 两边的名字是否**明显不是同一首**。
 *
 * 任一边拿不到名字（空 / 只有一两个字）时一律返回 false —— 不知道就当同一首，
 * 绝不能因为读不到标签就把好好的歌判死。
 */
export function titleMismatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = coreTitle(a)
  const y = coreTitle(b)
  if (x.length < 2 || y.length < 2) return false
  return !x.includes(y) && !y.includes(x)
}

/* ------------------------------------------------------------------ */
/* 版本标记                                                            */
/* ------------------------------------------------------------------ */

/**
 * 「这首歌是哪个版本」——括号里那些词，**必须**跟着歌名一起比对。
 *
 * 为什么不能只比核心歌名（`titleMismatch` 那条路）：核心歌名会**丢掉整个括号**，
 * 于是「寂寞才说爱」和「寂寞才说爱 (DJ版)」被当成同一首。这在「同名不同版本」
 * 的歌上就是灾难——用户 2026-11 报的正是这个：日推里点《寂寞才说爱》，
 * 出来的是 DJ 版，歌词（按原版匹配的）也跟着全错。
 *
 * 规则刻意保守，只认**强标记**（编曲方式 / 演出形式被换掉的版本），
 * 弱标记（重制 / 女声版…）只在一「有」一「无」时按硬标记判：
 *   · 期望没有 DJ，拿到的是 DJ 版          → 不是这首（最强的一类，宁可换源）
 *   · 期望是 DJ 版，拿到的是原版            → 不是这首
 *   · 期望 Live、拿到 Studio 版             → 不是这首（这也是「版本不对」）
 *   · 期望 Studio，拿到 Live 版             → 不是这首（2026-11-26 起，live 纳入硬标记）
 *   · 两边都没标记                          → 无从判断，放行
 *   · 两边标记系族相同（都是 live / 都是 dj）→ 放行（细差别管）
 *
 * **live 为什么从弱标记升成硬标记**：用户明确反馈「歌名不带 Live，却经常
 * 请求到 Live 版音频」。Live 版是现场录音——歌手、编曲、歌词顺序、时长都
 * 和录音室版不同，歌词匹配会整篇错位，和 DJ / 伴奏版一样属于「放出来就是
 * 错的」。代价是某些音源把 Live 随手写进 ID3、实际是录音室版时会被误判换源，
 * 但换源只是多花几百毫秒，比放错整首歌轻得多。
 */
const STRONG_TAGS: Array<[string, RegExp]> = [
  /* 英文缩写必须卡边界：不卡的话 "Adjust" / "Alive" 会被当成 DJ / Live 版 */
  ['dj', /(?:^|[^a-z])d\s*j(?![a-z])|咚鼓|弹鼓|慢摇|车载|抖音|越南鼓|社会摇|电音/i],
  ['remix', /remix|re\s*mix|混音|改编|加速版|降调|升调|8d|环绕声?/i],
  ['acoustic', /(?:^|[^a-z])acoustic(?![a-z])|不插电|钢琴版|吉他版|纯人声|清唱/i],
  ['instrumental', /伴奏|纯音乐|纯享|消音|instrumental|off\s?vocal|karaoke/i],
  ['live', /(?:^|[^a-z])live(?![a-z])|现场|演唱会/i],
]

/** 取出标题里所有版本标记的系族（去重、保序） */
export function versionTags(s: string | null | undefined): string[] {
  const raw = String(s ?? '')
  if (!raw) return []
  /* 括号内 + 括号外都要看：有的源把「DJ版」直接写在标题尾部 */
  const out: string[] = []
  for (const [name, re] of STRONG_TAGS) {
    if (re.test(raw)) out.push(name)
  }
  return out
}

/**
 * 「这两个名字指的是不是同一个**版本**」。
 *
 * 判定分两种情形，刻意不对称：
 *   · **只有一边有标记**：只对硬标记（DJ / 混音 / 伴奏 / Live）算不同版本。
 *     不插电这类弱标记不算——大量 MP3 的 ID3 里随手写着钢琴版，按它判会
 *     把正常歌曲杀掉，代价比偶尔放错一版大得多。
 *   · **两边都有标记却不重合**（一边 DJ、一边 Live）：一定是不同版本，判。
 *
 * Live 曾因「ID3 随手标注」被排除在硬标记外（旧注释），但实测用户反复撞到
 * 「点原版放出 Live 版、歌词全错」。两边都有标记时本来就会判，单边的情况
 * 从「宁可放过」改成「宁可换源」——一次多余的换源几百毫秒，一次放错整首歌
 * 要重听一遍，后者代价更大。
 */
const HARD_TAGS = new Set(['dj', 'remix', 'instrumental', 'live'])

export function versionMismatch(a: string | null | undefined, b: string | null | undefined): boolean {
  /*
   * 有一边根本没名字（调用方没传 / 文件无标签）时**不判**：
   * 不知道想要哪个版本，就不能说拿到的是错的——否则取链时那些没传
   * `expectTitle` 的路径会被一律判死。
   */
  if (!String(a ?? '').trim() || !String(b ?? '').trim()) return false
  const ta = versionTags(a)
  const tb = versionTags(b)
  if (!ta.length && !tb.length) return false
  if (ta.length && tb.length) return !ta.some(x => tb.includes(x))
  return (ta.length ? ta : tb).some(x => HARD_TAGS.has(x))
}
