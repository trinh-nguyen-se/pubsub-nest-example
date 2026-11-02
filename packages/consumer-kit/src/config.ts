import type { View } from '@pubsub/contract';

export type ConsumerConfig = {
  view: View;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  cmsGraphqlUrl: string;
  token: string;
  channel: string;
  /** schema Postgres riêng của consumer: b2b | b2c */
  schema: string;
  reconcileIntervalMs: number;
  /** mô phỏng mất message để thấy changes() bù lại */
  dropMessages: boolean;
};

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function loadConsumerConfig(
  view: View,
  env: NodeJS.ProcessEnv = process.env,
): ConsumerConfig {
  const upper = view.toUpperCase();
  return {
    view,
    port: num(env[`CONSUMER_${upper}_PORT`], view === 'b2b' ? 3002 : 3003),
    databaseUrl: env.DATABASE_URL ?? 'postgres://demo:demo@localhost:45432/cms',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:46379',
    cmsGraphqlUrl: env.CMS_GRAPHQL_URL ?? 'http://localhost:3001',
    token: env[`${upper}_TOKEN`] ?? `${view}-dev-token`,
    channel: env[`CHANNEL_${upper}`] ?? `cms.sync.${view}`,
    schema: env[`MIRROR_SCHEMA_${upper}`] ?? view,
    reconcileIntervalMs: num(env.RECONCILE_INTERVAL_MS, 1500),
    dropMessages: (env.DROP_MESSAGES ?? '0') === '1',
  };
}
