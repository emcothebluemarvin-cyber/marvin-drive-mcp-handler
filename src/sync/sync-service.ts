import { rm } from 'node:fs/promises';
import { OperationRunner, type OperationDeps } from '../core/operation.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { Executor } from './executor.js';
import { hashLocal, probeOnDisk } from './local-scanner.js';
import {
  checkRoots,
  createPair,
  listPairs,
  removePair,
  repairMarker,
  type CreatePairInput,
  type PairSummary,
  type SyncEnv,
} from './pair-admin.js';
import type { PairStore } from './pair-store.js';
import { absInside, toKey } from './paths.js';
import { plan as makePlan } from './planner.js';
import { probeRecords } from './remote-probe.js';
import { buildReport } from './report.js';
import { hashTargets, onDiskProbeKeys } from './resolve.js';
import {
  scanBoth,
  scanPair,
  selectPaths,
  type ScanInput,
  type ScanResult,
  type SelectInput,
  type SelectResult,
} from './scan-select.js';
import type { LocalTrash } from './trash.js';
import type { LocalScan, Pair, PairFile, Plan, RemoteScan, SyncReport } from './types.js';

export {
  remoteRootProblem,
  summarize,
  type CreatePairInput,
  type PairSummary,
} from './pair-admin.js';
export type { ScanEntry, ScanInput, ScanResult, SelectInput, SelectResult } from './scan-select.js';

const STALE_PART_MS = 60 * 60 * 1000;

export interface SyncServiceDeps extends OperationDeps {
  store: PairStore;
  /** Moves local files to the OS trash (the app passes `createLocalTrash()`; tests pass a fake, never the real trash). */
  trash: LocalTrash;
  clock?: () => Date;
}

export interface RunInput {
  name: string;
  apply?: boolean;
  planId?: string;
  allowMassDelete?: boolean;
}

/** Sub-project 5 Phase A: pairs, AI-assisted selection, dry-run/apply two-way sync. */
export class SyncService {
  private readonly ops: OperationRunner;
  private readonly log: Logger;
  private readonly clock: () => Date;
  private readonly env: SyncEnv;

  constructor(private readonly deps: SyncServiceDeps) {
    this.ops = new OperationRunner(deps);
    this.log = deps.logger ?? defaultLogger;
    this.clock = deps.clock ?? ((): Date => new Date());
    this.env = { ops: this.ops, log: this.log, clock: this.clock, store: deps.store };
  }

  private get store(): PairStore {
    return this.deps.store;
  }

  createPair(input: CreatePairInput): Promise<PairSummary> {
    return createPair(this.env, input);
  }

  listPairs(): Promise<PairSummary[]> {
    return listPairs(this.env);
  }

  removePair(input: { name: string }): Promise<{ name: string; removed: true; note: string }> {
    return removePair(this.env, input);
  }

  /** Rewrites the root marker after `confirm` (spec §9) and re-probes case sensitivity. */
  repairMarker(
    name: string,
    confirm: (pair: Pair) => Promise<boolean>,
  ): Promise<{ repaired: boolean; localDir: string; caseInsensitive: boolean }> {
    return repairMarker(this.env, name, confirm);
  }

  /** sync_scan: local files (with text previews) and remote candidates for Claude to choose from. */
  scan(input: ScanInput): Promise<ScanResult> {
    return scanPair(this.env, input);
  }

  /** sync_select: add/remove relative paths (spec §8). */
  select(input: SelectInput): Promise<SelectResult> {
    return selectPaths(this.env, input);
  }

  /** Spec §5 steps 3–5: scan, hash, probe, plan. */
  private async buildPlan(
    file: PairFile,
  ): Promise<{ plan: Plan; remote: RemoteScan; local: LocalScan }> {
    const { pair, records } = file;
    const { local, remote } = await scanBoth(this.env, pair);
    // §6.1: keys without an exact scan match may still exist on disk (through a symlinked
    // parent, or under a spelling the volume folds onto a scanned file) — ask the volume.
    const onDisk = await probeOnDisk(
      pair.localDir,
      onDiskProbeKeys({ pair, records, local, remote }),
    );
    const base = { pair, records, local, remote, probes: new Map(), onDisk };
    const { md5s, failed } = await hashLocal(pair.localDir, hashTargets(base));
    for (const name of failed) local.unknownSubtrees.push(toKey(name));
    const seen = new Set([...remote.entries.map((e) => e.id), ...remote.ignored.map((i) => i.id)]);
    const missing = records.map((r) => r.remoteId).filter((id) => !seen.has(id));
    const probes = await probeRecords(
      missing,
      remote,
      (id, fields) =>
        this.ops.exec(pair.account, 'idempotent', id, (ctx) => ctx.drive.getFile(id, fields)),
      pair.googleExport,
    );
    return { plan: makePlan({ ...base, probes, md5s }), remote, local };
  }

  private async removeStaleParts(pair: Pair, local: LocalScan): Promise<void> {
    const now = this.clock().getTime();
    for (const part of local.partFiles) {
      if (now - part.mtimeMs <= STALE_PART_MS) continue;
      try {
        await rm(absInside(pair.localDir, part.name), { force: true });
      } catch (err) {
        this.log.warn('Could not remove a stale temp file', { name: part.name, error: err });
      }
    }
  }

  /** sync_run: dry run by default; apply re-plans and can be bound to a dry run's planId. */
  async run(input: RunInput): Promise<SyncReport> {
    const apply = input.apply ?? false;
    return this.store.withLock(input.name, async () => {
      // lastAppliedRunAt is the scan start: files changed during the run stay "recent" (U8).
      const startedAt = this.clock().toISOString();
      const file = await this.store.load(input.name);
      await checkRoots(this.env, file.pair);
      const { plan, remote, local } = await this.buildPlan(file);
      const name = file.pair.name;
      if (!apply) return buildReport(name, plan, { dryRun: true });
      if (input.planId !== undefined && input.planId !== plan.planId) {
        return buildReport(name, plan, {
          dryRun: true,
          aborted: {
            reason: 'plan-changed',
            message:
              'Files changed since the dry run; nothing was applied. Review this new plan and apply it with its planId.',
          },
        });
      }
      if (plan.brake.tripped && !input.allowMassDelete) {
        const { trashRemote, trashLocal, tracked } = plan.brake;
        return buildReport(name, plan, {
          dryRun: true,
          aborted: {
            reason: 'mass-delete',
            message: `Would move ${trashRemote} Drive file(s) and ${trashLocal} local file(s) to the trash out of ${tracked} tracked; nothing was applied. Re-run with allowMassDelete if this is intended.`,
          },
        });
      }
      await this.removeStaleParts(file.pair, local);
      const executor = new Executor(
        {
          ops: this.ops,
          audit: this.deps.audit,
          logger: this.log,
          clock: this.clock,
          save: (f): Promise<void> => this.store.save(f),
          trash: this.deps.trash,
        },
        file,
        remote.folders,
      );
      const outcomes = await executor.run(plan.actions);
      file.pair.lastAppliedRunAt = startedAt;
      if (file.pair.firstAppliedRunAt === null) {
        file.pair.firstAppliedRunAt = startedAt;
        file.pair.remoteBaseline = plan.baseline.files;
        file.pair.baselineFolders = plan.baseline.folders;
      }
      // Addendum §4.1: baseline the natives Phase A never recorded, in the same save.
      if (!file.pair.nativeBaselineDone) {
        file.pair.remoteBaseline = [
          ...new Set([...file.pair.remoteBaseline, ...plan.nativeBaseline]),
        ].sort();
        file.pair.baselineFolders = [
          ...new Set([...file.pair.baselineFolders, ...plan.baseline.folders]),
        ].sort();
        file.pair.nativeBaselineDone = true;
      }
      await this.store.save(file);
      return buildReport(name, plan, { dryRun: false, outcomes });
    });
  }
}
