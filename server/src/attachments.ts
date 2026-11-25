import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { AttachmentRef } from './types.js';
import { HttpError, randomId } from './util.js';

const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ATTACHMENT_RE = /^[A-Za-z0-9-]{1,64}$/;
const FILE_RE = /^[A-Za-z0-9-]{1,64}\.[a-z0-9]{1,10}$/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const MAX_NAME = 180;

/**
 * Images that Claude can actually see. SVG is deliberately excluded: it is
 * XML with script potential and the model cannot consume it as an image block
 * anyway; it is stored and served as a downloadable file instead.
 */
const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'mdx', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml',
  'ini', 'conf', 'cfg', 'env', 'csv', 'tsv', 'log', 'xml', 'html', 'htm', 'css',
  'scss', 'less', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'py',
  'go', 'rs', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rb',
  'php', 'swift', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'graphql', 'gql',
  'diff', 'patch', 'proto', 'dockerfile', 'makefile',
]);
const TEXT_MIME = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/javascript',
  'application/typescript',
  'application/sql',
  'application/graphql',
  'application/x-sh',
  'application/x-httpd-php',
  'application/x-python-code',
]);

/** Small text files are inlined so the model sees them even when Read is denied. */
const MAX_INLINE_BYTES = 64 * 1024;
const MAX_INLINE_TOTAL_BYTES = 128 * 1024;

export interface StoredAttachment extends AttachmentRef {
  /** Generated file name inside the session directory; never user-controlled. */
  file: string;
  createdAt: string;
}

export interface ResolvedAttachment {
  ref: AttachmentRef;
  path: string;
  /** Base64 bytes for an image content block. */
  base64?: string;
  /** Inline UTF-8 content for a small text file. */
  text?: string;
}

export interface AttachmentInput {
  name?: unknown;
  mimeType?: unknown;
  dataBase64?: unknown;
}

function assertSessionId(id: string): void {
  if (!SESSION_RE.test(id)) throw new HttpError(400, '无效的会话 ID');
}

function assertAttachmentId(id: string): void {
  if (!ATTACHMENT_RE.test(id)) throw new HttpError(404, '附件不存在');
}

function cleanName(value: unknown): string {
  const raw = typeof value === 'string' ? value.replace(/\\/g, '/') : '';
  const base = path
    .basename(raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return (base || 'attachment').slice(0, MAX_NAME);
}

function cleanMime(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return 'application/octet-stream';
  if (raw.length > 120 || !MIME_RE.test(raw)) throw new HttpError(400, '附件类型无效');
  return raw;
}

function extensionFor(name: string, mimeType: string): string {
  const fromMime = IMAGE_EXT[mimeType];
  if (fromMime) return fromMime;
  const ext = path.extname(name).toLowerCase().slice(1);
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : 'bin';
}

export function decodeBase64(value: unknown): Buffer {
  const raw = typeof value === 'string' ? value : '';
  if (
    !raw ||
    raw.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)
  ) {
    throw new HttpError(400, '附件数据格式错误');
  }
  const padding = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0;
  const expected = (raw.length / 4) * 3 - padding;
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.length !== expected) throw new HttpError(400, '附件数据格式错误');
  return buffer;
}

function isTextLike(meta: StoredAttachment): boolean {
  if (meta.mimeType.startsWith('text/') || TEXT_MIME.has(meta.mimeType)) return true;
  const ext = path.extname(meta.name).toLowerCase().slice(1);
  return TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(meta.name.toLowerCase());
}

function toRef(meta: StoredAttachment): AttachmentRef {
  return {
    id: meta.id,
    name: meta.name,
    mimeType: meta.mimeType,
    size: meta.size,
    kind: meta.kind,
  };
}

function formatMb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/** RFC 6266 header that never lets a user-controlled name break out of the quotes. */
export function contentDisposition(kind: AttachmentRef['kind'], name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'attachment';
  return `${kind === 'image' ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export class AttachmentStore {
  constructor(private readonly root: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  private sessionDir(sessionId: string): string {
    assertSessionId(sessionId);
    return path.join(this.root, sessionId);
  }

  private metaFile(sessionId: string, id: string): string {
    return path.join(this.sessionDir(sessionId), `${id}.json`);
  }

  save(sessionId: string, input: AttachmentInput): AttachmentRef {
    const dir = this.sessionDir(sessionId);
    const name = cleanName(input.name);
    const mimeType = cleanMime(input.mimeType);
    const buffer = decodeBase64(input.dataBase64);
    if (buffer.length === 0) throw new HttpError(400, '附件不能为空');
    if (buffer.length > config.maxAttachmentBytes) {
      throw new HttpError(413, `单个附件不能超过 ${formatMb(config.maxAttachmentBytes)}`);
    }

    const id = randomId();
    const file = `${id}.${extensionFor(name, mimeType)}`;
    const kind: AttachmentRef['kind'] = IMAGE_EXT[mimeType] ? 'image' : 'file';
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, file), buffer, { mode: 0o600, flag: 'wx' });

    const meta: StoredAttachment = {
      id,
      name,
      mimeType,
      size: buffer.length,
      kind,
      file,
      createdAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(this.metaFile(sessionId, id), JSON.stringify(meta, null, 2), {
        mode: 0o600,
        flag: 'wx',
      });
    } catch (error) {
      fs.rmSync(path.join(dir, file), { force: true });
      throw error;
    }
    return toRef(meta);
  }

  private readMeta(sessionId: string, id: string): StoredAttachment {
    assertSessionId(sessionId);
    assertAttachmentId(id);
    const metaFile = this.metaFile(sessionId, id);
    let parsed: StoredAttachment;
    try {
      parsed = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as StoredAttachment;
    } catch {
      throw new HttpError(404, '附件不存在');
    }
    if (
      !parsed ||
      parsed.id !== id ||
      typeof parsed.file !== 'string' ||
      !FILE_RE.test(parsed.file) ||
      typeof parsed.name !== 'string' ||
      typeof parsed.mimeType !== 'string' ||
      typeof parsed.size !== 'number' ||
      !Number.isFinite(parsed.size) ||
      parsed.size < 0 ||
      !['image', 'file'].includes(parsed.kind)
    ) {
      throw new HttpError(404, '附件不存在');
    }
    // The sidecar is written by us, but never trust it for the response type:
    // only the four image MIME types may be served inline.
    if (parsed.kind === 'image' && !IMAGE_EXT[parsed.mimeType]) {
      throw new HttpError(404, '附件不存在');
    }
    return parsed;
  }

  private filePath(sessionId: string, meta: StoredAttachment): string {
    const file = path.join(this.sessionDir(sessionId), meta.file);
    if (!fs.existsSync(file)) throw new HttpError(404, '附件文件不存在');
    return file;
  }

  read(sessionId: string, id: string): { meta: StoredAttachment; file: string; size: number } {
    const meta = this.readMeta(sessionId, id);
    const file = this.filePath(sessionId, meta);
    return { meta, file, size: fs.statSync(file).size };
  }

  /**
   * Resolve client-provided ids into the exact payload the SDK needs. Images
   * become base64 image blocks; small text files are inlined; everything else
   * is referenced by absolute path so Claude can Read it on demand.
   */
  resolve(sessionId: string, ids: string[]): ResolvedAttachment[] {
    if (ids.length === 0) return [];
    if (ids.length > config.maxAttachmentsPerMessage) {
      throw new HttpError(400, `单条消息最多 ${config.maxAttachmentsPerMessage} 个附件`);
    }

    const out: ResolvedAttachment[] = [];
    let total = 0;
    let inlineBudget = MAX_INLINE_TOTAL_BYTES;
    for (const raw of ids) {
      const id = typeof raw === 'string' ? raw : '';
      const meta = this.readMeta(sessionId, id);
      total += meta.size;
      if (total > config.maxTotalAttachmentBytes) {
        throw new HttpError(413, `附件总大小不能超过 ${formatMb(config.maxTotalAttachmentBytes)}`);
      }
      const file = this.filePath(sessionId, meta);
      if (meta.kind === 'image') {
        out.push({ ref: toRef(meta), path: file, base64: fs.readFileSync(file).toString('base64') });
        continue;
      }

      let text: string | undefined;
      if (meta.size <= Math.min(MAX_INLINE_BYTES, inlineBudget) && isTextLike(meta)) {
        try {
          const buffer = fs.readFileSync(file);
          if (!buffer.includes(0)) {
            text = buffer.toString('utf8');
            inlineBudget -= buffer.length;
          }
        } catch {
          // Fall back to a path reference.
        }
      }
      out.push({ ref: toRef(meta), path: file, ...(text !== undefined ? { text } : {}) });
    }
    return out;
  }
}
