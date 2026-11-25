import crypto from 'node:crypto';
import type { ContentBlock, ToolImageRef, UiEventInput } from './types.js';
import { parseJsonObject, truncate } from './util.js';

type Raw = Record<string, unknown>;

function asMessage(entry: Raw): { role?: string; id?: string; model?: string; content?: unknown; usage?: unknown } | undefined {
  const message = entry.message;
  return message && typeof message === 'object' ? (message as never) : undefined;
}

function normalizeBlock(value: unknown): ContentBlock | null {
  if (!value || typeof value !== 'object') return null;
  const block = value as Record<string, unknown>;
  const type = typeof block.type === 'string' ? block.type : '';
  if (!type) return null;
  if (type === 'text') {
    return { type, text: typeof block.text === 'string' ? block.text : '' };
  }
  if (type === 'thinking') {
    return {
      type,
      thinking: typeof block.thinking === 'string' ? block.thinking : '',
      signature: typeof block.signature === 'string' ? block.signature : undefined,
    };
  }
  if (type === 'tool_use') {
    return {
      type,
      id: typeof block.id === 'string' ? block.id : undefined,
      name: typeof block.name === 'string' ? block.name : undefined,
      input: parseJsonObject(block.input),
    };
  }
  if (type === 'redacted_thinking') {
    return { type, data: block.data };
  }
  return { type };
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (content === undefined || content === null) return '';
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[图片]');
    else parts.push(`[${String(block.type ?? 'content')}]`);
  }
  return parts.join('\n');
}

export function cleanUserText(text: string): string {
  const stripped = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .trim();
  if (!stripped) return '';
  if (stripped.startsWith('<command-name>') || stripped.startsWith('<local-command-')) return '';
  return stripped;
}

export function convertClaudeTranscript(
  lines: Raw[],
  saveImages?: (content: unknown) => ToolImageRef[],
): UiEventInput[] {
  const events: UiEventInput[] = [];
  const seen = new Set<string>();
  const assistantIndex = new Map<string, number>();
  const assistantBlocks = new Set<string>();

  const push = (key: string, event: UiEventInput): void => {
    if (seen.has(key)) return;
    seen.add(key);
    events.push(event);
  };

  const blockKey = (block: ContentBlock): string => {
    if (block.type === 'tool_use') return `tool:${block.id ?? ''}`;
    if (block.type === 'text') {
      return `text:${crypto.createHash('sha1').update(block.text ?? '').digest('hex')}`;
    }
    if (block.type === 'thinking') {
      return `thinking:${crypto.createHash('sha1').update(block.thinking ?? '').digest('hex')}`;
    }
    return block.type;
  };

  for (const entry of lines) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.isSidechain === true) continue;
    const type = entry.type;
    const message = asMessage(entry);
    if (!message) continue;

    if (type === 'user') {
      if (entry.isMeta === true) continue;
      const content = message.content;
      const uuid = typeof entry.uuid === 'string' ? entry.uuid : crypto.randomUUID();
      if (typeof content === 'string') {
        const text = cleanUserText(content);
        if (text) push(`u:${uuid}`, { type: 'user.message', id: uuid, text });
        continue;
      }
      if (!Array.isArray(content)) continue;
      const texts: string[] = [];
      for (const raw of content) {
        if (!raw || typeof raw !== 'object') continue;
        const block = raw as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string') {
          const text = cleanUserText(block.text);
          if (text) texts.push(text);
        } else if (block.type === 'tool_result') {
          const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          if (!toolUseId) continue;
          let images: ToolImageRef[] = [];
          if (saveImages) {
            try {
              images = saveImages(block.content);
            } catch {
              // A preview is best-effort; imported text still renders.
            }
          }
          push(`tr:${toolUseId}`, {
            type: 'tool.result',
            toolUseId,
            content: toolResultText(block.content),
            isError: block.is_error === true,
            structured: entry.toolUseResult,
            ...(images.length > 0 ? { images } : {}),
          });
        }
      }
      if (texts.length > 0) {
        push(`u:${uuid}`, { type: 'user.message', id: uuid, text: texts.join('\n\n') });
      }
      continue;
    }

    if (type === 'assistant') {
      const messageId =
        typeof message.id === 'string'
          ? message.id
          : typeof entry.uuid === 'string'
            ? entry.uuid
            : crypto.randomUUID();
      const content = message.content;
      const blocks: ContentBlock[] = [];
      if (Array.isArray(content)) {
        for (const raw of content) {
          const block = normalizeBlock(raw);
          if (block) blocks.push(block);
        }
      } else if (typeof content === 'string' && content) {
        blocks.push({ type: 'text', text: content });
      }
      if (blocks.length === 0) continue;
      const fresh = blocks.filter(
        (block) => !assistantBlocks.has(`${messageId}:${blockKey(block)}`),
      );
      if (fresh.length === 0) continue;
      for (const block of fresh) assistantBlocks.add(`${messageId}:${blockKey(block)}`);

      const existingIndex = assistantIndex.get(messageId);
      if (existingIndex !== undefined) {
        const existing = events[existingIndex] as Extract<
          UiEventInput,
          { type: 'assistant.message' }
        >;
        const merged = [...existing.blocks];
        for (const block of fresh) {
          if (
            block.type === 'tool_use' &&
            block.id &&
            merged.some((item) => item.type === 'tool_use' && item.id === block.id)
          ) {
            continue;
          }
          merged.push(block);
        }
        existing.blocks = merged;
        existing.final = true;
        if (!existing.model && typeof message.model === 'string') existing.model = message.model;
      } else {
        assistantIndex.set(messageId, events.length);
        events.push({
          type: 'assistant.message',
          messageId,
          blocks: fresh,
          model: typeof message.model === 'string' ? message.model : undefined,
          usage: message.usage,
          final: true,
        });
      }
    }
  }

  // Keep the imported scrollback readable: drop pure tool plumbing noise.
  return events.filter((event) => {
    if (event.type === 'assistant.message') {
      return event.blocks.some((block) => block.type !== 'thinking' || (block.thinking ?? '').trim());
    }
    return true;
  });
}

export function summarizeForTitle(events: UiEventInput[]): string | undefined {
  for (const event of events) {
    if (event.type === 'user.message' && event.text.trim()) return truncate(event.text, 80);
  }
  return undefined;
}
