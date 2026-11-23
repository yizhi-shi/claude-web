import AnsiToHtml from 'ansi-to-html';
import { diffLines } from 'diff';
import hljs from 'highlight.js/lib/common';
import MarkdownIt from 'markdown-it';
import type { ContentBlock } from './types';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code, language) {
    if (language && hljs.getLanguage(language)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language }).value}</code></pre>`;
      } catch {
        // fall through
      }
    }
    return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`;
  },
});

md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return self.renderToken(tokens, idx, options);
};

export function renderMarkdown(text: string): string {
  return md.render(text || '');
}

const ansi = new AnsiToHtml({ escapeXML: true, newline: true });

export function ansiToHtml(text: string): string {
  return ansi.toHtml(text || '');
}

export function basename(value: string): string {
  if (!value) return '';
  const trimmed = value.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

export function prettyPath(value: string): string {
  if (!value) return '';
  if (value === '/root') return '~';
  if (value.startsWith('/root/')) return `~/${value.slice(6)}`;
  return value;
}

export function formatRelative(value: string | number | undefined): string {
  if (!value) return '';
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const delta = Date.now() - time;
  const abs = Math.abs(delta);
  if (abs < 60_000) return '刚刚';
  if (abs < 3_600_000) return `${Math.floor(abs / 60_000)} 分钟前`;
  if (abs < 86_400_000) return `${Math.floor(abs / 3_600_000)} 小时前`;
  if (abs < 7 * 86_400_000) return `${Math.floor(abs / 86_400_000)} 天前`;
  const date = new Date(time);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function formatClock(value: string | number | undefined): string {
  if (!value) return '';
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}

export function formatCost(usd: number | undefined): string {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return '';
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(count: number | undefined): string {
  if (typeof count !== 'number' || !Number.isFinite(count)) return '';
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
}

export type DiffLine = { kind: 'add' | 'del' | 'ctx'; text: string };

export function buildDiff(oldText: string, newText: string): DiffLine[] {
  const parts = diffLines(oldText || '', newText || '');
  const lines: DiffLine[] = [];
  for (const part of parts) {
    const kind: DiffLine['kind'] = part.added ? 'add' : part.removed ? 'del' : 'ctx';
    for (const line of part.value.split('\n')) {
      if (line === '' && part.value.endsWith('\n')) continue;
      lines.push({ kind, text: line });
      if (lines.length > 800) return lines;
    }
  }
  return lines;
}

export interface ToolPresentation {
  label: string;
  summary: string;
  command?: string;
  filePath?: string;
  diff?: DiffLine[];
  json?: string;
  todos?: { content: string; status: string }[];
  questions?: { question: string; options?: { label: string; description?: string }[] }[];
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function presentTool(name: string, input: Record<string, unknown>): ToolPresentation {
  const lower = name.toLowerCase();
  if (lower === 'bash' || lower === 'shell' || lower === 'exec') {
    const command = textOf(input.command) || textOf(input.cmd);
    return {
      label: '终端',
      summary: command.split('\n')[0]?.slice(0, 120) || '执行命令',
      command,
    };
  }
  if (lower === 'read') {
    const file = textOf(input.file_path) || textOf(input.path);
    return { label: '读取', summary: prettyPath(file), filePath: file };
  }
  if (lower === 'edit') {
    const file = textOf(input.file_path) || textOf(input.path);
    return {
      label: '编辑',
      summary: prettyPath(file),
      filePath: file,
      diff: buildDiff(textOf(input.old_string), textOf(input.new_string)),
    };
  }
  if (lower === 'multiedit') {
    const file = textOf(input.file_path) || textOf(input.path);
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const lines: DiffLine[] = [];
    for (const edit of edits) {
      if (!edit || typeof edit !== 'object') continue;
      const row = edit as Record<string, unknown>;
      lines.push(...buildDiff(textOf(row.old_string), textOf(row.new_string)));
    }
    return { label: '批量编辑', summary: prettyPath(file), filePath: file, diff: lines };
  }
  if (lower === 'write' || lower === 'create') {
    const file = textOf(input.file_path) || textOf(input.path);
    return {
      label: '写入',
      summary: prettyPath(file),
      filePath: file,
      diff: buildDiff('', textOf(input.content)),
    };
  }
  if (lower === 'glob') {
    return { label: '查找文件', summary: textOf(input.pattern), json: JSON.stringify(input, null, 2) };
  }
  if (lower === 'grep') {
    return {
      label: '搜索内容',
      summary: textOf(input.pattern) || '搜索',
      json: JSON.stringify(input, null, 2),
    };
  }
  if (lower === 'webfetch' || lower === 'web_fetch') {
    return { label: '抓取网页', summary: textOf(input.url), json: JSON.stringify(input, null, 2) };
  }
  if (lower === 'websearch' || lower === 'web_search') {
    return { label: '联网搜索', summary: textOf(input.query), json: JSON.stringify(input, null, 2) };
  }
  if (lower === 'task' || lower === 'agent') {
    return {
      label: '子代理',
      summary: textOf(input.description) || textOf(input.subagent_type) || '委派任务',
      json: JSON.stringify(input, null, 2),
    };
  }
  if (lower === 'todowrite' || lower === 'todo_write') {
    const todos = Array.isArray(input.todos)
      ? input.todos
          .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
          .map((item) => ({
            content: String(item.content ?? ''),
            status: String(item.status ?? 'pending'),
          }))
      : [];
    return {
      label: '任务清单',
      summary: todos.length ? `${todos.length} 项` : '更新任务清单',
      todos,
    };
  }
  if (lower === 'askuserquestion') {
    const questions = Array.isArray(input.questions)
      ? input.questions
          .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
          .map((item) => ({
            question: String(item.question ?? ''),
            options: Array.isArray(item.options)
              ? item.options
                  .filter((opt): opt is Record<string, unknown> => !!opt && typeof opt === 'object')
                  .map((opt) => ({
                    label: String(opt.label ?? ''),
                    description: opt.description ? String(opt.description) : undefined,
                  }))
              : undefined,
          }))
      : [];
    return {
      label: '向你提问',
      summary: questions[0]?.question?.slice(0, 80) || '等待回答',
      questions,
    };
  }
  if (lower === 'exitplanmode') {
    return { label: '计划确认', summary: '等待确认执行计划', json: JSON.stringify(input, null, 2) };
  }
  return {
    label: name.replace(/^mcp__/, 'MCP · ').replace(/__/g, ' / '),
    summary: Object.keys(input).slice(0, 3).join(', ') || '工具调用',
    json: JSON.stringify(input, null, 2),
  };
}

export function blockText(blocks: ContentBlock[], type: 'text' | 'thinking'): string {
  return blocks
    .filter((block) => block.type === type)
    .map((block) => (type === 'text' ? block.text ?? '' : block.thinking ?? ''))
    .join('\n\n');
}

export function isEditTool(name: string): boolean {
  return ['edit', 'multiedit', 'write', 'create'].includes(name.toLowerCase());
}

export function statusLabel(status: string | undefined): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'waiting_permission':
      return '等待批准';
    case 'idle':
      return '空闲';
    case 'stopped':
      return '已停止';
    case 'error':
      return '异常';
    case 'new':
      return '新会话';
    default:
      return '历史';
  }
}

export function statusTone(status: string | undefined): 'on' | 'busy' | 'warn' | 'off' | 'error' {
  if (status === 'running') return 'busy';
  if (status === 'waiting_permission') return 'warn';
  if (status === 'error') return 'error';
  if (status === 'idle' || status === 'new') return 'on';
  return 'off';
}
