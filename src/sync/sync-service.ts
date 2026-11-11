import { rm } from 'node:fs/promises';
import { OperationRunner, type OperationDeps } from '../core/operation.js';
import { ValidationError } from '../errors.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { Executor } from './executor.js';
import { defaultDigesters, type DigesterFactory } from './local-scanner.js';
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
import { GoogleSyncRemote } from './remote/google-remote.js';
import type { SyncRemote } from './remote/sync-remote.js';
import { absInside } from './paths.js';
import { plan as makePlan } from './planner.js';
import { buildReport, type ReportOptions } from './report.js';
import {
  applyRelease,
  releaseStatus,
  withoutTrash,
  selectReleasable,
  type ReleaseInput,
  type ReleaseResult,
} from './release.js';
import {
  gatherInput,
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
export type { ReleaseInput, ReleaseResult } from './release.js';
export type { ScanEntry, ScanInput, ScanResult, SelectInput, SelectResult } from './scan-select.js';

const STALE_PART_MS = 60 * 60 * 1000;

export interface SyncServiceDeps extends OperationDeps {
  store: PairStore;
  /** Moves local files to the OS trash (the app passes `createLocalTrash()`; tests pass a fake, never the real trash). */
  trash: LocalTrash;
  clock?: () => Date;
  /** Rejects accounts sync cannot serve (the app rejects Microsoft accounts). */
  assertSupportedAccount?: (ref: string | undefined) => Promise<void>;
  /** Digests of non-md5 remote hash kinds (default: built-in digesters). */
  digesters?: DigesterFactory;
}

export interface RunInput {
  name: string;
  apply?: boolean;
  planId?: string;
  allowMassDelete?: boolean;
  /** Addendum §2: also run B5 trash-remote actions. */
  confirmRemoteTrash?: boolean;
}

const CONFIRM_NEEDS_MASS_DELETE = {
  path: '',
  code: 'confirm-needs-mass-delete',
  message: 'confirming these deletions would also need allowMassDelete',
};

/**
 * Sub-project 5: pairs, AI-assisted selection, dry-run/apply two-way sync, Google-native
 * exports, release to Drive only and confirmation of remote trashes (Phase B).
 */
export class SyncService {
  private readonly ops: OperationRunner;
  private readonly log: Logger;
  private readonly clock: () => Date;
  private readonly env: SyncEnv;

  constructor(private readonly deps: SyncServiceDeps) {
    this.ops = new OperationRunner(deps);
    this.log = deps.logger ?? defaultLogger;
    this.clock = deps.clock ?? ((): Date => new Date());
    this.env = {
      audit: deps.audit,
      log: this.log,
      clock: this.clock,
      store: deps.store,
      remoteFor: (pair): SyncRemote =>
        new GoogleSyncRemote(this.ops, pair.account, pair.googleExport),
      openRemote: (ref, prefs): Promise<SyncRemote> => GoogleSyncRemote.open(this.ops, ref, prefs),
      assertSupportedAccount:
        deps.assertSupportedAccount ?? ((): Promise<void> => Promise.resolve()),
      digesters: deps.digesters ?? defaultDigesters,
    };
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
    const { input, local, remote } = await gatherInput(this.env, file);
    return { plan: makePlan(input), remote, local };
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
      const confirm = input.confirmRemoteTrash ?? false;
      const awaiting = confirm ? [] : plan.actions.filter((a) => a.reason === 'local-deleted');
      const pendingConfirmation = awaiting.map((a) => ({
        path: a.key,
        remoteId: a.record?.remoteId ?? a.remote?.id ?? '',
      }));
      // Only when confirming is what would trip the brake (the unconfirmed plan passes).
      const report = (opts: Omit<ReportOptions, 'pendingConfirmation'>): SyncReport => {
        const r = buildReport(name, plan, { ...opts, pendingConfirmation });
        if (awaiting.length > 0 && plan.brake.tripped && !plan.brakeUnconfirmed.tripped) {
          r.warnings.push(CONFIRM_NEEDS_MASS_DELETE);
        }
        return r;
      };
      if (!apply) return report({ dryRun: true });
      if (input.planId !== undefined && input.planId !== plan.planId) {
        return report({
          dryRun: true,
          aborted: {
            reason: 'plan-changed',
            message:
              'Files changed since the dry run; nothing was applied. Review this new plan and apply it with its planId.',
          },
        });
      }
      const brake = confirm ? plan.brake : plan.brakeUnconfirmed;
      if (brake.tripped && !input.allowMassDelete) {
        const { trashRemote, trashLocal, tracked } = brake;
        return report({
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
          remote: this.env.remoteFor(file.pair),
          digesters: this.env.digesters,
          audit: this.deps.audit,
          logger: this.log,
          clock: this.clock,
          save: (f): Promise<void> => this.store.save(f),
          trash: this.deps.trash,
        },
        file,
        remote.folders,
      );
      // Unconfirmed B5 deletions stay untouched (record and both sides); the next run plans them again.
      const toRun = confirm
        ? plan.actions
        : plan.actions.filter((a) => a.reason !== 'local-deleted');
      const outcomes = await executor.run(toRun);
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
          ...new Set([...file.pair.baselineFolders, ...remote.unknownFolderIds]),
        ].sort();
        file.pair.nativeBaselineDone = true;
      }
      await this.store.save(file);
      const done = new Set(outcomes.filter((o) => o.status === 'done').map((o) => o.path));
      const inSync = new Set(plan.inSync);
      const releasable = file.records
        .filter((r) => !r.remoteOnly && (inSync.has(r.path) || done.has(r.path)))
        .map((r) => r.path)
        .sort();
      return report({ dryRun: false, outcomes, releasable });
    });
  }

  /** sync_release (spec §10, addendum §3): dry run by default. */
  async release(input: ReleaseInput): Promise<ReleaseResult> {
    const all = input.all === true;
    if (all === (input.paths ?? []).length > 0) {
      throw new ValidationError('Give paths or all: true (exactly one of them)');
    }
    return this.store.withLock(input.name, async () => {
      const file = await this.store.load(input.name);
      await checkRoots(this.env, file.pair);
      const { input: planInput } = await gatherInput(
        this.env,
        file,
        all ? 'all' : (input.paths ?? []),
      );
      const selection = await withoutTrash(
        selectReleasable(planInput, all ? { all } : { paths: input.paths ?? [] }),
        file.pair.localDir,
        this.deps.trash,
      );
      const pair = file.pair.name;
      if (!(input.apply ?? false)) {
        return {
          pair,
          dryRun: true,
          released: selection.eligible.map((c) => ({
            path: c.record.path,
            status: releaseStatus(c.kind, true),
          })),
          skipped: selection.skipped,
          failed: [],
          removedDirs: [],
        };
      }
      const done = await applyRelease(
        {
          remote: this.env.remoteFor(file.pair),
          digesters: this.env.digesters,
          audit: this.deps.audit,
          logger: this.log,
          trash: this.deps.trash,
          save: (f): Promise<void> => this.store.save(f),
        },
        file,
        selection.eligible,
      );
      return { pair, dryRun: false, skipped: selection.skipped, ...done };
    });
  }
}
