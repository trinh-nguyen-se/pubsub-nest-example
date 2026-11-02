import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import type { ChangeMessage, ChangePublisher } from './change-message';

/** Local: Redis pub/sub. Không bền — mất message là chuyện bình thường, changes() sẽ bù. */
export class RedisChangePublisher implements ChangePublisher {
  readonly kind = 'redis';

  constructor(private readonly redis: Redis) {}

  async publish(channels: string[], message: ChangeMessage): Promise<void> {
    const payload = JSON.stringify(message);
    await Promise.all(channels.map((channel) => this.redis.publish(channel, payload)));
  }
}

/**
 * AWS final: SNS → SQS (mỗi consumer một queue), DLQ, mã hoá, queue policy
 * theo ARN topic. Chưa làm — cắm vào đây, phần còn lại của hệ thống không đổi.
 */
export class SnsChangePublisher implements ChangePublisher {
  readonly kind = 'sns';
  private readonly logger = new Logger(SnsChangePublisher.name);

  async publish(_channels: string[], _message: ChangeMessage): Promise<void> {
    this.logger.error('SnsChangePublisher chưa triển khai — xem docs/aws-later.md');
    throw new Error(
      'SnsChangePublisher chưa triển khai. Đặt PUBLISH_ADAPTER=redis cho môi trường local.',
    );
  }
}
