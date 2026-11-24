import type { AttachmentRef, ContentBlock, UiEvent } from './types';

export interface ToolResultInfo {
  content: string;
  isError?: boolean;
}

export interface AssistantItem {
  kind: 'assistant';
  key: string;
  messageId: string;
  parentToolUseId?: string | null;
  blocks: ContentBlock[];
  streamingText: string;
  streamingThinking: string;
  final: boolean;
  ts: number;
  model?: string;
  toolResults: Map<string, ToolResultInfo>;
}

export interface UserItem {
  kind: 'user';
  key: string;
  id: string;
  text: string;
  attachments?: AttachmentRef[];
  ts: number;
}

export interface NoticeItem {
  kind: 'notice';
  key: string;
  level: 'info' | 'warn' | 'error';
  text: string;
  ts: number;
}

export interface TurnItem {
  kind: 'turn';
  key: string;
  ts: number;
  isError?: boolean;
  durationMs?: number;
  costUsd?: number;
  text?: string;
}

export type ChatItem = AssistantItem | UserItem | NoticeItem | TurnItem;

function mergeBlocks(target: ContentBlock[], incoming: ContentBlock[]): void {
  for (const block of incoming) {
    if (block.type === 'tool_use' && block.id) {
      const existing = target.find((item) => item.type === 'tool_use' && item.id === block.id);
      if (existing) Object.assign(existing, block);
      else target.push(block);
      continue;
    }
    if (block.type === 'text' && !block.text) continue;
    if (block.type === 'thinking' && !block.thinking) continue;
    target.push(block);
  }
}

export function buildChatItems(events: UiEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const assistantByKey = new Map<string, AssistantItem>();
  const toolResults = new Map<string, ToolResultInfo>();
  const seen = new Set<string>();
  let settledAt = 0;

  for (const event of events) {
    if (event.type === 'tool.result') {
      toolResults.set(event.toolUseId, {
        content: event.content,
        isError: event.isError,
      });
    }
    if (event.type === 'turn.result') {
      settledAt = Math.max(settledAt, event.ts);
    }
    if (
      event.type === 'session.status' &&
      (event.status === 'idle' || event.status === 'stopped' || event.status === 'error')
    ) {
      settledAt = Math.max(settledAt, event.ts);
    }
  }

  for (const event of events) {
    if (event.type === 'user.message') {
      const key = `u:${event.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        kind: 'user',
        key,
        id: event.id,
        text: event.text,
        attachments: event.attachments,
        ts: event.ts,
      });
      continue;
    }

    if (event.type === 'assistant.message') {
      if (event.parentToolUseId) continue;
      const key = `a:${event.messageId}`;
      let item = assistantByKey.get(key);
      if (!item) {
        item = {
          kind: 'assistant',
          key,
          messageId: event.messageId,
          parentToolUseId: event.parentToolUseId,
          blocks: [],
          streamingText: '',
          streamingThinking: '',
          final: false,
          ts: event.ts,
          model: event.model,
          toolResults,
        };
        assistantByKey.set(key, item);
        items.push(item);
      }
      item.ts = event.ts;
      if (event.model) item.model = event.model;
      if (event.final) {
        item.blocks = [...event.blocks];
        item.final = true;
      } else {
        mergeBlocks(item.blocks, event.blocks);
      }
      continue;
    }

    if (event.type === 'assistant.delta') {
      const key = `a:${event.messageId}`;
      let item = assistantByKey.get(key);
      if (!item) {
        item = {
          kind: 'assistant',
          key,
          messageId: event.messageId,
          blocks: [],
          streamingText: '',
          streamingThinking: '',
          final: false,
          ts: event.ts,
          toolResults,
        };
        assistantByKey.set(key, item);
        items.push(item);
      }
      if (event.kind === 'text') item.streamingText += event.text;
      else item.streamingThinking += event.text;
      continue;
    }

    if (event.type === 'notice') {
      items.push({
        kind: 'notice',
        key: `n:${event.seq}`,
        level: event.level,
        text: event.text,
        ts: event.ts,
      });
      continue;
    }

    if (event.type === 'turn.result') {
      items.push({
        kind: 'turn',
        key: `t:${event.seq}`,
        ts: event.ts,
        isError: event.isError,
        durationMs: event.durationMs,
        costUsd: event.costUsd,
        text: event.text,
      });
    }
  }

  for (const item of assistantByKey.values()) {
    item.toolResults = toolResults;
    if (!item.final && settledAt > item.ts) item.final = true;
  }

  return items.filter((item) => {
    if (item.kind !== 'assistant') return true;
    const hasText = item.streamingText.trim() || item.blocks.some((block) => (block.text ?? '').trim());
    const hasThinking =
      item.streamingThinking.trim() ||
      item.blocks.some((block) => (block.thinking ?? '').trim());
    const hasTools = item.blocks.some((block) => block.type === 'tool_use');
    return !!(hasText || hasThinking || hasTools);
  });
}
