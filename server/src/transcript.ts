import fs from 'node:fs';
import path from 'node:path';
import type { UiEvent, UiEventInput } from './types.js';

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export class TranscriptStore {
  private lastSeq = new Map<string, number>();

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private assertId(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`invalid session id: ${id}`);
    return id;
  }

  file(id: string): string {
    return path.join(this.dir, `${this.assertId(id)}.jsonl`);
  }

  exists(id: string): boolean {
    try {
      return fs.statSync(this.file(id)).size > 0;
    } catch {
      return false;
    }
  }

  private loadLastSeq(id: string): number {
    const cached = this.lastSeq.get(id);
    if (cached !== undefined) return cached;
    let seq = 0;
    try {
      const lines = fs.readFileSync(this.file(id), 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]?.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { seq?: number };
          if (typeof parsed.seq === 'number') {
            seq = parsed.seq;
            break;
          }
        } catch {
          // ignore a torn last line
        }
      }
    } catch {
      seq = 0;
    }
    this.lastSeq.set(id, seq);
    return seq;
  }

  append(id: string, event: UiEventInput): UiEvent {
    const seq = this.loadLastSeq(id) + 1;
    const full = { ...event, seq, ts: Date.now() } as UiEvent;
    fs.appendFileSync(this.file(id), `${JSON.stringify(full)}\n`, { mode: 0o600 });
    this.lastSeq.set(id, seq);
    return full;
  }

  appendMany(id: string, events: UiEventInput[]): UiEvent[] {
    const out: UiEvent[] = [];
    for (const event of events) out.push(this.append(id, event));
    return out;
  }

  last(id: string): number {
    return this.loadLastSeq(id);
  }

  read(id: string, after = 0, limit = 50_000): UiEvent[] {
    return this.readWindow(id, { after, limit });
  }

  readWindow(
    id: string,
    options: {
      after?: number;
      before?: number;
      limit?: number;
      tail?: boolean;
      /** Skip token-level streaming deltas; they are live-only for history. */
      compact?: boolean;
    },
  ): UiEvent[] {
    const after = options.after ?? 0;
    const before = options.before ?? Number.MAX_SAFE_INTEGER;
    const limit = options.limit ?? 50_000;
    let raw: string;
    try {
      raw = fs.readFileSync(this.file(id), 'utf8');
    } catch {
      return [];
    }
    const out: UiEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let parsed: UiEvent;
      try {
        parsed = JSON.parse(line) as UiEvent;
      } catch {
        continue;
      }
      if (!parsed || typeof parsed.seq !== 'number') continue;
      if (parsed.seq <= after || parsed.seq >= before) continue;
      // A long answer emits thousands of deltas. History paginates renderable
      // events, not tokens, or the newest turn fills every page by itself.
      if (options.compact && parsed.type === 'assistant.delta') continue;
      out.push(parsed);
    }
    if (options.tail) return out.slice(-limit);
    return out.slice(0, limit);
  }

  remove(id: string): void {
    try {
      fs.rmSync(this.file(id), { force: true });
    } catch {
      // ignore
    }
    this.lastSeq.delete(id);
  }
}
