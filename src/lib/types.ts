export type ProviderId = 'openai' | 'gemini' | 'deepseek' | 'moonshot' | 'doubao' | 'xai' | 'zhipu';
export interface Agent { id:string; name:string; provider:ProviderId; model:string; role:string; color:string; symbol:string; }
export interface Message { id:string; speaker:string; content:string; time:string; mode:'demo'|'live'; error?:boolean; }
export interface Room { id:string; name:string; members:string[]; messages:Message[]; }
export interface ChatState { agents:Agent[]; rooms:Room[]; }
export interface ProviderStatus { id:ProviderId; label:string; ready:boolean; defaultModel:string; }
