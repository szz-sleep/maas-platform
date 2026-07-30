import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: './prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL || 'postgresql://suzhenzhong@localhost:5432/maas_platform',
  },
  migrations: {
    path: './prisma/migrations',
  },
});