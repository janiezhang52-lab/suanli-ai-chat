type Member = { id: string; name: string };
type Message = { speaker: string; content: string };

export type RecipientResolution = {
  targetIds: string[];
  focusIds: string[];
  reason: 'all' | 'addressed' | 'continue' | 'silent';
  unknownNames?: string[];
};

const KNOWN_ALIASES: Record<string, string[]> = {
  gpt: ['GPT', 'ChatGPT'],
  kimi: ['Kimi'],
  doubao: ['豆包'],
  zhipu: ['智谱', 'GLM'],
  deepseek: ['DeepSeek'],
};
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TOKEN = '§\\d+§';
const NAME_LIST = `(${TOKEN}(?:\\s*(?:和|与|跟|及|以及|还有|、|&|\\+|and)\\s*${TOKEN})*)`;
const LEAD = '(?:(?:请|麻烦|拜托|那|那么|现在|这次|接下来|接着|还有|再|就|只|仅|只有|只要|只让|只和|只跟|只听|让|叫|请让|麻烦让|请叫|我只想让|我想让|我只想和|我想和|我只和|我和|我只跟|我跟)\\s*)*';
const MODIFIER = '(?:(?:你们|你|您|先|都|也|再|就|只|暂时|继续|一起|给我|来)\\s*)*';
const SPEAK = '(?:留下|留一下|留着|留步|说说|说两句|说一句|说句话|说话|说|回答|回复|讲讲|讲|发言|聊聊|聊|接着说|继续说|来答|来讲|来聊|回来|过来|来一下|来|开始|帮我|帮忙|给我|你怎么看|怎么看|你觉得|你认为|你来|你帮|你能|你可以|你会|你知道|你有|你说|你想|你要|你还|你不|你是)';
const QUIET = '(?:不要|不用|别|不必|无需)(?:再)?\\s*(?:说|回答|回复|发言|参与|开口|聊|留下|出声|接话)|(?:先)?(?:闭麦|闭嘴|安静)';
const FAREWELL = '(?:下班|退下|走吧|回去|休息|散会)';
const COLLECTIVE = '(?:大家|所有人|全员|全部人|你们一起|你们都)';
// A new invitation ends an explicit pause; ordinary follow-ups such as "等等" do not.
const RESUME = /^(?:(?:开始|准备)?开会|继续(?:聊(?:聊|天)?|说(?:话)?|讨论)|(?:现在)?可以(?:说话|回复|发言|聊(?:天)?)了?|(?:怎么|为什么)(?:都)?(?:没有人|没人)(?:理我|说话|回复|回答)|有人(?:在)?吗|(?:大家|你们|所有人|全员|全体)(?:都)?(?:在吗|回来|上班|开始开会|怎么(?:都)?不(?:说话|回复|理我)))(?:了|吧|啊|呀|呢|啦|哦|嘛|吗)*$/;

// Mentioning a name inside quoted material is not addressing that member.
function unquoted(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`]*(?:`|$)/g, ' ')
    .replace(/“[^”]*(?:”|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|"[^"\n]*(?:"|$)|‘[^’]*(?:’|$)|'[^'\n]*(?:'|$)/g, ' ');
}

function aliasesFor(members: Member[]): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  for (const member of members) {
    const canonical = Object.entries(KNOWN_ALIASES).find(([id, aliases]) =>
      id === member.id.toLowerCase() || aliases.some(alias => alias.toLowerCase() === member.name.toLowerCase()));
    for (const alias of [member.name, ...(canonical?.[1] || [])]) {
      if (!alias.trim()) continue;
      const key = alias.toLowerCase();
      const ids = candidates.get(key) || new Set<string>();
      ids.add(member.id);
      candidates.set(key, ids);
    }
  }
  // A renamed member may collide with another member's alias. Never guess.
  return new Map([...candidates].filter(([, ids]) => ids.size === 1).map(([alias, ids]) => [alias, [...ids][0]]));
}

function interpret(prompt: string, members: Member[], currentFocus: string[]): RecipientResolution {
  const all = members.map(member => member.id);
  const order = (ids: Iterable<string>) => { const set = new Set(ids); return all.filter(id => set.has(id)); };
  const unchanged = (): RecipientResolution => ({
    targetIds: [...currentFocus], focusIds: [...currentFocus],
    reason: currentFocus.length === 0 ? 'silent' : currentFocus.length === all.length ? 'all' : 'continue',
  });
  let text = unquoted(prompt).trim();
  if (!text) return unchanged();
  // These are descriptions/examples of an instruction, rather than the instruction itself.
  if (/^(?:如果|假如|假设|比如|例如|举例|当我说|当有人说|假装我说|把|翻译|解释|比较|对比|什么是)/.test(text)) return unchanged();
  const canResume = currentFocus.length === 0 && !/^(?:听说|听到|他说|她说|老板说|刚才|刚刚)/.test(text);

  const aliases = aliasesFor(members);
  const aliasPatterns = [...aliases.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const aliasSource = aliasPatterns.join('|');
  const knownAt = aliasSource ? new RegExp(`^(${aliasSource})(?![a-zA-Z0-9_])`, 'i') : null;
  const explicit = new Set<string>();
  const unknown: string[] = [];
  let explicitAll = false;
  text = text.replace(/@([^\s@，,。！？!?；;：:、（）()「」“”"'<>]+)/g, (whole, token: string) => {
    if (/^(?:所有人|全员|大家|all)$/i.test(token)) { explicitAll = true; return '大家'; }
    const match = token.match(knownAt || /$a/);
    if (!match) { unknown.push(token); return whole; }
    explicit.add(aliases.get(match[1].toLowerCase())!);
    return token;
  });
  if (unknown.length) return { targetIds: [], focusIds: [...currentFocus], reason: 'silent', unknownNames: [...new Set(unknown)] };

  const idTokens = new Map(members.map((member, index) => [member.id, `§${index}§`]));
  if (aliasSource) text = text.replace(new RegExp(`(?<![a-zA-Z0-9_])(${aliasSource})(?![a-zA-Z0-9_])`, 'gi'), value => idTokens.get(aliases.get(value.toLowerCase())!)!);
  const idsIn = (value: string) => [...value.matchAll(/§(\d+)§/g)].map(match => members[Number(match[1])].id);
  const positive = new Set<string>();
  const excluded = new Set<string>();
  const departing = new Set<string>();
  let wantsAll = explicitAll;
  let farewellAll = false;
  let resume = false;
  let exclusiveAfterAll: string[] | null = null;
  let allQuiet = false;
  let exclusionFromAll = false;

  // "除了 GPT，其他人说说" explicitly includes the rest of the room, even after a private exchange.
  const except = text.match(new RegExp(`(?:^|[，,。；;！!？?\\n])\\s*除了\\s*${NAME_LIST}\\s*(?:以外|之外)?\\s*[，,]?\\s*(?:其他人|其余人|剩下(?:的人|人)?|大家|所有人|都)(?:都|也|一起|来|先|请|可以|要)*\\s*(?:说|聊|回答|回复|讲|发言|留下|来)`));
  if (except) { idsIn(except[1]).forEach(id => excluded.add(id)); exclusionFromAll = true; }

  let clauses = text.split(/[，,。；;！!？?\n]+/).map(clause => clause.trim()).filter(Boolean);
  // Keep a name followed by a comma attached to its directive: "GPT，先别说话".
  const onlyNames = new RegExp(`^${LEAD}${NAME_LIST}$`, 'i');
  clauses = clauses.reduce<string[]>((result, clause) => {
    const previous = result.at(-1);
    if (previous && onlyNames.test(previous) && !new RegExp(TOKEN).test(clause)) result[result.length - 1] = `${previous} ${clause}`;
    else result.push(clause);
    return result;
  }, []);

  for (const clause of clauses) {
    if (/^(?:如果|假如|假设|比如|例如|听说|听到|我觉得|我认为|他说|她说|老板说|刚才|刚刚)/.test(clause)) continue;
    if (canResume && RESUME.test(clause)) resume = true;
    const collectiveStart = new RegExp(`^${LEAD}${COLLECTIVE}\\s*${MODIFIER}`);
    const collective = clause.match(collectiveStart);
    if (collective) {
      const rest = clause.slice(collective[0].length);
      if (new RegExp(`^(?:${QUIET})`).test(rest)) { allQuiet = true; wantsAll = false; resume = false; }
      else if (new RegExp(`^(?:${FAREWELL})`).test(rest)) farewellAll = true;
      else if (!/^(?:说(?:完|过|了|得)|聊(?:完|过|了)|回答(?:完|过|了)|刚才|刚刚|之前|上次)/.test(rest) &&
        (!rest || /^(?:说|聊|回答|回复|讲|发言|回来|过来|来|留下|开始|觉得|认为|怎么看|一起|都|帮我|帮忙|给我|辛苦了|早上好|早安|中午好|下午好|晚上好|晚安|你好|准备(?:一下)?开会|开会)/.test(rest))) {
        wantsAll = true;
        allQuiet = false;
        exclusiveAfterAll = null;
      }
    }

    const named = clause.match(new RegExp(`^${LEAD}${NAME_LIST}\\s*`, 'i'));
    if (named) {
      const ids = idsIn(named[1]);
      const rest = clause.slice(named[0].length);
      if (/^(?:的|是(?:什么|谁)|说(?:得|过|了|自己|的|他|她)|回答得|回复得|讲得|觉得|认为|刚才|刚刚|之前|上次|曾经)/.test(rest)) continue;
      if (new RegExp(`^${MODIFIER}(?:${QUIET})`).test(rest)) ids.forEach(id => excluded.add(id));
      else if (new RegExp(`^${MODIFIER}(?:${FAREWELL})`).test(rest)) ids.forEach(id => departing.add(id));
      else if (!rest || new RegExp(`^${MODIFIER}${SPEAK}`).test(rest) || /^你(?:[，,\s]|$)/.test(rest)) {
        ids.forEach(id => positive.add(id));
        const beforeName = clause.slice(0, clause.indexOf(named[1]));
        if (/(?:只|仅|就)/.test(beforeName)) exclusiveAfterAll = ids;
      }
      // A comma after a name is a direct vocative, even for questions such as "GPT，为什么会这样？".
      else if (new RegExp(`(?:^|[，,。；;！!？?\\n])\\s*${LEAD}${escapeRegExp(named[1])}\\s*[，,]`).test(text) && !/^(?:刚才|刚刚|之前|上次|曾经|的|是(?:什么|谁)|说得|说过)/.test(rest)) ids.forEach(id => positive.add(id));
    }
    const negativeLead = clause.match(new RegExp(`^(?:请)?(?:不要|不用|别|不必|无需)(?:再)?(?:让|叫|请|打扰)?\\s*${NAME_LIST}\\s*(?:${MODIFIER})`, 'i'));
    if (negativeLead) {
      const rest = clause.slice(negativeLead[0].length);
      if (!rest || /^(?:说|聊|回答|回复|讲|发言|参与|留下|开口)/.test(rest)) idsIn(negativeLead[1]).forEach(id => excluded.add(id));
    }
  }

  // Explicit @ is authoritative, with exclusions still taking precedence.
  explicit.forEach(id => positive.add(id));
  let selected: string[];
  if (exclusiveAfterAll) selected = exclusiveAfterAll;
  else if (wantsAll || exclusionFromAll) selected = all;
  else if (positive.size) selected = order(positive);
  else if (allQuiet) selected = [];
  else if (farewellAll || resume) selected = all;
  else if (departing.size) selected = order(departing);
  else if (excluded.size) selected = currentFocus;
  else return unchanged();
  // Saying goodbye permits an acknowledgement. Departures only remove speakers when
  // another instruction also specifies who should continue the discussion.
  const omitDeparting = !!exclusiveAfterAll || wantsAll || exclusionFromAll || [...positive].some(id => !departing.has(id));
  const focusIds = order(selected.filter(id => !excluded.has(id) && !(omitDeparting && departing.has(id))));
  return { targetIds: [...focusIds], focusIds, reason: focusIds.length === 0 ? 'silent' : wantsAll && focusIds.length === all.length ? 'all' : 'addressed' };
}

/** Recover scope from this room's user messages, so reloads work without a second saved state. */
export function conversationFocus(members: Member[], messages: Message[]): string[] {
  let focus = members.map(member => member.id);
  for (const message of messages) {
    if (message.speaker === 'user') focus = interpret(message.content, members, focus).focusIds;
  }
  return focus;
}

export function resolveRecipients(prompt: string, members: Member[], messages: Message[]): RecipientResolution {
  return interpret(prompt, members, conversationFocus(members, messages));
}
