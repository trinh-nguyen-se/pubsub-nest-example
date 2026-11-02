import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

const CMS = process.env.CMS_GRAPHQL_URL ?? 'http://localhost:3001';
const B2C = `http://localhost:${process.env.CONSUMER_B2C_PORT ?? 3003}`;

/**
 * Token máy-với-máy KHÔNG nằm trong bundle. Proxy của dev server gắn header
 * khi gọi sang CMS — browser không bao giờ thấy token.
 */
const withHeader = (target: string, headers: Record<string, string>): ProxyOptions => ({
  target,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on('proxyReq', (request) => {
      for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);
    });
  },
});

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/graphql': withHeader(CMS, {
        authorization: `Bearer ${process.env.B2C_TOKEN ?? 'b2c-dev-token'}`,
      }),
      '/admin': withHeader(CMS, { 'x-admin-token': process.env.ADMIN_TOKEN ?? 'admin-dev-token' }),
      '/mirror': withHeader(B2C, {}),
    },
  },
});
