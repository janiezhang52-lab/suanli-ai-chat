import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowUp, AtSign, Check, ChevronDown, ChevronRight, CircleHelp, ContactRound, Copy, ExternalLink, MessageCircle, MessageSquare, PanelRightClose, PanelRightOpen, Plus, RefreshCw, Search, Settings2, Sparkles, Square, Trash2, UsersRound, X } from 'lucide-react';
import type { Agent, ChatState, Message, ProviderId, ProviderStatus } from './lib/types';
import { initialState, PROVIDERS } from './lib/demo';
import { stateSchema } from './lib/validation';
import { PERSONALITY_PRESETS, PERSONALITY_PLACEHOLDER } from './lib/personalities';
import { resolveRecipients, conversationFocus } from './lib/recipients';

type CacheEnvelope = {state:ChatState;revision:number;dirty:boolean;syncedState:ChatState};
type WorkspaceResponse = {state:ChatState|null;revision:number;ownerKey:string};
type SaveIssue = {kind:'identity'|'network'|'validation'|'conflict';message:string;requiresRefresh?:boolean};
type MemberStatus = {connected:boolean;planUsageEnabled?:boolean;model?:string;models?:{slug:string;display_name:string}[];pending?:boolean;error?:string};
type Modal = 'agent'|'group'|'settings'|'members'|'help'|'clear'|null;
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
const timeLabel = (time:string) => new Date(time).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Shanghai'});
function brandIcon(agent?:Agent):string|null {
 if(!agent)return null;
 // A model can be served by another provider, e.g. DeepSeek through Doubao.
 if(/deepseek/i.test(agent.model))return '/brand-icons/deepseek.png';
 const names=[agent.id,agent.name].map(value=>value.trim().toLowerCase());
 const aliases:Record<string,string>={gpt:'chatgpt',chatgpt:'chatgpt',openai:'chatgpt',kimi:'kimi',moonshot:'kimi',doubao:'doubao','豆包':'doubao',zhipu:'zhipu',glm:'zhipu','智谱':'zhipu','智谱glm':'zhipu',deepseek:'deepseek','深度求索':'deepseek'};
 for(const name of names){if(aliases[name])return `/brand-icons/${aliases[name]}.png`;}
 const providers:Partial<Record<ProviderId,string>>={openai:'chatgpt',moonshot:'kimi',doubao:'doubao',zhipu:'zhipu',deepseek:'deepseek'};
 return providers[agent.provider]?`/brand-icons/${providers[agent.provider]}.png`:null;
}
function Avatar({agent,size=38,groupTile=false}:{agent?:Agent;size?:number;groupTile?:boolean}) {
 const icon=brandIcon(agent);
 const [failedIcon,setFailedIcon]=useState<string|null>(null);
 const showIcon=icon!==null&&failedIcon!==icon;
 return <span className={`${groupTile?'group-avatar-cell':'avatar'}${showIcon?' brand-image-avatar':''}`} style={{width:groupTile?undefined:size,height:groupTile?undefined:size,background:showIcon?'#fff':agent?.color||'#ed9a60',fontSize:groupTile?undefined:size*.49}}>{showIcon?<img src={icon} alt="" draggable={false} onError={()=>setFailedIcon(icon)}/>:agent?.symbol||'我'}</span>;
}
function GroupAvatar({agents,size=42}:{agents:Agent[];size?:number}) {return <span className="group-avatar" style={{width:size,height:size}}>{agents.slice(0,4).map(a=><Avatar key={a.id} agent={a} groupTile/>)}</span>;}
function IconButton({label,onClick,children,className=''}:{label:string;onClick:()=>void;children:React.ReactNode;className?:string}) {return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick}>{children}</button>;}


function PersonalityField({value,onChange}:{value:string;onChange:(value:string)=>void}) {
 const fieldId=useId();
 return <div className="personality-field"><label htmlFor={fieldId}>人格与说话方式</label><div className="personality-presets" aria-label="人格预设">{PERSONALITY_PRESETS.map(preset=><button key={preset.id} type="button" aria-pressed={value.trim()===preset.role} onClick={()=>onChange(preset.role)}>{preset.name}</button>)}</div><textarea id={fieldId} value={value} onChange={e=>onChange(e.target.value)} maxLength={4000} rows={5} placeholder={PERSONALITY_PLACEHOLDER}/><div className="personality-field-note"><span>点预设填入，也可以按你的喜好改写。</span><small>{value.length} / 4000</small></div></div>;
}

// Keep the key outside ChatState and its browser cache. Unmounting this form on
// close or member switch discards an unsaved value; saved keys are never read back.
function ApiKeySettings({provider,ready,expectedOwnerKey,onSaved}:{provider:Exclude<ProviderId,'openai'>;ready:boolean;expectedOwnerKey:string|null;onSaved:()=>Promise<void>}) {
 const fieldId=useId();
 const [apiKey,setApiKey]=useState('');
 const [savingKey,setSavingKey]=useState(false);
 const [result,setResult]=useState<{error:boolean;message:string}|null>(null);
 const sharedArkKey=provider==='doubao'||provider==='deepseek';
 const label=sharedArkKey?'火山方舟':PROVIDERS.find(item=>item.id===provider)?.label||provider;
 async function saveKey(){
  if(savingKey)return;
  if(!apiKey.trim()){setResult({error:false,message:'未填写新密钥，原有配置保持不变。'});return;}
  if(!expectedOwnerKey){setResult({error:true,message:'尚未读取工作空间，请关闭设置并重新读取后再试。'});return;}
  setSavingKey(true);setResult(null);
  try{
   const response=await fetch('/api/local/provider-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider,apiKey,expectedOwnerKey})});
   const data=await response.json() as {saved?:boolean;error?:string};
   if(!response.ok){setResult({error:true,message:data.error||'密钥未能保存，请重试。'});return;}
   setApiKey('');
   setResult({error:false,message:data.saved?'密钥已加密保存。发送消息时会验证账号和模型权限。':'未填写新密钥，原有配置保持不变。'});
   await onSaved();
  }catch{setResult({error:true,message:'暂时无法确认保存结果，请重新打开 App 查看连接状态后重试。'});}
  finally{setSavingKey(false);}
 }
 return <form className="api-key-settings" onSubmit={event=>{event.preventDefault();void saveKey();}} autoComplete="off">
  <label htmlFor={fieldId}>{label} API Key</label>
  <input id={fieldId} type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={4096} value={apiKey} disabled={savingKey} placeholder={ready?'已配置；填写新密钥可替换':'粘贴你自己的 API Key'} onChange={event=>{setApiKey(event.target.value);setResult(null);}}/>
  {sharedArkKey&&<p>豆包和 DeepSeek 共用这一把火山方舟密钥。在任一成员这里保存，会同时更新两者；请在火山方舟为密钥开通所选模型权限。</p>}
  <p>密钥仅加密保存在这台 Mac；不会写进聊天或导出记录。留空不会修改已有密钥。</p>
  <button className="primary-button" type="submit" disabled={savingKey||!apiKey.trim()||!expectedOwnerKey}>{savingKey?'正在保存…':'保存密钥'}<Check size={14}/></button>
  {result&&<p className={result.error?'api-key-error':'api-key-result'} role={result.error?'alert':'status'}>{result.message}</p>}
 </form>;
}

export default function App() {
 const [state,replaceState] = useState<ChatState>(initialState);
 const [activeId,setActiveId] = useState('team');
 const [tab,setTab] = useState<'chats'|'contacts'>('chats');
 const [search,setSearch] = useState('');
 const [drafts,setDrafts] = useState<Record<string,string>>({});
 const [providers,setProviders] = useState<ProviderStatus[]>([]);
 const [memberStatus,setMemberStatus] = useState<MemberStatus>({connected:false});
 const [memberLoading,setMemberLoading] = useState(true);
 const [connectionError,setConnectionError] = useState('');
 const [showMembers,setShowMembers] = useState(true);
 const [mobileList,setMobileList] = useState(true);
 const [modal,setModal] = useState<Modal>(null);
 const [editingAgent,setEditingAgent] = useState<string|null>(null);
 const [formName,setFormName] = useState('');
 const [formProvider,setFormProvider] = useState<ProviderId>('openai');
 const [formModel,setFormModel] = useState('');
 const [formRole,setFormRole] = useState('');
 const [formMembers,setFormMembers] = useState<string[]>([]);
 const [settingsId,setSettingsId] = useState('gpt');
 const [personalityDrafts,setPersonalityDrafts] = useState<Record<string,string>>({});
 const [personalitySave,setPersonalitySave] = useState<{id:string;role:string}|null>(null);
 const [pending,setPending] = useState<{id:string;name:string;roomId:string}[]>([]);
 const [hydrated,setHydrated] = useState(false);
 const [saveStatus,setSaveStatus] = useState('正在读取');
 const [saveIssue,setSaveIssue] = useState<SaveIssue|null>(null);
 const [syncBusy,setSyncBusy] = useState(false);
 const [toast,setToast] = useState('');
 const [mentionOpen,setMentionOpen] = useState(false);
 const [formError,setFormError] = useState('');
 const [clearTargetId,setClearTargetId] = useState<string|null>(null);
 const [clearingRoomId,setClearingRoomId] = useState<string|null>(null);
 const revision = useRef(0);
 const stateRef = useRef(state);
 const ownerKey = useRef<string|null>(null);
 const syncedState = useRef<ChatState>(state);
 const hydratedRef = useRef(false);
 const loadGeneration = useRef(0);
 const conflict = useRef(false);
 const saveTimer = useRef<ReturnType<typeof setTimeout>|null>(null);
 const saveQueue = useRef<ChatState|null>(null);
 const saving = useRef(false);
 const controllers = useRef(new Map<string,AbortController>());
 const generation = useRef(0);
 const bottomRef = useRef<HTMLDivElement>(null);
 const inputRef = useRef<HTMLTextAreaElement>(null);
 const room = state.rooms.find(r=>r.id===activeId)||state.rooms[0];
 const members = state.agents.filter(a=>room?.members.includes(a.id));
 const privateChat = room?.id.startsWith('dm-');
 const clearTarget = state.rooms.find(r=>r.id===clearTargetId);
 const draft = drafts[room?.id]||'';
 const routingHistory = (room?.messages||[]).filter(message=>message.mode==='live'&&!message.error);
 const draftRouting = !privateChat&&draft.trim()?resolveRecipients(draft.trim(),members,routingHistory):null;
 const audiencePreview = privateChat?members.map(member=>member.id):(draftRouting?.targetIds??conversationFocus(members,routingHistory));
 const audienceNames = members.filter(member=>audiencePreview.includes(member.id)).map(member=>member.name);
 const audienceLabel = draftRouting?.unknownNames?.length?'点名未匹配':privateChat||audienceNames.length===members.length?'点名成员':audienceNames.length?`${audienceNames.join('、')} 回复`:'暂不回复';
 const activePending = pending.filter(p=>p.roomId===room?.id);
 const currentSettings = state.agents.find(a=>a.id===settingsId)||state.agents[0];
 const personalityDraft = personalityDrafts[currentSettings.id]??currentSettings.role;
 const savedPersonality = syncedState.current.agents.find(a=>a.id===currentSettings.id)?.role??currentSettings.role;
 const personalityDirty = personalityDraft.trim()!==savedPersonality;
 const providerReady = (id:ProviderId) => providers.find(p=>p.id===id)?.ready===true;
 function notify(message:string) {setToast(message);}
 useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),4500);return()=>clearTimeout(timer);},[toast]);
 function cacheKey(){return ownerKey.current?`kaigehui-local-state-v1:${encodeURIComponent(ownerKey.current)}`:null;}
 async function refreshConnections(){
  try{
   const [providerResult,memberResult]=await Promise.all([fetch('/api/providers',{cache:'no-store'}),fetch('/api/member/status',{cache:'no-store'})]);
   if(!providerResult.ok||!memberResult.ok)throw new Error('本机服务暂时没有响应，请确认启动窗口仍在运行。');
   const providerData=await providerResult.json() as {providers:ProviderStatus[]};
   const memberData=await memberResult.json() as MemberStatus;
   setProviders(providerData.providers||[]);setMemberStatus(memberData);setConnectionError('');
  }catch(error){setConnectionError(error instanceof Error?error.message:'无法读取接入状态，请重试。');}
  finally{setMemberLoading(false);}
 }
 function cacheCurrent(dirty:boolean){
  const key=cacheKey();if(!key)return;
  try{localStorage.setItem(key,JSON.stringify({state:stateRef.current,revision:revision.current,dirty,syncedState:syncedState.current} satisfies CacheEnvelope));}
  catch{notify('本机存储空间不足，请使用「导出全部记录」保存一份备份。');}
 }
 function applySnapshot(next:ChatState){stateRef.current=next;replaceState(next);setActiveId(old=>next.rooms.some(r=>r.id===old)?old:next.rooms[0].id);}
 function setState(update:ChatState|((previous:ChatState)=>ChatState)){
  if(!hydratedRef.current){notify('工作空间尚未读取完成，请先重试连接。');return;}
  const next=typeof update==='function'?update(stateRef.current):update;
  if(JSON.stringify(next)===JSON.stringify(stateRef.current))return;
  stateRef.current=next;replaceState(next);
  const dirty=saving.current||JSON.stringify(next)!==JSON.stringify(syncedState.current);
  cacheCurrent(dirty);saveQueue.current=dirty?next:null;
  if(saveTimer.current)clearTimeout(saveTimer.current);
  if(dirty&&!conflict.current){setSaveStatus('等待保存');saveTimer.current=setTimeout(()=>void flushSave(),500);}
 }
 function invalidateIdentity(message='本机工作空间已变化。已停止保存和模型请求，请导出当前记录，再刷新页面。'){
  hydratedRef.current=false;setHydrated(false);conflict.current=true;saveQueue.current=null;loadGeneration.current++;setSyncBusy(false);
  if(saveTimer.current)clearTimeout(saveTimer.current);
  generation.current++;controllers.current.forEach(c=>c.abort());controllers.current.clear();setPending([]);
  cacheCurrent(saving.current||JSON.stringify(stateRef.current)!==JSON.stringify(syncedState.current));
  setSaveIssue({kind:'identity',message,requiresRefresh:true});setSaveStatus('工作空间已变化');
 }
 function ensureReady(){if(hydratedRef.current)return true;notify('尚未确认工作空间，请先点击「重新读取」。');return false;}
 async function readWorkspace():Promise<WorkspaceResponse>{
  const result=await fetch('/api/state',{cache:'no-store'});
  const data=await result.json() as WorkspaceResponse&{error?:string};
  if(!result.ok)throw new Error(data.error||`工作空间读取失败（${result.status}）`);
  if(!data.ownerKey||!Number.isSafeInteger(data.revision))throw new Error('未能确认工作空间身份，请重试。');
  return data;
 }
 async function loadWorkspace(){
  const token=++loadGeneration.current;setSyncBusy(true);setSaveStatus('正在读取');
  try{
   const data=await readWorkspace();if(token!==loadGeneration.current)return;
   if(ownerKey.current&&ownerKey.current!==data.ownerKey){invalidateIdentity();return;}
   ownerKey.current=data.ownerKey;
   const cloud=data.state?.agents.length&&data.state.rooms.length?data.state:initialState();
   let cached:CacheEnvelope|null=null;
   try{
    const raw=localStorage.getItem(cacheKey()!);
    if(raw){const value=JSON.parse(raw) as CacheEnvelope;const parsed=stateSchema.safeParse(value.state);if(parsed.success&&parsed.data.agents.length&&parsed.data.rooms.length&&Number.isSafeInteger(value.revision)&&typeof value.dirty==='boolean')cached={...value,state:parsed.data as ChatState};}
   }catch{}
   revision.current=data.revision;syncedState.current=cloud;conflict.current=false;setSaveIssue(null);saveQueue.current=null;
   if(cached?.dirty){
    applySnapshot(cached.state);
    if(data.revision>cached.revision&&JSON.stringify(cached.state)===JSON.stringify(cloud)){
     cacheCurrent(false);setSaveStatus('已保存');
    }else if(cached.revision===data.revision){
     cacheCurrent(true);saveQueue.current=cached.state;setSaveStatus('等待保存');
    }else{
     revision.current=cached.revision;
     syncedState.current=cached.syncedState||cloud;
     conflict.current=true;cacheCurrent(true);setSaveStatus('存在保存冲突');
     setSaveIssue({kind:'conflict',message:'当前页面有尚未保存的修改，而本机记录也有更新。已保留本机全部内容，请导出备份，或主动载入本机已存版本。'});
    }
   }else{applySnapshot(cloud);cacheCurrent(false);setSaveStatus(data.state?'已保存':'尚未保存');}
   hydratedRef.current=true;setHydrated(true);
   if(saveQueue.current&&!conflict.current)saveTimer.current=setTimeout(()=>void flushSave(),0);
  }catch(error){
   if(token!==loadGeneration.current)return;
   setSaveStatus(ownerKey.current?'同步未完成':'未能读取');
   setSaveIssue({kind:ownerKey.current?'network':'identity',message:error instanceof Error?error.message:'工作空间读取失败，请重试。'});
   // Identity is required before reading any owner-scoped cached data.
   if(!ownerKey.current){hydratedRef.current=false;setHydrated(false);}
  }finally{if(token===loadGeneration.current)setSyncBusy(false);}
 }
 async function flushSave(){
  if(saving.current||!saveQueue.current||conflict.current||!hydratedRef.current)return;
  saving.current=true;setSyncBusy(true);
  while(saveQueue.current&&!conflict.current&&hydratedRef.current){
   const next:ChatState=saveQueue.current;saveQueue.current=null;setSaveStatus('保存中…');
   const body=JSON.stringify({state:next,revision:revision.current,expectedOwnerKey:ownerKey.current});
   if(new TextEncoder().encode(body).byteLength>500*1024){saveQueue.current=stateRef.current;setSaveStatus('内容超过保存上限');setSaveIssue({kind:'validation',message:'记录已超过保存容量，当前内容仍保留在浏览器中。请先导出全部记录；可载入本机已存版本继续使用。'});break;}
   try{
    const result=await fetch('/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body});
    const data=await result.json() as {revision?:number;error?:string;code?:string};
    if(!hydratedRef.current){cacheCurrent(true);break;}
    if(result.status===403&&data.code==='identity_changed'){invalidateIdentity();break;}
    if(!result.ok){
     saveQueue.current=stateRef.current;cacheCurrent(true);
     if(result.status===409){conflict.current=true;setSaveStatus('存在保存冲突');setSaveIssue({kind:'conflict',message:'另一个页面更新了本机记录。当前内容已保留在本机，请导出备份，或主动载入本机已存版本。'});}
     else{const validation=[400,413,415,422].includes(result.status);setSaveStatus(validation?'内容未能保存':'同步未完成');setSaveIssue({kind:validation?'validation':'network',message:data.error||`保存失败（${result.status}），当前内容已保留在本机。`});}
     break;
    }
    if(!Number.isSafeInteger(data.revision))throw new Error('保存服务返回了无效结果，请重试确认。');
    revision.current=data.revision!;syncedState.current=next;
    const dirty:boolean=JSON.stringify(stateRef.current)!==JSON.stringify(next);
    // Acknowledged revision also belongs to edits made while this request was in flight.
    cacheCurrent(dirty);saveQueue.current=dirty?stateRef.current:null;
    setSaveIssue(null);setSaveStatus(dirty?'等待保存':'已保存');
   }catch(error){
    saveQueue.current=stateRef.current;cacheCurrent(true);setSaveStatus('同步未完成');
    setSaveIssue({kind:'network',message:error instanceof Error?`保存暂未确认：${error.message}。本机内容已保留，可重试。`:'连接失败，本机内容已保留，请重试。'});break;
   }
  }
  saving.current=false;setSyncBusy(false);
 }
 function exportAll(){
  const payload={app:'算力有限责任公司',exportedAt:new Date().toISOString(),revision:revision.current,dirty:JSON.stringify(stateRef.current)!==JSON.stringify(syncedState.current),state:stateRef.current};
  const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=`算力有限责任公司-全部记录-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 async function loadCloudVersion(){
  if(saving.current||syncBusy)return;
  if(pending.length)stop();
  if(saveTimer.current)clearTimeout(saveTimer.current);
  setSyncBusy(true);
  try{
   const data=await readWorkspace();
   if(data.ownerKey!==ownerKey.current){invalidateIdentity();return;}
   const key=cacheKey();
   if(key){try{localStorage.setItem(`${key}:backup:${Date.now()}`,JSON.stringify({state:stateRef.current,revision:revision.current,dirty:true,syncedState:syncedState.current} satisfies CacheEnvelope));}catch{exportAll();notify('本机备份空间不足，已导出完整 JSON 备份。');}}
   const cloud=data.state?.agents.length&&data.state.rooms.length?data.state:initialState();
   revision.current=data.revision;syncedState.current=cloud;saveQueue.current=null;conflict.current=false;
   applySnapshot(cloud);cacheCurrent(false);setSaveIssue(null);setSaveStatus(data.state?'已保存':'尚未保存');setDrafts({});notify('已载入本机已存版本；此前本机内容已另存为备份。');
  }catch(error){notify(error instanceof Error?error.message:'读取失败，本机内容保持不变。');}
  finally{setSyncBusy(false);}
 }
 useEffect(()=>{
  if(window.matchMedia('(max-width: 1030px)').matches)setShowMembers(false);
  void loadWorkspace();
  void refreshConnections();
  const refresh=()=>{if(document.visibilityState==='visible')void refreshConnections();};
  window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
  return()=>{window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);loadGeneration.current++;if(saveTimer.current)clearTimeout(saveTimer.current);};
 },[]);
 useEffect(()=>{
  if(!personalitySave)return;
  const saved=syncedState.current.agents.find(a=>a.id===personalitySave.id);
  if(saved?.role===personalitySave.role){
   notify(`已保存 ${saved.name} 的人格，下一轮回复生效。`);setPersonalitySave(null);
  }else if(!syncBusy&&saveIssue){
   notify('人格暂未保存成功，编辑内容已保留，请重试保存。');setPersonalitySave(null);
  }
 },[personalitySave,saveStatus,syncBusy,saveIssue]);
 useEffect(()=>{if(modal!=='settings'&&!memberStatus.pending)return;const timer=setInterval(()=>void refreshConnections(),5000);return()=>clearInterval(timer);},[modal,memberStatus.pending]);
 useEffect(()=>{bottomRef.current?.scrollIntoView({behavior:'smooth',block:'end'});},[room?.id,room?.messages.length,activePending.length]);
 useEffect(()=>{
  if(!clearingRoomId)return;
  if(!saving.current&&!saveQueue.current&&!saveIssue&&syncedState.current.rooms.find(r=>r.id===clearingRoomId)?.messages.length===0){
   setClearingRoomId(null);notify('当前聊天记录已清空。');
  }else if(!syncBusy&&saveIssue){
   setClearingRoomId(null);notify('清空操作尚未保存，请按保存提示重试。');
  }
 },[clearingRoomId,saveStatus,syncBusy,saveIssue]);
 useEffect(()=>{if(!modal)return;const listener=(e:KeyboardEvent)=>{if(e.key==='Escape')setModal(null);};window.addEventListener('keydown',listener);return()=>window.removeEventListener('keydown',listener);},[modal]);
 useEffect(()=>()=>{generation.current++;controllers.current.forEach(c=>c.abort());controllers.current.clear();},[]);
 function setDraft(value:string){setDrafts(old=>({...old,[room.id]:value.slice(0,4000)}));}
 function switchRoom(id:string){setActiveId(id);setMobileList(false);setMentionOpen(false);}
 function openDm(agent:Agent){
  if(!ensureReady())return;
  const id=`dm-${agent.id}`;
  if(!state.rooms.some(r=>r.id===id)&&state.rooms.length>=32){notify('最多创建 32 个会话，当前已达到上限。');return;}
  if(!state.rooms.some(r=>r.id===id))setState(old=>({...old,rooms:[...old.rooms,{id,name:agent.name,members:[agent.id],messages:[]}]}));
  setTab('chats');switchRoom(id);
 }
 function openAgent(agent?:Agent){
  if(!agent&&state.agents.length>=32){notify('最多添加 32 位 AI 成员，当前已达到上限。');return;}
  setEditingAgent(agent?.id||null);setFormName(agent?.name||'');setFormProvider(agent?.provider||'openai');setFormModel(agent?.model??providers.find(p=>p.id==='openai')?.defaultModel??'');setFormRole(agent?.role||'');setFormError('');setModal('agent');
 }
 function savePersonality(){
  if(!ensureReady()||personalitySave)return;
  if(conflict.current){notify('请先解决保存冲突，再保存人格。');return;}
  const id=currentSettings.id;const role=personalityDraft.trim();
  if(role.length>4000){notify('人格说明最多 4000 字。');return;}
  setPersonalitySave({id,role});
  setState(previous=>({...previous,agents:previous.agents.map(agent=>agent.id===id?{...agent,role}:agent)}));
  if(saveTimer.current)clearTimeout(saveTimer.current);
  void flushSave();
 }
 function changeProvider(value:ProviderId){setFormProvider(value);setFormModel(providers.find(p=>p.id===value)?.defaultModel||PROVIDERS.find(p=>p.id===value)?.model||'');}
 function saveAgent(){
  if(!ensureReady())return;
  if(!editingAgent&&state.agents.length>=32){setFormError('最多添加 32 位 AI 成员。');return;}
  if(formModel.length>120||formRole.length>4000){setFormError('模型 ID 最多 120 字，人格说明最多 4000 字。');return;}
  const name=formName.trim();if(!name){setFormError('请填写成员名字。');return;}
  if(name.length>24||/[\s@，。！？、,!?;；:：()（）\[\]【】.]/.test(name)){setFormError('名字最多 24 字，请勿包含空格、@ 或点名分隔标点。');return;}
  if(name==='所有人'){setFormError('「所有人」是群聊保留称呼，请换个名字。');return;}
  if(state.agents.some(a=>a.name===name&&a.id!==editingAgent)){setFormError('这个名字已存在，换个名字方便点名吧。');return;}
  const old=state.agents.find(a=>a.id===editingAgent);
  const agent:Agent={id:editingAgent||uid(),name,provider:formProvider,model:formModel.trim(),role:formRole.trim(),color:old?.color||['#bc704b','#538a74','#697cac','#916a99'][state.agents.length%4],symbol:old?.symbol||name.slice(0,1).toUpperCase()};
  setState(prev=>({...prev,agents:editingAgent?prev.agents.map(a=>a.id===editingAgent?agent:a):[...prev.agents,agent],rooms:prev.rooms.map(r=>r.id===`dm-${editingAgent}`?{...r,name}:r)}));
  if(editingAgent)setPersonalityDrafts(previous=>({...previous,[editingAgent]:agent.role}));
  setModal(null);notify(editingAgent?'成员设置已更新':'新成员已加入联系人，可以私聊或添加到群里。');
 }
 function openGroup(edit=false){if(!edit&&state.rooms.length>=32){notify('最多创建 32 个会话，当前已达到上限。');return;}setFormName(edit?room.name:'');setFormMembers(edit?room.members:state.agents.map(a=>a.id));setFormError('');setModal(edit?'members':'group');}
 function saveGroup(){
  if(!ensureReady())return;
  if(modal!=='members'&&state.rooms.length>=32){setFormError('最多创建 32 个会话。');return;}
  if(formName.trim().length>50||formMembers.length>32){setFormError('群名最多 50 字，群成员最多 32 位。');return;}
  if(!formName.trim()||!formMembers.length){setFormError('给群起个名字，并至少选择一位成员。');return;}
  if(modal==='members'){setState(old=>({...old,rooms:old.rooms.map(r=>r.id===room.id?{...r,name:formName.trim(),members:formMembers}:r)}));}
  else{const id=uid();setState(old=>({...old,rooms:[...old.rooms,{id,name:formName.trim(),members:formMembers,messages:[]}]}));switchRoom(id);setTab('chats');}
  setModal(null);
 }
 function appendMessage(roomId:string,message:Message){setState(old=>({...old,rooms:old.rooms.map(r=>r.id===roomId?{...r,messages:[...r.messages,message]}:r)}));}
 function cancelReplies(){generation.current++;controllers.current.forEach(c=>c.abort());controllers.current.clear();setPending([]);}
 function stop(){cancelReplies();notify('已停止本轮回复，已完成的消息会保留。');}
 function openClearChat(){
  if(!ensureReady()||!room.messages.length||clearingRoomId)return;
  setClearTargetId(room.id);setMentionOpen(false);setModal('clear');
 }
 function clearChat(){
  if(!ensureReady()||!clearTargetId||clearingRoomId)return;
  if(conflict.current){notify('请先解决保存冲突，再清空聊天。');return;}
  const target=stateRef.current.rooms.find(r=>r.id===clearTargetId);
  if(!target?.messages.length){setModal(null);return;}
  if(pending.some(p=>p.roomId===target.id))cancelReplies();
  setClearingRoomId(target.id);
  setState(previous=>({...previous,rooms:previous.rooms.map(r=>r.id===target.id?{...r,messages:[]}:r)}));
  setModal(null);setMentionOpen(false);
  if(saveTimer.current)clearTimeout(saveTimer.current);
  void flushSave();
 }
 async function send(){
  const prompt=draft.trim();if(!prompt||pending.length||clearingRoomId||!hydrated)return;if(prompt.length>4000){notify('单条消息最多 4000 字，请分段发送。');return;}
  if(!members.length){notify('请先为群添加成员。');return;}
  const routing=privateChat?{targetIds:members.map(member=>member.id),unknownNames:[]}:resolveRecipients(prompt,members,routingHistory);
  if(routing.unknownNames?.length){notify(`没有找到：${routing.unknownNames.join('、')}。请从「点名成员」选择。`);return;}
  const targets=members.filter(member=>routing.targetIds.includes(member.id));
  if(room.messages.length+targets.length+1>2000){notify('当前会话已接近 2000 条消息上限，请导出并创建新会话继续。');return;}
  const missing=targets.filter(a=>!providerReady(a.provider));
  if(missing.length){notify(`${missing.map(a=>a.name).join('、')} 尚未连接。打开模型设置查看接入状态。`);setSettingsId(missing[0].id);setModal('settings');return;}
  const roomId=room.id;const run=++generation.current;
  const history=room.messages.filter(m=>!m.error&&m.mode==='live').slice(-24).map(m=>({speaker:m.speaker==='user'?'用户':state.agents.find(a=>a.id===m.speaker)?.name||m.speaker,content:m.content.slice(0,4000)}));
  appendMessage(roomId,{id:uid(),speaker:'user',content:prompt,time:new Date().toISOString(),mode:'live'});setDraft('');setMentionOpen(false);
  if(!targets.length){notify('大家先保持安静，点名成员或说「大家一起聊」即可继续。');return;}
  setPending(targets.map(a=>({id:a.id,name:a.name,roomId})));
  // Take turns so later members can respond to this round's earlier replies.
  const roundReplies:{speaker:string;content:string}[]=[];
  for(const agent of targets){
   if(generation.current!==run)break;
   const controller=new AbortController();controllers.current.set(agent.id,controller);
   try{
    const result=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agent,messages:history,roundReplies:roundReplies.slice(-32),replyAudience:targets.map(target=>target.name),prompt,expectedOwnerKey:ownerKey.current}),signal:controller.signal});
    const data=await result.json() as {content:string;error?:string;code?:string};if(result.status===403&&data.code==='identity_changed'){invalidateIdentity();return;}if(!result.ok)throw new Error(data.error||'请求失败，请检查模型设置。');
    const content=data.content;
    if(generation.current===run){
     appendMessage(roomId,{id:uid(),speaker:agent.id,content,time:new Date().toISOString(),mode:'live'});
     roundReplies.push({speaker:agent.name,content:content.slice(0,4000)});
    }
   }catch(error){if(generation.current===run&&!controller.signal.aborted)appendMessage(roomId,{id:uid(),speaker:agent.id,content:error instanceof Error?error.message:'请求失败，请稍后再试。',time:new Date().toISOString(),mode:'live',error:true});}
   finally{if(generation.current===run){controllers.current.delete(agent.id);setPending(old=>old.filter(p=>p.id!==agent.id));}}
  }
 }
 function exportChat(){
  const content=`# ${room.name}\n\n${room.messages.map(m=>`### ${m.speaker==='user'?'我':state.agents.find(a=>a.id===m.speaker)?.name||m.speaker} · ${timeLabel(m.time)}${m.mode==='demo'?' · 预设演示':''}${m.error?' · 请求错误':''}\n\n${m.content}`).join('\n\n---\n\n')}\n`;
  const url=URL.createObjectURL(new Blob([content],{type:'text/markdown;charset=utf-8'}));const anchor=document.createElement('a');anchor.href=url;anchor.download=`算力有限责任公司-${room.name.replace(/[\\/:*?"<>|]/g,'_')}.md`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('当前会话已导出为 Markdown。');
 }
 function insertMention(name:string){setDraft(`${draft}${draft&&!draft.endsWith(' ')?' ':''}@${name} `);setMentionOpen(false);inputRef.current?.focus();}
 async function copyMessage(content:string){try{await navigator.clipboard.writeText(content);notify('消息已复制。');}catch{notify('复制失败，请手动选择消息内容。');}}
 function renderMessage(message:Message){
  const isUser=message.speaker==='user';const agent=state.agents.find(a=>a.id===message.speaker);
  return <article className={`message-row ${isUser?'user-message':''} ${message.error?'error-message':''}`} key={message.id}>
   <div className="message-identity">{isUser?<div className="user-message-avatar">我</div>:<Avatar agent={agent} size={32}/>}</div>
   <div className="message-body">{<div className="message-meta"><strong>{isUser?'我':agent?.name||'AI 成员'}</strong><time>{timeLabel(message.time)}</time></div>}<div className="message-bubble"><p>{message.content}</p><div className="bubble-footer">{message.mode==='demo'&&<span className="demo-tag"><Sparkles size={10}/>预设演示</span>}{message.error&&<span className="error-tag">请求未完成</span>}</div>{<button className="message-copy" aria-label={`复制${isUser?'我的':agent?.name||'AI'}消息`} title="复制消息" onClick={()=>copyMessage(message.content)}><Copy size={12}/></button>}</div></div>
  </article>;
 }
 const visibleRooms=state.rooms.filter(r=>r.name.toLowerCase().includes(search.toLowerCase()));
 const visibleAgents=state.agents.filter(a=>a.name.toLowerCase().includes(search.toLowerCase())||a.role.includes(search));

 return <main className={`workspace ${mobileList?'mobile-list-visible':''}`}>
  <nav className="rail" aria-label="主导航">
   <button className="brand-mark" aria-label="算力有限责任公司，返回聊天" onClick={()=>{setTab('chats');setMobileList(true);}}><MessageSquare size={26} strokeWidth={2.6}/><span/></button>
   <div className="rail-main"><button className={`rail-button ${tab==='chats'?'active':''}`} aria-label="聊天" onClick={()=>{setTab('chats');setMobileList(true);}}><MessageCircle size={23}/><span>聊天</span></button><button className={`rail-button ${tab==='contacts'?'active':''}`} aria-label="联系人" onClick={()=>{setTab('contacts');setMobileList(true);}}><ContactRound size={23}/><span>联系人</span></button></div>
   <div className="rail-bottom"><IconButton label="使用说明" onClick={()=>setModal('help')}><CircleHelp size={21}/></IconButton><IconButton label="成员设置" onClick={()=>setModal('settings')}><Settings2 size={21}/></IconButton><div className="profile-avatar" title="本机工作空间">我<span/></div></div>
  </nav>
  <aside className="conversation-sidebar">
   <div className="sidebar-heading"><div><h1>算力有限责任公司<span className="brand-dot">.</span></h1></div><IconButton label="创建群聊" onClick={()=>openGroup()}><Plus size={21}/></IconButton></div>
   <label className="search-field"><Search size={16}/><input aria-label={tab==='chats'?'搜索会话':'搜索联系人'} placeholder={tab==='chats'?'搜索会话':'搜索联系人'} value={search} onChange={e=>setSearch(e.target.value)}/><span>⌕</span></label>
   <div className="list-heading"><span>{tab==='chats'?'消息':'AI 联系人'}</span><span>{tab==='chats'?state.rooms.length:state.agents.length}</span></div>
   <div className="conversation-list">
    {tab==='chats'?<>{visibleRooms.length===0&&<div className="list-empty">没有找到相关会话</div>}{visibleRooms.map(r=>{const agents=state.agents.filter(a=>r.members.includes(a.id));const last=r.messages[r.messages.length-1];return <button className={`conversation-item ${r.id===room.id?'selected':''}`} key={r.id} onClick={()=>switchRoom(r.id)}>{r.id.startsWith('dm-')?<Avatar agent={agents[0]} size={43}/>:<GroupAvatar agents={agents} size={43}/>}<span className="conversation-item-body"><span className="conversation-item-title"><strong>{r.name}</strong><time>{last?timeLabel(last.time):''}</time></span><span className="conversation-preview">{last?`${last.speaker==='user'?'我':state.agents.find(a=>a.id===last.speaker)?.name||'AI'}：${last.content}`:'开始聊聊你的新想法'}</span><span className="room-type">{r.id.startsWith('dm-')?'私聊':`${r.members.length} 位 AI 成员`}</span></span></button>;})}</>:<>{visibleAgents.length===0&&<div className="list-empty">没有找到相关成员</div>}{visibleAgents.map(a=><button className="contact-item" key={a.id} onClick={()=>openDm(a)}><Avatar agent={a} size={40}/><span><strong>{a.name}</strong></span><ChevronRight size={16}/></button>)}</>}
   </div>
   <div className="sidebar-bottom"><button className="invite-button" onClick={()=>openAgent()}><span><Plus size={17}/></span><div><strong>邀请一位 AI 成员</strong><small>让你的团队多一种可能</small></div><ChevronRight size={15}/></button><div className="workspace-label"><span className="status-dot"/>{saveStatus}<span>保存在这台 Mac</span></div></div>
  </aside>
  <section className="chat-panel" aria-label="当前聊天">
   <header className="chat-header"><IconButton className="mobile-back" label="返回会话列表" onClick={()=>setMobileList(true)}><ArrowLeft size={20}/></IconButton><div className="chat-title"><h2>{room.name}<span>{privateChat?'私聊':members.length}</span></h2>{privateChat&&<p><span className="tiny-dot"/>和你的 AI 伙伴单独聊聊</p>}</div><div className="chat-header-actions"><button type="button" className="clear-chat-trigger" disabled={!room.messages.length||!hydrated||!!clearingRoomId||!!saveIssue} onClick={openClearChat}><Trash2 size={16}/><span>{clearingRoomId===room.id?'清空中…':'清空聊天'}</span></button><IconButton label="导出当前会话" onClick={exportChat}><ArrowDownToLine size={19}/></IconButton><IconButton label={showMembers?'收起成员栏':'展开成员栏'} onClick={()=>setShowMembers(!showMembers)}>{showMembers?<PanelRightClose size={20}/>:<PanelRightOpen size={20}/>}</IconButton></div></header>
   {saveIssue&&<div className={`sync-banner ${saveIssue.kind==='conflict'?'sync-conflict':''}`} role="alert"><p>{saveIssue.message}</p><div><button onClick={exportAll}>导出全部 JSON</button>{saveIssue.kind==='validation'&&<button disabled={syncBusy} onClick={()=>void loadWorkspace()}>重试同步</button>}{saveIssue.kind==='conflict'||saveIssue.kind==='validation'?<button disabled={syncBusy} onClick={()=>void loadCloudVersion()}>备份当前页并载入已存记录</button>:<button disabled={syncBusy} onClick={()=>saveIssue.requiresRefresh?window.location.reload():void loadWorkspace()}>{syncBusy?'正在重试…':saveIssue.requiresRefresh?'刷新页面':saveIssue.kind==='identity'?'重新读取':'重试同步'}</button>}</div></div>}
   <div className="messages-scroll">
    {room.messages.length===0&&<div className="empty-chat"><span className="empty-icon">{privateChat?<Avatar agent={members[0]} size={56}/>:<UsersRound size={29}/>}</span><h3>{privateChat?`你好，我是 ${members[0]?.name||'你的 AI 伙伴'}`:'同事到齐，听老板说两句。'}</h3><p>{privateChat?'一起讨论问题，交流想法。':'聊一个想法，提一个问题，或把难题交给大家一起想。'}</p><button onClick={()=>{setDraft('帮我把一个新想法拆成可执行的小计划。');inputRef.current?.focus();}}>帮我理一理新想法 <ArrowUp size={14}/></button></div>}
    {room.messages.map(message=>renderMessage(message))}
    {activePending.length>0&&<div className="typing-indicator"><span className="typing-dots"><i/><i/><i/></span><span>{activePending[0].name} 正在思考…{activePending.length>1?` · 还有 ${activePending.length-1} 位等待发言`:''}</span></div>}
    <div ref={bottomRef}/>
   </div>
   <div className="composer-wrapper"><div className="composer"><div className="composer-tools"><div className="mention-container"><button className={`mention-button ${mentionOpen?'active':''}`} aria-label="点名成员" title={audienceNames.length?`本轮回复：${audienceNames.join('、')}；点击更换`:'本轮无人回复；点击点名成员'} onClick={()=>setMentionOpen(!mentionOpen)}><AtSign size={16}/><span>{audienceLabel}</span><ChevronDown size={12}/></button>{mentionOpen&&<div className="mention-menu">{!privateChat&&<button onClick={()=>insertMention('所有人')}><span className="all-avatar"><UsersRound size={16}/></span>所有人<small>全体回复</small></button>}{members.map(a=><button key={a.id} onClick={()=>insertMention(a.name)}><Avatar agent={a} size={25}/>{a.name}</button>)}</div>}</div></div><textarea maxLength={4000} ref={inputRef} aria-label="消息输入框" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}}/><div className="composer-footer"><div style={{marginLeft:'auto'}}><small>Enter 发送 · Shift + Enter 换行</small>{pending.length>0?<button className="send-button stop-button" onClick={stop}><Square size={12} fill="currentColor"/>停止</button>:<button className="send-button" aria-label="发送消息" disabled={!draft.trim()||!hydrated||!!clearingRoomId} onClick={()=>void send()}>发送<ArrowUp size={15}/></button>}</div></div></div></div>
  </section>
  {showMembers&&<aside className="members-panel"><div className="members-heading"><h3>{privateChat?'成员资料':'群聊成员'}<span>{members.length}</span></h3><IconButton label="关闭成员栏" onClick={()=>setShowMembers(false)}><X size={16}/></IconButton></div><div className="members-intro"><GroupAvatar agents={members} size={62}/><h3>{room.name}</h3>{privateChat&&<p>一个专注思考的角落</p>}</div><div className="member-list-label"><span>{privateChat?'AI 伙伴':'我的小队'}</span>{!privateChat&&<button onClick={()=>openGroup(true)}>管理<Settings2 size={12}/></button>}</div><div className="member-list">{members.map(a=><button className="member-row" key={a.id} onClick={()=>{setSettingsId(a.id);setModal('settings');}}><Avatar agent={a} size={35}/><span><strong>{a.name}</strong></span><span className={`connection-dot ${providerReady(a.provider)?'ready':''}`} title={providerReady(a.provider)?(a.provider==='openai'?'ChatGPT 会员已连接':'API 已配置'):'尚未连接'}/></button>)}</div>{!privateChat&&<button className="add-member" onClick={()=>openGroup(true)}><Plus size={15}/>添加 / 管理群成员</button>}</aside>}
  {toast&&<div className="toast" role="status"><span>{toast}</span><button aria-label="关闭提醒" onClick={()=>setToast('')}><X size={15}/></button></div>}
  {modal&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null);}}><section className={`modal ${modal==='settings'?'settings-modal':''}`} role="dialog" aria-modal="true" aria-label={{agent:editingAgent?'编辑 AI 成员':'邀请 AI 成员',group:'创建群聊',members:'管理群成员',settings:'成员设置',help:'使用说明',clear:'清空聊天记录'}[modal]}><div className="modal-header"><div><h2>{{agent:editingAgent?'编辑 AI 成员':'邀请 AI 成员',group:'组个新小队',members:'管理群成员',settings:'成员设置',help:'欢迎来到算力有限责任公司',clear:'清空聊天记录？'}[modal]}</h2><p>{{agent:'给这位同事起个名字，写写 TA 的脾气和说话方式。',group:'选好伙伴，就可以开始一起想。',members:'让合适的伙伴，参与合适的话题。',settings:'都是平级同事，各有各的脾气。',help:'一个问题，多种视角，由你来掌舵。',clear:`将清空「${clearTarget?.name||''}」中的全部聊天记录。`}[modal]}</p></div><IconButton label="关闭窗口" onClick={()=>setModal(null)}><X size={20}/></IconButton></div>
   {modal==='clear'&&<div className="clear-chat-confirm"><p>成员和人格设置会保留。清空后无法撤销，需要保留的内容请先导出。</p>{pending.some(p=>p.roomId===clearTargetId)&&<p>当前会话正在进行的回复也会停止。</p>}<div className="modal-actions"><button type="button" className="secondary-button" autoFocus onClick={()=>setModal(null)}>取消</button><button type="button" className="primary-button clear-chat-confirm-button" disabled={!clearTarget?.messages.length||!!clearingRoomId||!hydrated||!!saveIssue} onClick={clearChat}>确认清空<Trash2 size={14}/></button></div></div>}
   {modal==='agent'&&<form onSubmit={e=>{e.preventDefault();saveAgent();}} className="modal-form"><label>成员名字<input autoFocus maxLength={24} value={formName} onChange={e=>setFormName(e.target.value)} placeholder="例如：小伙伴"/></label><div className="form-columns"><label>服务商<select value={formProvider} onChange={e=>changeProvider(e.target.value as ProviderId)}>{PROVIDERS.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></label><label>{formProvider==='openai'?'会员模型':'模型 ID（可选）'}{formProvider==='openai'?<select value={formModel} onChange={e=>setFormModel(e.target.value)}><option value="">使用会员默认模型</option>{formModel&&!memberStatus.models?.some(m=>m.slug===formModel)&&<option value={formModel}>{formModel}</option>}{memberStatus.models?.map(m=><option key={m.slug} value={m.slug}>{m.display_name||m.slug}</option>)}</select>:<input maxLength={120} value={formModel} onChange={e=>setFormModel(e.target.value)} placeholder="使用本机后台默认模型"/>}</label></div><PersonalityField value={formRole} onChange={setFormRole}/><p className="form-hint">人格影响说话方式和看问题的习惯，大家仍是平级同事。</p>{formError&&<p className="form-error">{formError}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={()=>setModal(null)}>取消</button><button className="primary-button" type="submit">{editingAgent?'保存设置':'添加成员'}<Plus size={15}/></button></div></form>}
   {(modal==='group'||modal==='members')&&<form className="modal-form" onSubmit={e=>{e.preventDefault();saveGroup();}}><label>群聊名称<input autoFocus value={formName} maxLength={50} onChange={e=>setFormName(e.target.value)} placeholder="例如：我的创作工作室"/></label><div className="select-members-heading"><span>选择 AI 成员</span><button type="button" onClick={()=>setFormMembers(formMembers.length===state.agents.length?[]:state.agents.map(a=>a.id))}>{formMembers.length===state.agents.length?'取消全选':'全选'}</button></div><div className="select-members">{state.agents.map(a=><button key={a.id} type="button" className={formMembers.includes(a.id)?'checked':''} onClick={()=>setFormMembers(old=>old.includes(a.id)?old.filter(id=>id!==a.id):[...old,a.id])}><Avatar agent={a} size={35}/><span><strong>{a.name}</strong></span><span className="checkbox">{formMembers.includes(a.id)&&<Check size={13}/>}</span></button>)}</div>{formError&&<p className="form-error">{formError}</p>}<div className="modal-actions"><span>已选择 {formMembers.length} 位成员</span><button type="submit" className="primary-button">{modal==='members'?'保存成员':'创建群聊'}<ArrowUp size={15}/></button></div></form>}
   {modal==='settings'&&<div className="settings-content"><div className="settings-agents">{state.agents.map(a=><button key={a.id} className={currentSettings.id===a.id?'selected':''} onClick={()=>setSettingsId(a.id)}><Avatar agent={a} size={27}/>{a.name}</button>)}<button onClick={()=>openAgent()}><Plus size={15}/>添加</button></div><div className="settings-detail"><div className="settings-agent-head"><Avatar agent={currentSettings} size={49}/><div><h3>{currentSettings.name}</h3><span className={`provider-status ${providerReady(currentSettings.provider)?'configured':''}`}><span/>{currentSettings.provider==='openai'?(memberStatus.connected&&memberStatus.planUsageEnabled===true?'ChatGPT 会员已连接':memberStatus.connected?'会员用量尚未启用':'ChatGPT 会员未连接'):(providerReady(currentSettings.provider)?'API 已配置 · 调用时验证':'API 尚未配置')}</span></div><button className="secondary-button" onClick={()=>openAgent(currentSettings)}>编辑成员</button></div><form className="personality-editor" onSubmit={e=>{e.preventDefault();savePersonality();}}><PersonalityField value={personalityDraft} onChange={value=>setPersonalityDrafts(previous=>({...previous,[currentSettings.id]:value}))}/><div className="personality-save-row"><span>{personalitySave?.id===currentSettings.id?'正在保存…':personalityDirty?'有未保存的修改':'已保存的人格会用于后续聊天'}</span><button className="primary-button" type="submit" disabled={!personalityDirty||!!personalitySave||!hydrated||saveIssue?.kind==='conflict'||saveIssue?.kind==='identity'}>{personalitySave?.id===currentSettings.id?'保存中…':'保存人格'}<Check size={14}/></button></div>{saveIssue&&<p className="form-error" role="alert">{saveIssue.message}</p>}</form><dl><div><dt>服务商</dt><dd>{PROVIDERS.find(p=>p.id===currentSettings.provider)?.label}</dd></div><div><dt>{currentSettings.provider==='openai'?'会员模型':'模型 ID'}</dt><dd>{currentSettings.model||(currentSettings.provider==='openai'?(memberStatus.model||'连接后使用会员默认模型'):'使用本机后台默认模型')}</dd></div></dl>{currentSettings.provider==='openai'?<div className="member-connection-card"><div className="member-card-title"><span className="member-logo">✳</span><div><strong>使用 ChatGPT 会员</strong><p>{memberLoading?'正在读取连接状态':memberStatus.connected&&memberStatus.planUsageEnabled===true?'已连接 · 使用会员额度':memberStatus.pending?'等待你在授权页完成连接':memberStatus.connected?'已连接，会员用量尚未启用':'连接你已有的 ChatGPT 账号'}</p></div></div><p className="member-explanation">GPT 的回复使用已登录账号的会员用量，受套餐限额约束。这个本机版本需要这台 Mac 保持运行。</p><div className="member-card-actions"><a className="primary-button" href="/auth/chatgpt/start" target="_blank" rel="noopener">{memberStatus.connected?'重新连接会员':'连接 ChatGPT 会员'}<ExternalLink size={13}/></a><button className="secondary-button" onClick={()=>void refreshConnections()}><RefreshCw size={12}/>刷新状态</button></div>{(memberStatus.error||connectionError)&&<p className="member-status-error" role="alert">{memberStatus.error||connectionError}</p>}<small>在新打开的官方页面完成授权，并允许使用会员用量，然后回到这里。若未启用会员用量，请在官方设置中开启后重新连接。账号凭据不会写进网页或聊天记录。</small></div>:<div className="configuration-note"><Settings2 size={17}/><div><strong>{providerReady(currentSettings.provider)?'密钥已配置':'接入真实 AI'}</strong><p>{providerReady(currentSettings.provider)?'连接信息由本机后台保管，实际可用性会在发送时验证。':'在下方粘贴你自己的 API 密钥并保存。'} 模型 ID 使用账号实际可用的名称。</p><p>这一成员按对应平台的 API 额度和价格计量，不使用 ChatGPT 会员额度。</p><ApiKeySettings key={`${currentSettings.id}:${currentSettings.provider}`} provider={currentSettings.provider} ready={providerReady(currentSettings.provider)} expectedOwnerKey={ownerKey.current} onSaved={refreshConnections}/><button className="connection-refresh" onClick={()=>void refreshConnections()}><RefreshCw size={12}/>刷新状态</button>{connectionError&&<p role="alert">{connectionError}</p>}</div></div>}<button className="settings-dm-button" onClick={()=>{setModal(null);openDm(currentSettings);}}><MessageCircle size={16}/>和 {currentSettings.name} 单独聊聊<ChevronRight size={15}/></button></div></div>}
   {modal==='help'&&<div className="help-content"><div><span>01</span><section><h3>先把一个想法放进群里</h3><p>没有指定对象时，默认邀请全员。点名后会记住你在跟谁聊，后续追问由这些成员接着回答。</p></section></div><div><span>02</span><section><h3>自然点名，接着聊</h3><p>说「就 GPT 留下」「豆包，你怎么看」或输入 @名字，即可指定回复对象。说「大家一起聊」或 @所有人 恢复全员；输入框上方会显示当前回复对象。</p></section></div><div><span>03</span><section><h3>连接成员，开始讨论</h3><p>GPT 使用 ChatGPT 会员，其他成员使用已配置的 API。发送后直接调用对应模型；连接失败会显示错误。</p></section></div><div className="help-note">会话自动保存在这台 Mac，也可导出 Markdown。使用时需保持本机服务运行；对话会发送给参与讨论的模型服务。云端网页与本机版各自保存记录。被点名的成员按顺序轮流发言，后发言的成员能看到前面的回答；每轮各回复一次，不会自行无限互聊。</div><button className="primary-button" onClick={()=>setModal(null)}>开始聊聊<ArrowUp size={15}/></button></div>}
  </section></div>}
 </main>;
}
