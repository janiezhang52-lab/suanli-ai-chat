import { z } from "zod";

const id = z.string().min(1).max(100);
export const providerIdSchema = z.enum(["openai", "gemini", "deepseek", "moonshot", "doubao", "xai", "zhipu"]);
export const agentSchema = z.object({
  id,
  name: z.string().trim().min(1).max(60),
  provider: providerIdSchema,
  model: z.string().trim().max(120),
  role: z.string().max(4000),
  color: z.string().max(40),
  symbol: z.string().max(20),
}).strict();

const messageSchema = z.object({
  id,
  speaker: z.string().min(1).max(100),
  content: z.string().max(20000),
  time: z.string().max(64),
  mode: z.enum(["demo", "live"]),
  error: z.boolean().optional(),
}).strict();

export const stateSchema = z.object({
  agents: z.array(agentSchema).max(32),
  rooms: z.array(z.object({
    id,
    name: z.string().trim().min(1).max(80),
    members: z.array(id).max(32),
    messages: z.array(messageSchema).max(2000),
  }).strict()).max(32),
}).strict().superRefine((state, ctx) => {
  const agents = new Set(state.agents.map((agent) => agent.id));
  const unique = (values) => new Set(values).size === values.length;
  if (agents.size !== state.agents.length || !unique(state.rooms.map((room) => room.id))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "成员或群聊 ID 重复" });
  }
  for (const room of state.rooms) {
    if (!unique(room.members) || room.members.some((member) => !agents.has(member))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "群聊成员不存在或重复" });
    }
    if (!unique(room.messages.map((message) => message.id))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "消息 ID 重复" });
    }
  }
});

export const stateWriteSchema = z.object({
  expectedOwnerKey: z.string().min(1).max(256),
  state: stateSchema,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
}).strict();

export const chatRequestSchema = z.object({
  expectedOwnerKey: z.string().min(1).max(256),
  agent: agentSchema,
  // The body has a separate byte cap; only recent messages go to the provider.
  messages: z.array(z.object({
    speaker: z.string().min(1).max(100),
    content: z.string().max(4000),
  }).strict()).max(24),
  // Kept separate from history so each member can see who has spoken this turn.
  roundReplies: z.array(z.object({
    speaker: z.string().min(1).max(100),
    content: z.string().max(4000),
  }).strict()).max(32).optional(),
  replyAudience: z.array(z.string().min(1).max(60)).min(1).max(32).optional(),
  prompt: z.string().trim().min(1).max(4000),
}).strict();
