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
  errors?: unknown;
  total_cost_usd?: number;
  model_usage_since_last_result?: Record<string, { costUSD?: number }>;
  duration_ms?: number;
}

function costFromResult(raw: RawMessage): number | undefined {
  // `total_cost_usd` on a resumed/forked session is cumulative for the whole
  // session, which can be thousands of dollars for a long-running main turn.
  // The per-turn usage map is the cost of this side question only.
  const perTurn = raw.model_usage_since_last_result;
  if (perTurn && typeof perTurn === 'object') {
    let sum = 0;
    let found = false;
    for (const usage of Object.values(perTurn)) {
      if (typeof usage?.costUSD === 'number' && Number.isFinite(usage.costUSD)) {
        sum += usage.costUSD;
        found = true;
      }
    }
    if (found) return sum;
  }
  return typeof raw.total_cost_usd === 'number' ? raw.total_cost_usd : undefined;
}

function friendlySideError(detail: string): string {
  if (/maximum number of turns/i.test(detail)) {
    return '旁问被主任务的工具调用打断，请稍后重试。';
  }
  if (/prompt is too long|context length|context window|too many tokens|maximum context/i.test(detail)) {
    return '旁问上下文过长，请稍后重试或新建会话再问。';
  }
  return detail;
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
      // A resumed conversation can contain an unfinished tool call. The model
      // may try one more tool even though `tools: []`; allow a second turn so
      // it can answer after the denied call instead of ending with
      // error_max_turns and an empty result.
      maxTurns: 2,
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
          const resultText = typeof raw.result === 'string' ? raw.result.trim() : '';
          if (raw.is_error) {
            // A resumed session may have ended on a tool attempt after the
            // model already produced useful text. Keep that text rather than
            // turning a partial answer into a total failure.
            if (answer.trim()) {
              settle(() =>
                callbacks.onDone({
                  answer,
                  costUsd: costFromResult(raw),
                  durationMs:
                    typeof raw.duration_ms === 'number' ? raw.duration_ms : undefined,
                  model: options.model,
                }),
              );
              return;
            }
            const errors = Array.isArray(raw.errors)
              ? raw.errors.filter((item): item is string => typeof item === 'string').join('；')
              : '';
            const detail = friendlySideError(resultText || errors || '旁问失败，请稍后重试');
            settle(() => callbacks.onError(detail));
            return;
          }
          const finalAnswer = answer || resultText;
          if (!finalAnswer.trim()) {
            settle(() => callbacks.onError('旁问没有返回内容，请重试'));
            return;
          }
          settle(() =>
            callbacks.onDone({
              answer: finalAnswer,
              costUsd: costFromResult(raw),
              durationMs:
                typeof raw.duration_ms === 'number' ? raw.duration_ms : undefined,
              model: options.model,
            }),
          );
          return;
        }
      }
      if (answer.trim()) {
        settle(() => callbacks.onDone({ answer, model: options.model }));
      } else {
        settle(() => callbacks.onError('旁问没有返回内容，请重试'));
      }
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
