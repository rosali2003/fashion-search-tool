import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { sql } from 'kysely'
import { db } from '../db/index.js'
import { hashToken } from './security.js'

export async function takeLimit(key: string, limit: number, seconds: number): Promise<boolean> {
  const now = new Date()
  const expiry = new Date(now.getTime() + seconds * 1000)
  const result = await db.insertInto('auth_limits').values({ key: hashToken(key), hits: 1, expires_at: expiry })
    .onConflict(conflict => conflict.column('key').doUpdateSet({
      hits: sql`case when auth_limits.expires_at <= ${now} then 1 else auth_limits.hits + 1 end`,
      expires_at: sql`case when auth_limits.expires_at <= ${now} then ${expiry} else auth_limits.expires_at end`,
    })).returning('hits').executeTakeFirstOrThrow()
  return result.hits <= limit
}

function clientAddress(context: Context): string {
  const header = process.env.AUTH_TRUSTED_IP_HEADER
  if (header) return context.req.header(header)?.split(',')[0]?.trim() ?? 'unknown'
  try { return getConnInfo(context).remote.address ?? 'unknown' } catch { return 'unknown' }
}

export async function allowEmail(context: Context, email: string, action: 'send' | 'check'): Promise<boolean> {
  const send = action === 'send'
  if (!await takeLimit(`${action}:global`, send ? 200 : 1000, 3600)) return false
  if (!await takeLimit(`${action}:ip:${clientAddress(context)}`, send ? 20 : 60, send ? 3600 : 600)) return false
  if (!await takeLimit(`${action}:email:${email}`, send ? 5 : 20, send ? 3600 : 600)) return false
  return !send || await takeLimit(`cooldown:${email}`, 1, 60)
}
