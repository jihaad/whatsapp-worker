import { defineConfig } from 'prisma/config';

try { process.loadEnvFile('.env'); } catch { /* file may not exist in prod */ }
try { process.loadEnvFile('.env.local'); } catch { /* optional override */ }

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DIRECT_URL,
  },
});
