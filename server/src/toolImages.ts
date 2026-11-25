import fs from 'node:fs';
import path from 'node:path';
import { decodeBase64 } from './attachments.js';
import { config } from './config.js';
import type { ToolImageRef } from './types.js';
import { HttpError, randomId } from './util.js';

/**
 * Tool-result images are produced by Claude Code itself (a Read of a PNG,
 * a screenshot tool, ...). They arrive as base64 image blocks inside the
 * tool_result. Embedding those bytes in the transcript would make every
 * history fetch and WebSocket replay enormous, so only a descriptor is
 * persisted; the bytes live in this store and are served by an authenticated
 * session-scoped endpoint.
 */
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const FILE_RE = /^[A-Za-z0-9-]{1,64}\.[a-z0-9]{1,10}$/;

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Keep one runaway result from filling the disk; the CLI image cap is lower. */
const MAX_IMAGES_PER_RESULT = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface StoredToolImage extends ToolImageRef {
  file: string;
  createdAt: string;
}

export class ToolImageStore {
  constructor(private readonly root: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  private sessionDir(sessionId: string): string {
    if (!SESSION_RE.test(sessionId)) throw new HttpError(400, '无效的会话 ID');
    return path.join(this.root, sessionId);
  }

  private metaFile(sessionId: string, id: string): string {
    return path.join(this.sessionDir(sessionId), `${id}.json`);
  }

  /**
   * Extract and persist image blocks from a tool_result content array.
   * Invalid or unsupported blocks are ignored: an image preview is an
   * enhancement, and must never break the tool result or the turn.
   */
  saveFromContent(sessionId: string, content: unknown): ToolImageRef[] {
    if (!Array.isArray(content)) return [];
    const dir = this.sessionDir(sessionId);
    const refs: ToolImageRef[] = [];
    for (const item of content) {
      if (refs.length >= MAX_IMAGES_PER_RESULT) break;
      if (!item || typeof item !== 'object') continue;
      const block = item as Record<string, unknown>;
      if (block.type !== 'image') continue;
      const source = block.source;
      if (!source || typeof source !== 'object') continue;
      const row = source as Record<string, unknown>;
      if (row.type !== 'base64' || typeof row.data !== 'string') continue;
      const mimeType = typeof row.media_type === 'string' ? row.media_type.trim().toLowerCase() : '';
      const ext = IMAGE_EXT[mimeType];
      if (!ext) continue;
      let buffer: Buffer;
      try {
        buffer = decodeBase64(row.data);
      } catch {
        continue;
      }
      if (buffer.length === 0 || buffer.length > Math.min(MAX_IMAGE_BYTES, config.maxAttachmentBytes)) {
        continue;
      }

      const id = randomId();
      const name = `image-${refs.length + 1}.${ext}`;
      const file = `${id}.${ext}`;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, file), buffer, { mode: 0o600, flag: 'wx' });
      const meta: StoredToolImage = {
        id,
        name,
        mimeType,
        size: buffer.length,
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
      refs.push({ id, name, mimeType, size: buffer.length });
    }
    return refs;
  }

  read(sessionId: string, id: string): { meta: StoredToolImage; file: string; size: number } {
    this.sessionDir(sessionId);
    if (!ID_RE.test(id)) throw new HttpError(404, '图片不存在');
    let meta: StoredToolImage;
    try {
      meta = JSON.parse(fs.readFileSync(this.metaFile(sessionId, id), 'utf8')) as StoredToolImage;
    } catch {
      throw new HttpError(404, '图片不存在');
    }
    if (
      !meta ||
      meta.id !== id ||
      typeof meta.file !== 'string' ||
      !FILE_RE.test(meta.file) ||
      !IMAGE_EXT[meta.mimeType] ||
      typeof meta.name !== 'string' ||
      typeof meta.size !== 'number' ||
      !Number.isFinite(meta.size) ||
      meta.size < 0
    ) {
      throw new HttpError(404, '图片不存在');
    }
    const file = path.join(this.sessionDir(sessionId), meta.file);
    if (!fs.existsSync(file)) throw new HttpError(404, '图片文件不存在');
    return { meta, file, size: fs.statSync(file).size };
  }
}
