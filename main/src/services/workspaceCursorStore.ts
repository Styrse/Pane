import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';

export interface WorkspaceCursor {
  gen: number;
  epoch: string;
  pendingGen?: number;
  updatedAt: string;
}

interface CursorFile {
  version: 1;
  cursors: Record<string, WorkspaceCursor>;
}

const CURSOR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const workspaceCursorSchema = boundary.object({
  gen: boundary.number,
  epoch: boundary.string,
  pendingGen: boundary.optional(boundary.number),
  updatedAt: boundary.string,
});
const cursorFileSchema = boundary.object({
  version: boundary.literal(1),
  cursors: boundary.jsonObject,
});

export class WorkspaceCursorStore {
  private loaded = false;
  private cursors = new Map<string, WorkspaceCursor>();

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  get(name: string): WorkspaceCursor | undefined {
    this.ensureLoaded();
    const value = this.cursors.get(name);
    return value ? { ...value } : undefined;
  }

  create(name: string, gen: number, epoch: string): void {
    this.ensureLoaded();
    this.cursors.set(name, { gen, epoch, updatedAt: new Date(this.now()).toISOString() });
    this.persist();
  }

  advance(name: string, gen: number, epoch: string, pending = false): void {
    this.ensureLoaded();
    const current = this.cursors.get(name);
    const committedGeneration = current?.epoch === epoch ? current.gen : gen;
    const latestGeneration = Math.max(gen, current?.epoch === epoch ? current.pendingGen ?? current.gen : gen);
    const next: WorkspaceCursor = {
      gen: pending ? committedGeneration : latestGeneration,
      epoch,
      pendingGen: pending ? latestGeneration : undefined,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.cursors.set(name, next);
    this.persist();
  }

  commitPending(name: string): WorkspaceCursor | undefined {
    this.ensureLoaded();
    const current = this.cursors.get(name);
    if (current?.pendingGen === undefined) return current ? { ...current } : undefined;
    const committed = {
      gen: current.pendingGen,
      epoch: current.epoch,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.cursors.set(name, committed);
    this.persist();
    return { ...committed };
  }

  evictStale(): string[] {
    this.ensureLoaded();
    const cutoff = this.now() - CURSOR_MAX_AGE_MS;
    const evicted: string[] = [];
    for (const [name, cursor] of this.cursors) {
      if (Date.parse(cursor.updatedAt) >= cutoff) continue;
      this.cursors.delete(name);
      evicted.push(name);
    }
    if (evicted.length > 0) this.persist();
    return evicted;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = decodeBoundary(JSON.parse(fs.readFileSync(this.filePath, 'utf8')), cursorFileSchema);
      for (const [name, value] of Object.entries(parsed.cursors)) {
        const cursor = decodeOptionalBoundary(value, workspaceCursorSchema);
        if (cursor && isValidCursor(cursor)) this.cursors.set(name, cursor);
      }
    } catch (error) {
      const details = decodeOptionalBoundary(error, boundary.object({ code: boundary.optional(boundary.string) }));
      if (details?.code !== 'ENOENT') {
        console.warn('[WorkspaceCursorStore] Ignoring unreadable cursor file:', error);
      }
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    const payload: CursorFile = { version: 1, cursors: Object.fromEntries(this.cursors) };
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }
}

function isValidCursor(value: WorkspaceCursor): boolean {
  return Number.isInteger(value.gen) && value.gen >= 0 &&
    (value.pendingGen === undefined || (Number.isInteger(value.pendingGen) && value.pendingGen >= 0));
}
