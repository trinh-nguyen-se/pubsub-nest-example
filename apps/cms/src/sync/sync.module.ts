import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import type { Pool } from 'pg';
import { CONFIG, type AppConfig } from '../config';
import { PG_POOL } from '../db/database.module';
import { CHANGE_PUBLISHER, makeMessage, type ChangePublisher } from './change-message';
import { selectPending } from './fence';
import { RedisChangePublisher, SnsChangePublisher } from './publishers';

export const REDIS = Symbol('REDIS');

export type PublisherStats = {
  adapter: string;
  published: number;
  failures: number;
  lastPublishedSeq: number;
  lastError: string | null;
  lastTickAt: string | null;
};

/**
 * Worker nền: đọc outbox chưa gửi → phát message → đánh dấu đã gửi.
 *
 * Đánh dấu SAU khi phát, nên nếu crash giữa hai bước thì message bị gửi lặp.
 * Đó là at-least-once có chủ ý: consumer lọc theo version nên lặp vô hại,
 * còn mất message thì phải bù bằng changes().
 */
@Injectable()
export class PublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherWorker.name);
  private timer?: NodeJS.Timeout;
  private busy = false;

  readonly stats: PublisherStats = {
    adapter: 'unknown',
    published: 0,
    failures: 0,
    lastPublishedSeq: 0,
    lastError: null,
    lastTickAt: null,
  };

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CHANGE_PUBLISHER) private readonly publisher: ChangePublisher,
  ) {
    this.stats.adapter = publisher.kind;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), this.config.publishIntervalMs);
    this.timer.unref();
    this.logger.log(`publisher ${this.publisher.kind} · mỗi ${this.config.publishIntervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.drain();
    } catch (error) {
      this.stats.lastError = error instanceof Error ? error.message : String(error);
      this.logger.error(`vòng publish lỗi: ${this.stats.lastError}`);
    } finally {
      this.busy = false;
      this.stats.lastTickAt = new Date().toISOString();
    }
  }

  private async drain(): Promise<void> {
    const pending = await selectPending(this.pool, { limit: 100 });
    if (pending.length === 0) return;

    const channels = Object.values(this.config.channels);
    const sent: number[] = [];

    for (const row of pending) {
      const message = makeMessage({
        entity: row.entity,
        id: row.entityId,
        version: row.version,
        changeType: row.changeType.toUpperCase() as 'CREATED' | 'UPDATED' | 'DELETED',
        seq: row.seq,
      });

      try {
        await this.publisher.publish(channels, message);
        sent.push(row.seq);
        this.stats.lastPublishedSeq = row.seq;
      } catch (error) {
        this.stats.failures += 1;
        this.stats.lastError = error instanceof Error ? error.message : String(error);
        this.logger.warn(`publish seq ${row.seq} lỗi, giữ lại để thử tiếp: ${this.stats.lastError}`);
        // giữ thứ tự: dừng batch, vòng sau gửi lại từ dòng này
        break;
      }
    }

    if (sent.length > 0) {
      await this.pool.query(
        'update sync_change set published_at = now() where seq = any($1::bigint[])',
        [sent],
      );
      this.stats.published += sent.length;
    }

    if (pending.length === 100) setImmediate(() => void this.tick());
  }
}

@Injectable()
export class RedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

@Module({
  providers: [
    {
      provide: REDIS,
      inject: [CONFIG],
      useFactory: (config: AppConfig): Redis =>
        new Redis(config.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false }),
    },
    {
      provide: CHANGE_PUBLISHER,
      inject: [CONFIG, REDIS],
      useFactory: (config: AppConfig, redis: Redis): ChangePublisher =>
        config.publishAdapter === 'sns' ? new SnsChangePublisher() : new RedisChangePublisher(redis),
    },
    PublisherWorker,
    RedisLifecycle,
  ],
  exports: [CHANGE_PUBLISHER, PublisherWorker],
})
export class SyncModule {}
