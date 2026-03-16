import { env } from '../env.js'

const url = new URL(env.REDIS_URL)

export const redisConnection = {
  host: url.hostname,
  port: Number(url.port) || 6379,
}
