import { query } from '@anthropic-ai/claude-agent-sdk';
import { config, childEnv } from './config.js';
import { errorMessage } from './util.js';

/**
 * Mirrors Claude Code's `/btw`: a one-off answer based on the conversation
 * context, with no tools and no effect on the main session or its transcript.
 */
const SIDE_QUESTION_PROMPT = `<system-reminder>
This is a side question from the user, asked while the main task may still be running.
- This is a one-off response; there will be no follow-up turns.
- Use ONLY information already present in the conversation context.
- You cannot use tools. Never claim to run commands, read files, or take any action.
- If the answer is not in the context, say so plainly; do not offer to investigate.
- Answer the question directly and keep it focused.
</system-reminder>`;

const SIDE_QUESTION_TIMEOUT_MS = 5 * 60_000;

export interface SideQuestionOptions {
  cwd: string;
  claudeSessionId?: string;
  model?: string;
}

export interface SideQuestionResult {
  answer: string;
  costUsd?: number;
  durationMs?: number;
  model?: string;
}

export interface SideQuestionCallbacks {
  onDelta: (kind: 'text' | 'thinking', text: string) => void;
  onDone: (result: SideQuestionResult) => void;
  onError: (message: string) => void;
}

export interface SideQuestionHandle {
  cancel: () => void;
}

interface RawMessage {
  type?: string;
  subtype?: string;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string; thinking?: string };
  };
  message?: { content?: unknown };
  result?: unknown;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
}

function textFromBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        !!block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

export function startSideQuestion(
  options: SideQuestionOptions,
  question: string,
  callbacks: SideQuestionCallbacks,
): SideQuestionHandle {
  const abortController = new AbortController();
  let settled = false;
  let timedOut = false;
  let answer = '';
  let streamed = false;

  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, SIDE_QUESTION_TIMEOUT_MS);
  timer.unref?.();

  const settle = (finish: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    finish();
  };

  const q = query({
    prompt: question,
    options: {
      cwd: options.cwd,
      ...(options.claudeSessionId
        ? { resume: options.claudeSessionId, forkSession: true }
        : {}),
      // The fork is a read-only side channel: no transcript, no tool calls.
      persistSession: false,
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: SIDE_QUESTION_PROMPT,
      },
      tools: [],
      canUseTool: async () => ({
        behavior: 'deny',
        message: 'Side questions cannot use tools',
        decisionReason: { type: 'other', reason: 'side_question' },
      }),
      permissionMode: 'default',
      maxTurns: 1,
      abortController,
      env: childEnv(),
      ...(options.model ? { model: options.model } : {}),
      ...(config.claudeBin ? { pathToClaudeCodeExecutable: config.claudeBin } : {}),
    },
  });

  void (async () => {
    try {
      for await (const message of q) {
        const raw = message as unknown as RawMessage;
        if (raw.type === 'stream_event') {
          const delta = raw.event?.delta;
          if (raw.event?.type === 'content_block_delta' && delta) {
            if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
              answer += delta.text;
              streamed = true;
              callbacks.onDelta('text', delta.text);
            } else if (
              delta.type === 'thinking_delta' &&
              typeof delta.thinking === 'string' &&
              delta.thinking
            ) {
              callbacks.onDelta('thinking', delta.thinking);
            }
          }
          continue;
        }

        if (raw.type === 'assistant') {
          // Older CLIs may omit partial deltas; fall back to the full message.
          if (!streamed) {
            const text = textFromBlocks(raw.message?.content);
            if (text) {
              answer = text;
              streamed = true;
              callbacks.onDelta('text', text);
            }
          }
          continue;
        }

        if (raw.type === 'result') {
          if (raw.is_error) {
            const detail =
              typeof raw.result === 'string' && raw.result.trim()
                ? raw.result
                : '旁问失败，请稍后重试';
            settle(() => callbacks.onError(detail));
            return;
          }
          const finalAnswer =
            answer || (typeof raw.result === 'string' ? raw.result : '');
          settle(() =>
            callbacks.onDone({
              answer: finalAnswer,
              costUsd:
                typeof raw.total_cost_usd === 'number' ? raw.total_cost_usd : undefined,
              durationMs:
                typeof raw.duration_ms === 'number' ? raw.duration_ms : undefined,
              model: options.model,
            }),
          );
          return;
        }
      }
      settle(() => callbacks.onDone({ answer, model: options.model }));
    } catch (error) {
      if (timedOut) {
        settle(() => callbacks.onError('旁问超时，请稍后重试'));
      } else if (abortController.signal.aborted) {
        settle(() => callbacks.onError('旁问已取消'));
      } else {
        settle(() => callbacks.onError(errorMessage(error)));
      }
    }
  })();

  return {
    cancel: () => {
      if (settled) return;
      abortController.abort();
    },
  };
}
