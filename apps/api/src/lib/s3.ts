import { S3Client } from '@aws-sdk/client-s3'
import { env } from '../env.js'

export const s3 = new S3Client({
  endpoint: env.MINIO_ENDPOINT,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.MINIO_ACCESS_KEY,
    secretAccessKey: env.MINIO_SECRET_KEY,
  },
})
