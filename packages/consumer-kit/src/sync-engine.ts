import { contractByView, type EntityMeta } from '@pubsub/contract';
import Redis from 'ioredis';
import type { ConsumerConfig } from './config';
import type { Change, ChangeTypeName, GraphqlClient, PulledEntity } from './graphql-client';
import type { MirrorStore } from './mirror-store';

export type EngineStats = {
  view: string;
  startedAt: string | null;
  bootstrapped: boolean;
  messagesReceived: number;
  applied: number;
  skipped: number;
  deleted: number;
  pullFailures: number;
  reconciles: number;
  reconcilesApplied: number;
  droppedMessages: number;
  lastMessageSeq: number | null;
  lastError: string | null;
  lastReconcileAt: string | null;
};

type Applied = 'applied' | 'skipped' | 'deleted' | 'missing';

/**
 * Vòng đời consumer:
 *
 *  1. bootstrap: chốt headSeq, kéo toàn bộ danh sách, đặt cursor = headSeq
 *  2. message: lọc theo version rồi kéo đúng một bản
 *  3. reconcile: quét changes(afterSeq) để bù message bị mất, kể cả tombstone
 *
 * Message là tín hiệu, không phải nguồn dữ liệu. Mất message chỉ làm chậm,
 * không làm sai — vì changes() vẫn còn đó.
 */
export class SyncEngine {
  readonly stats: EngineStats;
  private subscriber?: Redis;
  private timer?: NodeJS.Timeout;
  private reconciling = false;

  constructor(
    private readonly config: ConsumerConfig,
    private readonly store: MirrorStore,
    private readonly gql: GraphqlClient,
  ) {
    this.stats = {
      view: config.view,
      startedAt: null,
      bootstrapped: false,
      messagesReceived: 0,
      applied: 0,
      skipped: 0,
      deleted: 0,
      pullFailures: 0,
      reconciles: 0,
      reconcilesApplied: 0,
      droppedMessages: 0,
      lastMessageSeq: null,
      lastError: null,
      lastReconcileAt: null,
    };
  }

  async start(): Promise<void> {
    await this.store.migrate();

    if ((await this.store.getCursor()) === 0) {
      try {
        await this.bootstrap();
      } catch (error) {
        // Không chết: cursor còn 0 nên reconcile sẽ replay toàn bộ changes().
        this.stats.lastError = `bootstrap: ${(error as Error).message}`;
        await this.store.recordEvent({
          kind: 'bootstrap-failed',
          detail: (error as Error).message,
        });
      }
    }

    this.subscriber = new Redis(this.config.redisUrl, { maxRetriesPerRequest: 2 });
    this.subscriber.on('error', (error: Error) => {
      this.stats.lastError = `redis: ${error.message}`;
    });
    this.subscriber.on('message', (channel: string, payload: string) => {
      if (channel === this.config.channel) void this.handleMessage(payload);
    });

    // Message bus chết không được làm consumer chết: changes() vẫn là đường bù.
    try {
      await this.subscriber.subscribe(this.config.channel);
    } catch (error) {
      this.stats.lastError = `subscribe: ${(error as Error).message}`;
      await this.store.recordEvent({
        kind: 'subscribe-failed',
        detail: (error as Error).message,
      });
    }

    this.timer = setInterval(() => void this.reconcile(), this.config.reconcileIntervalMs);
    this.timer.unref();

    this.stats.startedAt = new Date().toISOString();
    await this.store.recordEvent({
      kind: 'consumer-started',
      detail: `channel=${this.config.channel} dropMessages=${this.config.dropMessages}`,
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.subscriber?.quit().catch(() => undefined);
    await this.store.end();
  }

  async state() {
    const [cursor, counts, headSeq] = await Promise.all([
      this.store.getCursor(),
      this.store.summary(),
      this.gql.headSeq().catch(() => null),
    ]);
    return { ...this.stats, cursor, headSeq, counts };
  }

  /**
   * Sync lần đầu: chốt headSeq TRƯỚC khi kéo danh sách, để thay đổi xảy ra
   * trong lúc kéo vẫn được changes() nhặt lại sau đó.
   */
  async bootstrap(): Promise<void> {
    const headSeq = await this.gql.headSeq();

    for (const meta of Object.values(contractByView[this.config.view].entities)) {
      let after: string | null = null;
      for (;;) {
        const page = await this.gql.list(meta, { first: 100, after });
        for (const node of page.nodes) {
          await this.store.upsert(meta.name, String(node.id), Number(node.version), node);
        }
        if (!page.hasNextPage || !page.endCursor) break;
        after = page.endCursor;
      }
    }

    await this.store.setCursor(headSeq);
    this.stats.bootstrapped = true;
    await this.store.recordEvent({ kind: 'bootstrap', seq: headSeq, detail: 'full list' });
  }

  private async handleMessage(payload: string): Promise<void> {
    let message: {
      entity?: string;
      id?: string;
      version?: number;
      changeType?: ChangeTypeName;
      seq?: number;
    };

    try {
      message = JSON.parse(payload);
    } catch {
      await this.store.recordEvent({ kind: 'message-invalid', detail: payload.slice(0, 120) });
      return;
    }

    this.stats.messagesReceived += 1;
    const { entity, id, version, changeType, seq } = message;
    if (!entity || !id || !changeType || typeof seq !== 'number') return;
    this.stats.lastMessageSeq = seq;

    if (this.config.dropMessages) {
      this.stats.droppedMessages += 1;
      await this.store.recordEvent({
        kind: 'message-dropped',
        entity,
        entityId: id,
        version: version ?? null,
        seq,
        detail: 'DROP_MESSAGES=1 — chỉ bù được bằng changes()',
      });
      return;
    }

    try {
      const result = await this.applyChange(entity, id, changeType, version ?? 0);
      await this.store.recordEvent({
        kind: `message-${result}`,
        entity,
        entityId: id,
        version: version ?? null,
        seq,
      });
    } catch (error) {
      this.stats.lastError = (error as Error).message;
      await this.store.recordEvent({
        kind: 'message-error',
        entity,
        entityId: id,
        version: version ?? null,
        seq,
        detail: (error as Error).message,
      });
    }
  }

  async reconcileNow(): Promise<{ applied: number; cursor: number }> {
    await this.reconcile(true);
    return { applied: this.stats.reconcilesApplied, cursor: await this.store.getCursor() };
  }

  private async reconcile(force = false): Promise<void> {
    if (this.reconciling && !force) return;
    if (this.reconciling) return;
    this.reconciling = true;

    try {
      let cursor = await this.store.getCursor();
      for (;;) {
        const changes: Change[] = await this.gql.changes(cursor, 200);
        if (changes.length === 0) break;

        for (const change of changes) {
          const result = await this.applyChange(
            change.entity,
            change.id,
            change.changeType,
            change.version,
          );
          await this.store.setCursor(change.seq);
          cursor = change.seq;

          if (result !== 'skipped') {
            this.stats.reconcilesApplied += 1;
            await this.store.recordEvent({
              kind: `reconcile-${result}`,
              entity: change.entity,
              entityId: change.id,
              version: change.version,
              seq: change.seq,
            });
          }
        }

        if (changes.length < 200) break;
      }

      this.stats.reconciles += 1;
      this.stats.lastReconcileAt = new Date().toISOString();
    } catch (error) {
      this.stats.lastError = `reconcile: ${(error as Error).message}`;
    } finally {
      this.reconciling = false;
    }
  }

  /** Idempotent: message lặp, sai thứ tự hay đến muộn đều vô hại. */
  private async applyChange(
    entity: string,
    id: string,
    changeType: ChangeTypeName,
    version: number,
  ): Promise<Applied> {
    const meta = this.entityMeta(entity);
    if (!meta) return 'skipped';

    const current = await this.store.getVersion(entity, id);

    if (changeType === 'DELETED') {
      if (current !== null && current >= version) return 'skipped';
      const removed = await this.store.remove(entity, id, version);
      this.stats.deleted += 1;
      return removed ? 'deleted' : 'skipped';
    }

    const pulled: PulledEntity | null = await this.gql.pull(meta, id);
    if (!pulled) {
      // Đã bị xoá trước khi kịp kéo. Ghi tombstone theo version của change để
      // một `pull` chậm hơn không thể chèn lại bản ghi đã chết.
      const removed = await this.store.remove(entity, id, version);
      return removed ? 'deleted' : 'skipped';
    }

    const pulledVersion = Number(pulled.version);
    if (current !== null && pulledVersion <= current) {
      this.stats.skipped += 1;
      return 'skipped';
    }

    const written = await this.store.upsert(entity, id, pulledVersion, pulled);
    if (!written) {
      this.stats.skipped += 1;
      return 'skipped';
    }
    this.stats.applied += 1;
    return 'applied';
  }

  private entityMeta(entity: string): EntityMeta | undefined {
    return contractByView[this.config.view].entities[entity];
  }
}
