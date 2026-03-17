import {
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { s3 } from '../lib/s3.js'
import { env } from '../env.js'

export const storageService = {
  async upload(key: string, body: Buffer, contentType: string) {
    await s3.send(
      new PutObjectCommand({
        Bucket: env.MINIO_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    )
    return { key }
  },

  async download(key: string) {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: env.MINIO_BUCKET,
        Key: key,
      })
    )
    return response.Body
  },

  async listObjects(prefix: string) {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: env.MINIO_BUCKET,
        Prefix: prefix,
      })
    )
    return response.Contents ?? []
  },

  async deleteObject(key: string) {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: env.MINIO_BUCKET,
        Key: key,
      })
    )
  },
}
