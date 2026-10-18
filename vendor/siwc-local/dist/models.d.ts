import type { ChatGPTModel } from "./types.js";
export declare function listModels(accessToken: string, signal: AbortSignal): Promise<ChatGPTModel[]>;
