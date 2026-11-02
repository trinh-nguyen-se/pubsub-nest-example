import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const resolve = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@pubsub/contract': resolve('./packages/api-contract/src/index.ts'),
      '@pubsub/consumer-kit': resolve('./packages/consumer-kit/src/index.ts'),
    },
  },
  test: {
    include: ['apps/**/test/**/*.test.ts', 'packages/**/test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // test chạm cùng một Postgres nên chạy tuần tự cho kết quả tất định
    fileParallelism: false,
  },
});
