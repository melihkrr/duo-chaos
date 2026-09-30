'use client'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Tekil Supabase istemcisi.
 * Env değişkenleri yoksa null döner; oyun yerel (offline) moda düşer.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

export const hasSupabase = Boolean(url && key)

let client: SupabaseClient | null = null

export const getSupabase = (): SupabaseClient | null => {
  if (!hasSupabase) return null
  if (client) return client
  client = createClient(url as string, key as string, {
    realtime: { params: { eventsPerSecond: 20 } },
    auth: { persistSession: false },
  })
  return client
}

/** RPC çağrısı; istemci yoksa null döner. */
export const rpc = async <T = unknown>(
  fn: string,
  args?: Record<string, unknown>,
): Promise<T | null> => {
  const supabase = getSupabase()
  if (!supabase) return null
  const { data, error } = await supabase.rpc(fn, args ?? {})
  if (error) throw new Error(`${fn}: ${error.message}`)
  return (data as T) ?? null
}
