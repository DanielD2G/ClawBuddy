const requiredEnvDefaults: Record<string, string> = {
  DATABASE_URL: 'postgresql://clawbuddy:clawbuddy@localhost:5433/clawbuddy',
  REDIS_URL: 'redis://localhost:6380',
  QDRANT_URL: 'http://localhost:6333',
  MINIO_ENDPOINT: 'http://localhost:9000',
  MINIO_ACCESS_KEY: 'clawbuddy',
  MINIO_SECRET_KEY: 'clawbuddy123',
  MINIO_BUCKET: 'clawbuddy',
  ENCRYPTION_SECRET: 'vitest-encryption-secret',
}

for (const [key, value] of Object.entries(requiredEnvDefaults)) {
  if (!process.env[key]) {
    process.env[key] = value
  }
}
