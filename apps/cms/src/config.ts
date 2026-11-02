import type { View } from '@pubsub/contract';
import type { FenceStrategy } from './sync/fence';

export const CONFIG = Symbol('CMS_CONFIG');
export type { FenceStrategy };

export type AppConfig = {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  adminToken: string;
  tokens: Record<View, string>;
  channels: Record<View, string>;
  fence: FenceStrategy;
  publishAdapter: 'redis' | 'sns';
  publishIntervalMs: number;
  retentionDays: number;
  introspection: boolean;
};

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const fence = (env.FENCE_STRATEGY ?? 'advisory') as FenceStrategy;

  if (fence === ('txid' as FenceStrategy)) {
    throw new Error(
      'FENCE_STRATEGY=txid không dùng được với cursor seq. ' +
        'Lý do + phương án thay thế: docs/fence-investigation.md. ' +
        'Dùng advisory (mặc định) hoặc none (bài lab).',
    );
  }
  if (!['advisory', 'none'].includes(fence)) {
    throw new Error(`FENCE_STRATEGY không hợp lệ: ${fence}. Chọn advisory | none.`);
  }

  const publishAdapter = (env.PUBLISH_ADAPTER ?? 'redis') as AppConfig['publishAdapter'];
  if (!['redis', 'sns'].includes(publishAdapter)) {
    throw new Error(`PUBLISH_ADAPTER không hợp lệ: ${publishAdapter}`);
  }

  const config: AppConfig = {
    databaseUrl: env.DATABASE_URL ?? 'postgres://demo:demo@localhost:45432/cms',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:46379',
    port: num(env.CMS_PORT, 3001),
    adminToken: env.ADMIN_TOKEN ?? 'admin-dev-token',
    tokens: {
      b2b: env.B2B_TOKEN ?? 'b2b-dev-token',
      b2c: env.B2C_TOKEN ?? 'b2c-dev-token',
    },
    channels: {
      b2b: env.CHANNEL_B2B ?? 'cms.sync.b2b',
      b2c: env.CHANNEL_B2C ?? 'cms.sync.b2c',
    },
    fence,
    publishAdapter,
    publishIntervalMs: num(env.PUBLISH_INTERVAL_MS, 250),
    retentionDays: num(env.CHANGE_RETENTION_DAYS, 30),
    introspection: (env.GRAPHQL_INTROSPECTION ?? 'true') !== 'false',
  };

  assertProductionSafety(config, env);
  return config;
}

const DEV_TOKENS = new Set(['admin-dev-token', 'b2b-dev-token', 'b2c-dev-token']);

/**
 * Token mặc định chỉ dành cho local. Deploy production mà quên đặt token thì
 * phải chết lúc khởi động, không phải mở cửa cho người lạ ghi/xoá CMS.
 */
function assertProductionSafety(config: AppConfig, env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'production') return;

  const tokens: Array<[string, string]> = [
    ['ADMIN_TOKEN', config.adminToken],
    ['B2B_TOKEN', config.tokens.b2b],
    ['B2C_TOKEN', config.tokens.b2c],
  ];

  for (const [name, value] of tokens) {
    if (value.length === 0 || DEV_TOKENS.has(value)) {
      throw new Error(`${name} đang dùng giá trị dev/rỗng — production phải đặt token riêng`);
    }
  }
}
