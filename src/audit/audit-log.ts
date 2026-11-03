import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export type AuditOp =
  'upload' | 'create_folder' | 'move' | 'rename' | 'copy' | 'delete' | 'restore';

export interface AuditEntry {
  ts: string;
  /** Account alias. */
  account: string;
  op: AuditOp;
  fileId: string;
  name?: string;
  details: Record<string, unknown>;
}

export interface AuditSink {
  record(entry: Omit<AuditEntry, 'ts'>): Promise<void>;
}

/** Append-only JSONL audit trail (spec §4, §5). */
export class FileAuditLog implements AuditSink {
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(entry: Omit<AuditEntry, 'ts'>): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const line: AuditEntry = { ts: this.now().toISOString(), ...entry };
    await appendFile(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }
}
