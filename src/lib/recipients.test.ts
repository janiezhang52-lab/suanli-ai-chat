import test from 'node:test';
import assert from 'node:assert/strict';
// Node's native TypeScript loader requires the source extension.
import { conversationFocus, resolveRecipients } from './recipients.ts';

const members = [
  { id: 'gpt', name: 'GPT' }, { id: 'kimi', name: 'Kimi' },
  { id: 'doubao', name: '豆包' }, { id: 'zhipu', name: '智谱' },
  { id: 'deepseek', name: 'DeepSeek' },
];
const all = members.map(member => member.id);
const user = (content: string) => ({ speaker: 'user', content });
const focused = [user('就GPT留下')];

test('the reported meeting sequence keeps only GPT speaking across follow-ups', () => {
  const messages: { speaker: string; content: string }[] = [];
  for (const prompt of ['@GPT 你留下，剩下人下班', '你不问问为什么让你留下', '你们走，就GPT留下']) {
    assert.deepEqual(resolveRecipients(prompt, members, messages).targetIds, ['gpt']);
    messages.push(user(prompt), { speaker: 'gpt', content: '老板，我留下。' });
  }
  assert.deepEqual(conversationFocus(members, messages), ['gpt']);
});

test('natural names, aliases, multiple colleagues, and direct vocatives', () => {
  for (const prompt of ['就 GPT 留下', 'ChatGPT 你来', '@GPT你留下', 'gPt，说说你的看法', 'GPT，为什么会这样？']) {
    assert.deepEqual(resolveRecipients(prompt, members, []).targetIds, ['gpt'], prompt);
  }
  for (const prompt of ['GPT和豆包留下', 'GPT 和 豆包 说说', '让GPT和豆包回答', 'GPT、豆包，你们怎么看']) {
    assert.deepEqual(resolveRecipients(prompt, members, []).targetIds, ['gpt', 'doubao'], prompt);
  }
  assert.deepEqual(resolveRecipients('GLM 你说说', members, []).targetIds, ['zhipu']);
  assert.deepEqual(resolveRecipients('deepseek，帮我算一下', members, []).targetIds, ['deepseek']);
});

test('negative directives exclude members and never summon dismissed colleagues', () => {
  const cases: [string, string[]][] = [
    ['除了GPT其他人说说', all.filter(id => id !== 'gpt')],
    ['除了 GPT，其他人都说说', all.filter(id => id !== 'gpt')],
    ['智谱先别说话', all.filter(id => id !== 'zhipu')],
    ['GPT别回答，Kimi来', ['kimi']],
    ['GPT，先别说话，Kimi你来', ['kimi']],
    ['不要让GPT回答，Kimi来', ['kimi']],
    ['@GPT 不用回答，@Kimi 来', ['kimi']],
    ['你们走，就GPT留下', ['gpt']],
    ['GPT和Kimi留下，其他人下班', ['gpt', 'kimi']],
  ];
  for (const [prompt, expected] of cases) assert.deepEqual(resolveRecipients(prompt, members, []).targetIds, expected, prompt);
});

test('explicit collective instructions reset focus; bare you plural does not', () => {
  for (const prompt of ['大家回来，一起聊聊', '所有人说说', '全员回答', '你们一起聊聊', '@所有人', '不要只让GPT说，大家都说说', '大家辛苦了，下班', '大家晚上好', '大家准备开会']) {
    assert.deepEqual(resolveRecipients(prompt, members, focused).targetIds, all, prompt);
  }
  assert.deepEqual(resolveRecipients('你们走，就GPT留下', members, []).targetIds, ['gpt']);
  assert.deepEqual(resolveRecipients('你们怎么看', members, focused).targetIds, ['gpt']);
  assert.deepEqual(resolveRecipients('大家说完了，就 GPT 留下', members, []).targetIds, ['gpt']);
  assert.deepEqual(resolveRecipients('大家回答，只有 GPT 留下', members, []).targetIds, ['gpt']);
  assert.deepEqual(resolveRecipients('只让GPT说，大家都说说', members, []).targetIds, all);
  assert.deepEqual(resolveRecipients('就GPT留下，@所有人', members, []).targetIds, all);
});

test('references, comparisons, quotations, hypotheses, and similar words do not change scope', () => {
  for (const prompt of [
    'Kimi刚才说得对', 'GPT是什么', '比较GPT和Kimi', '如果我说就GPT留下会怎样',
    '我觉得 GPT 的办法不错', '只有 GPT 能做到吗？', '把“就 GPT 留下”翻译成英文',
    '“@Kimi 你来”这句话是什么意思', '```\n@Kimi 你来\n```\n解释上面的内容',
    '小豆包说说这个词是什么意思', 'GPT4你来', 'MyChatGPT说说', 'DeepSeeker留下',
    'Kimi 的人格是什么', '大家刚才说得都对', 'Kimi说得对', '智谱说自己留下', 'Kimi回答得很好', "'@Kimi 你来'是什么意思",
  ]) assert.deepEqual(resolveRecipients(prompt, members, focused).targetIds, ['gpt'], prompt);
});

test('unknown @ names block sending without changing the existing conversation focus', () => {
  const resolution = resolveRecipients('@不存在的成员 你说说', members, focused);
  assert.deepEqual(resolution.targetIds, []);
  assert.deepEqual(resolution.focusIds, ['gpt']);
  assert.deepEqual(resolution.unknownNames, ['不存在的成员']);
  assert.equal(resolution.reason, 'silent');
  assert.deepEqual(resolveRecipients('@GPT @Nobody 来聊', members, focused).targetIds, []);
});

test('only user turns affect replay; separate or cleared histories start with everyone', () => {
  assert.deepEqual(conversationFocus(members, [...focused, { speaker: 'zhipu', content: '就智谱留下' }]), ['gpt']);
  assert.deepEqual(conversationFocus(members, [{ speaker: 'assistant', content: '@Kimi 你来' }]), all);
  assert.deepEqual(conversationFocus(members, []), all);
  assert.deepEqual(resolveRecipients('开会', members, []).targetIds, all);
  assert.deepEqual(resolveRecipients('接着说', members, focused).targetIds, ['gpt']);
  assert.deepEqual(resolveRecipients('除了GPT其他人说说', members, focused).targetIds, all.filter(id => id !== 'gpt'));
});

test('silence persists until a new named or collective instruction', () => {
  const silent = [user('所有人先别说话')];
  assert.deepEqual(conversationFocus(members, silent), []);
  assert.deepEqual(resolveRecipients('等等', members, silent).targetIds, []);
  assert.deepEqual(resolveRecipients('Kimi回来', members, silent).targetIds, ['kimi']);
  assert.deepEqual(resolveRecipients('大家回来', members, silent).targetIds, all);
});

test('the reported end-of-day goodbye permits replies and never saves an empty focus', () => {
  const prompt = '今天就到这里，大家下班吧';
  assert.deepEqual(resolveRecipients(prompt, members, []).targetIds, all);
  const history = [user(prompt)];
  assert.deepEqual(conversationFocus(members, history), all);
  assert.deepEqual(resolveRecipients('为什么没人理我了', members, history).targetIds, all);
  assert.deepEqual(resolveRecipients('@所有人', members, history).targetIds, all);
  assert.deepEqual(resolveRecipients('明天见', members, history).targetIds, all);
});

test('farewells allow acknowledgements while explicit retained speakers still take priority', () => {
  for (const prompt of ['大家下班吧', '所有人先休息', '全员散会', '今天就到这里，大家回去吧']) {
    assert.deepEqual(resolveRecipients(prompt, members, []).targetIds, all, prompt);
    assert.deepEqual(conversationFocus(members, [user(prompt)]), all, prompt);
  }
  for (const prompt of ['GPT下班吧', 'GPT，先休息', '@GPT 下班吧']) {
    assert.deepEqual(resolveRecipients(prompt, members, focused).targetIds, ['gpt'], prompt);
    assert.deepEqual(conversationFocus(members, [...focused, user(prompt)]), ['gpt'], prompt);
  }
  for (const prompt of ['就GPT留下，其他人下班', '大家下班，就GPT留下', '就GPT留下，大家下班', 'Kimi下班，GPT你留下', '@Kimi 下班，@GPT 你留下']) {
    assert.deepEqual(resolveRecipients(prompt, members, []).targetIds, ['gpt'], prompt);
  }
  assert.deepEqual(resolveRecipients('大家说说，GPT下班', members, []).targetIds, all.filter(id => id !== 'gpt'));
});

test('explicit pauses still work including all-member mentions', () => {
  for (const prompt of ['所有人先别说话', '大家不用回复', '@所有人 先别回复', '@所有人 不用回答', '全员闭麦']) {
    assert.deepEqual(resolveRecipients(prompt, members, []).targetIds, [], prompt);
    assert.deepEqual(conversationFocus(members, [user(prompt)]), [], prompt);
  }
  assert.deepEqual(resolveRecipients('GPT先别回复', members, focused).targetIds, []);
  assert.deepEqual(resolveRecipients('大家先别回复，大家说说', members, []).targetIds, all);
});

test('clear invitations and requests for a response resume a paused room', () => {
  const silent = [user('@所有人 先别回复')];
  for (const prompt of ['开会', '开始开会', '继续聊', '可以说话了', '怎么没人理我', '为什么没人理我了', '有人吗', '大家都在吗', '大家回来', '大家上班']) {
    assert.deepEqual(resolveRecipients(prompt, members, silent).targetIds, all, prompt);
    assert.deepEqual(conversationFocus(members, [...silent, user(prompt)]), all, prompt);
  }
  for (const prompt of ['等等', '先等等', '继续等', '今天讨论开会的问题', '开会是什么意思', '如果我说开会会怎样', '比如开会', '“开会”', '翻译“有人吗”', '他说，可以说话了']) {
    assert.deepEqual(resolveRecipients(prompt, members, silent).targetIds, [], prompt);
  }
  assert.deepEqual(resolveRecipients('开会', members, focused).targetIds, ['gpt']);
});

test('renamed agents keep ID aliases, absent members cannot be selected, aliases never collide', () => {
  const renamed = members.map(member => member.id === 'gpt' ? { ...member, name: '小冷' } : member);
  assert.deepEqual(resolveRecipients('小冷你来', renamed, []).targetIds, ['gpt']);
  assert.deepEqual(resolveRecipients('GPT你来', renamed, []).targetIds, ['gpt']);
  const smaller = members.filter(member => member.id !== 'kimi');
  assert.deepEqual(resolveRecipients('@Kimi 你来', smaller, []).unknownNames, ['Kimi']);
  const collision = [...members, { id: 'custom', name: 'GPT' }];
  assert.deepEqual(resolveRecipients('@GPT 你来', collision, []).targetIds, []);
});
