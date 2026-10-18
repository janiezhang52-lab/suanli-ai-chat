// This is deliberately a textual-copy check, not a test of whether colleagues
// agree. Shared facts, short confirmations and correct numeric answers are fine.
const normalize = value => value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\p{P}\p{S}\p{Z}\p{C}]/gu, '');
const numericAnswer = /^(?:(?:答案|结果)(?:是|为)?|约|大约|等于)?[\p{N}零〇一二三四五六七八九十百千万亿点负]+(?:(?:年|月|日|号|小时|分钟|秒钟|时|分|秒|元|美元|人民币|千米|公里|米|厘米|毫米|千克|公斤|克|摄氏度|度|倍|个|人|次|天|周|kg|km|cm|mm|usd|cny|rmb|ms|s)[\p{N}零〇一二三四五六七八九十百千万亿点负]*)*$/u;

export function requestsFixedReply(prompt) {
  // A negated request ("不要统一回复") is not permission to copy. Check each
  // clause independently so "不要展开，只回复收到" still keeps its fixed answer.
  return prompt.split(/[，。！？；\n]/u).some(clause => {
    if (/(?:不要|别|不用|不必|无需|不允许).{0,5}(?:统一|原样|逐字|固定|只|仅)?(?:回复|回答|输出)/u.test(clause)) return false;
    return /(?:统一|一律|原样|逐字|固定)(?:地|要|给我|直接)?(?:回复|回答|输出)/u.test(clause)
      || /(?:全部|都|只|仅|就|必须|务必|准确|严格)(?:地|要|需|须|给我|直接|用|按)?(?:回复|回答|说|输出)(?:为|成|如下|以下|这句|这句话|这几个字|相同|一样|一致|：|:|[“「『"'])/u.test(clause)
      || /(?:回复|回答|输出)(?:完全)?(?:相同|一样|一致|原文|原话|固定文本)/u.test(clause)
      || /(?:回复|回答|输出)\s*(?:[:：]\s*|[“「『‘"'])/u.test(clause)
      || /(?:只|仅)(?:需|要)?(?:回复|回答|说|输出)\s*[^，。！？\n]{1,100}(?:[，。！？]|$)/u.test(clause)
      || /(?:reply|respond|answer|output)\s+(?:only|exactly|verbatim|with the same)\b/iu.test(clause)
      || /(?:only|exactly|verbatim)\s+(?:reply|respond|answer|output)\b/iu.test(clause);
  });
}

// Banded edit distance prevents a 32-member round from turning into an
// unbounded quadratic comparison. Only a tiny number of edits counts as a copy.
function almostSame(left, right) {
  if (left === right) return true;
  if (Math.min(left.length, right.length) < 16) return false;
  const limit = Math.min(24, Math.floor(Math.max(left.length, right.length) * 0.08));
  if (Math.abs(left.length - right.length) > limit) return false;
  let previous = new Map([[0, 0]]);
  for (let column = 1; column <= Math.min(right.length, limit); column++) previous.set(column, column);
  for (let row = 1; row <= left.length; row++) {
    const current = new Map();
    let lowest = limit + 1;
    for (let column = Math.max(0, row - limit); column <= Math.min(right.length, row + limit); column++) {
      const value = column === 0 ? row : Math.min(
        (previous.get(column) ?? Infinity) + 1,
        (current.get(column - 1) ?? Infinity) + 1,
        (previous.get(column - 1) ?? Infinity) + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      if (value <= limit) current.set(column, value);
      lowest = Math.min(lowest, value);
    }
    if (lowest > limit) return false;
    previous = current;
  }
  return (previous.get(right.length) ?? Infinity) <= limit;
}

export function repeatsRoundReply({ agent, prompt, roundReplies = [] }, content) {
  if (requestsFixedReply(prompt) || typeof content !== 'string') return false;
  const candidate = normalize(content);
  // Six characters also catches short copied reactions such as "好，6点到，
  // 听你说" while leaving "收到" or yes/no alone. Numeric answers stay exempt.
  if (candidate.length < 6 || candidate.length > 4000 || numericAnswer.test(candidate)) return false;
  return roundReplies.slice(-32).some(reply => {
    if (reply.speaker === agent.id || reply.speaker === agent.name) return false;
    const previous = normalize(reply.content);
    return previous.length >= 6 && previous.length <= 4000 && almostSame(candidate, previous);
  });
}

export function repeatsShortNotice({ prompt }, content) {
  if (requestsFixedReply(prompt) || typeof content !== 'string') return false;
  if (/[?？"'“”‘’「」『』`]/u.test(prompt)) return false;
  const notice = normalize(prompt);
  // Only literal meeting/farewell notices qualify. Questions, quoted text,
  // translations and arbitrary short inputs must never trigger this rewrite.
  const simpleNotice = /^(?:(?:大家)?(?:现在)?(?:开始)?开会(?:吧)?|(?:今天(?:就)?到这(?:里)?)?(?:大家)?下班(?:吧|啦|了)?|(?:大家)?散会(?:吧)?)$/u;
  return simpleNotice.test(notice) && normalize(content) === notice;
}

export function repeatsUserAnnouncement({ prompt }, content) {
  if (requestsFixedReply(prompt) || typeof content !== 'string') return false;
  // Quoted speech belongs to its quoted speaker. Replace it with a marker so
  // text around a quote cannot accidentally join into a matching declaration.
  const withoutQuotes = value => value.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"]*"|'[^']*'/gu, '〈引用〉');
  const source = withoutQuotes(prompt);
  const reply = withoutQuotes(content);
  const candidate = normalize(reply);
  const declaration = /(?:我|咱们)(?:先|来|要|想|就|简单){0,3}(?:说|讲|宣布)/u;
  if (candidate.length < 6 || candidate.length > 4000 || !declaration.test(source)) return false;
  // Preserve the exact whole-message case, including an unpunctuated prompt.
  if (candidate === normalize(source)) return true;
  const clauses = /[^，,。.!！？?；;：:\n]+/gu;
  const announcements = new Set([...source.matchAll(clauses)]
    .map(match => normalize(match[0]))
    .filter(value => value.length >= 6 && /^(?:我|咱们)(?:先|来|要|想|就|简单){0,3}(?:说|讲|宣布)/u.test(value)));
  for (const match of reply.matchAll(clauses)) {
    if (!announcements.has(normalize(match[0]))) continue;
    // "你说：我简单说两句" is an explicit attribution, even without quotes.
    const before = reply.slice(0, match.index);
    if (/(?:你|用户|老板)(?:刚才|刚刚|之前|刚|还|是)?(?:说(?:了|过|的)?|表示|提到|的意思是)[：:,，\s]*$/u.test(before)) continue;
    return true;
  }
  return false;
}
