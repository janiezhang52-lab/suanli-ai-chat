import type { Agent, ChatState, ProviderId } from './types';
import { DEFAULT_PERSONALITIES_BY_AGENT_ID } from './personalities';

export const PROVIDERS: {id:ProviderId;label:string;model:string;key:string}[] = [
  {id:'openai',label:'GPT / ChatGPT 会员',model:'',key:''},
  {id:'gemini',label:'Google Gemini',model:'',key:'GEMINI_API_KEY'},
  {id:'deepseek',label:'DeepSeek（火山方舟）',model:'deepseek-v4-1-flash-260910',key:'DOUBAO_API_KEY'},
  {id:'moonshot',label:'Moonshot / Kimi',model:'',key:'MOONSHOT_API_KEY'},
  {id:'doubao',label:'火山方舟（豆包 / DeepSeek）',model:'',key:'DOUBAO_API_KEY'},
  {id:'xai',label:'xAI / Grok',model:'',key:'XAI_API_KEY'},
  {id:'zhipu',label:'智谱 GLM',model:'glm-4-flash-250414',key:'ZHIPU_API_KEY'},
];
export const INITIAL_AGENTS: Agent[] = [
  {id:'gpt',name:'GPT',provider:'openai',model:'',role:'',color:'#167f67',symbol:'✳'},
  {id:'kimi',name:'Kimi',provider:'moonshot',model:'kimi-k2.6',role:'',color:'#242627',symbol:'K'},
  {id:'doubao',name:'豆包',provider:'doubao',model:'doubao-seed-2-1-turbo-260628',role:'',color:'#e99561',symbol:'豆'},
  {id:'zhipu',name:'智谱',provider:'zhipu',model:'glm-4-flash-250414',role:'',color:'#8a70ad',symbol:'智'},
  {id:'deepseek',name:'DeepSeek',provider:'doubao',model:'deepseek-v4-1-flash-260910',role:'',color:'#4d6ee3',symbol:'D'},
];
export function initialState():ChatState {
 return {
  agents:INITIAL_AGENTS.map(a=>({...a,role:DEFAULT_PERSONALITIES_BY_AGENT_ID[a.id]||a.role})),
  rooms:[{id:'team',name:'我简单说两句',members:INITIAL_AGENTS.map(a=>a.id),messages:[]}],
 };
}
export function demoReply(agent:Agent):string {
 const examples:Record<ProviderId,string> = {
  openai:'我来整理行动顺序：先确定一个具体目标，再拆成三个可完成的小步骤，最后约定怎么判断结果。你可以先把最想解决的问题写成一句话。',
  gemini:'提供一个创意角度：从大家熟悉的小场景切入，用一个意外的对比抓住注意力，再自然引出你的观点。',
  deepseek:'我建议先检查三个问题：目标是否明确、依据是否充分、下一步是否可执行。把假设和已经确认的信息分开，会更容易做决定。',
  moonshot:'我可以按「背景 → 关键问题 → 可选方案 → 下一步」整理信息。内容较多时，先抓住最影响决定的两三点。',
  doubao:'表达可以再生活化一点：少一点抽象的概念，多一个具体的例子。像跟朋友聊天一样，先说对方最在意的那句话。',
  xai:'我来提个反问：如果只能保留一个最重要的部分，你会留下什么？先把它做扎实，可能比一开始什么都做更有效。',
  zhipu:'我可以补充一个不同角度：先找出方案里最不确定的假设，再设计一个今天就能完成的小实验，用结果决定下一步。',
 };
 return examples[agent.provider];
}
