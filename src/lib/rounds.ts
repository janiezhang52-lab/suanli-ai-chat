import type { Message } from './types';

export interface ChatRound {
 id: string;
 messages: Message[];
}

// Preserve the original record: every user message begins a round, and every
// following message belongs to it until the next user message arrives.
export function chatRounds(messages: Message[]): ChatRound[] {
 const rounds: ChatRound[] = [];
 let current: ChatRound | undefined;
 for (const message of messages) {
  if (message.speaker === 'user') {
   current = { id: message.id, messages: [message] };
   rounds.push(current);
  } else if (current) {
   current.messages.push(message);
  }
 }
 return rounds;
}
