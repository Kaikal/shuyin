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
