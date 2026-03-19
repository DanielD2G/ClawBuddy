import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'crypto'
import { env } from '../env.js'

const ALGORITHM = 'aes-256-gcm'
const SALT = process.env.ENCRYPTION_SALT || 'clawbuddy-api-key-encryption'

// Derive key once at startup
const key = scryptSync(env.ENCRYPTION_SECRET, SALT, 32)

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':')
}

export function decrypt(stored: string): string {
  const [ivB64, tagB64, dataB64] = stored.split(':')
  const iv = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const data = Buffer.from(dataB64, 'base64')
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}
