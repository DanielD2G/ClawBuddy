import {
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3'
import { s3 } from '../lib/s3.js'
import { env } from '../env.js'

function isMissingBucketError(error: unknown) {
  const err = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } }
  return (
    err?.name === 'NotFound' ||
    err?.Code === 'NotFound' ||
    err?.Code === 'NoSuchBucket' ||
    err?.$metadata?.httpStatusCode === 404
  )
}

function isBucketAlreadyPresentError(error: unknown) {
  const err = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } }
  return (
    err?.name === 'BucketAlreadyOwnedByYou' ||
    err?.Code === 'BucketAlreadyOwnedByYou' ||
    err?.name === 'BucketAlreadyExists' ||
    err?.Code === 'BucketAlreadyExists' ||
    err?.$metadata?.httpStatusCode === 409
  )
}

export const storageService = {
  async ensureBucketExists() {
    try {
      await s3.send(
        new HeadBucketCommand({
          Bucket: env.MINIO_BUCKET,
        }),
      )
      return
    } catch (error) {
      if (!isMissingBucketError(error)) {
        throw error
      }
    }

    try {
      await s3.send(
        new CreateBucketCommand({
          Bucket: env.MINIO_BUCKET,
        }),
      )
    } catch (error) {
      if (!isBucketAlreadyPresentError(error)) {
        throw error
      }
    }
  },

  async upload(key: string, body: Buffer, contentType: string) {
    await s3.send(
      new PutObjectCommand({
        Bucket: env.MINIO_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    )
    return { key }
  },

  async download(key: string) {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: env.MINIO_BUCKET,
        Key: key,
      }),
    )
    return response.Body
  },

  async listObjects(prefix: string) {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: env.MINIO_BUCKET,
        Prefix: prefix,
      }),
    )
    return response.Contents ?? []
  },

  async deleteObject(key: string) {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: env.MINIO_BUCKET,
        Key: key,
      }),
    )
  },
}
