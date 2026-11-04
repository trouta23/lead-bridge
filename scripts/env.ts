// Shared by the admin scripts. The mod parses the same KEY=value format in hooks/register.ts
// (parseEnv); keep the two in step.
import { readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export const SCRIPTS_DIR = new URL('.', import.meta.url)

export function readEnv(file: URL): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (match?.[1] && match[2] !== undefined) vars[match[1]] = match[2]
  }
  return vars
}

export type AdminEnv = { url: string; secretKey: string; publishableKey: string }

// The admin's scripts/.env.local: the project URL, secret key and publishable key.
export function adminEnv(): AdminEnv {
  const env = readEnv(new URL('.env.local', SCRIPTS_DIR))
  const url = env.SUPABASE_URL
  const secretKey = env.SUPABASE_SECRET_KEY
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY
  if (!url || !secretKey || !publishableKey) {
    throw new Error('scripts/.env.local needs SUPABASE_URL, SUPABASE_SECRET_KEY and SUPABASE_PUBLISHABLE_KEY')
  }
  return { url, secretKey, publishableKey }
}

// A client with the secret key, which bypasses Row Level Security: admin scripts only.
export function adminClient(env: AdminEnv): SupabaseClient {
  return createClient(env.url, env.secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
}

export const agentFile = (id: string): URL => new URL(`agents/${id}.env`, SCRIPTS_DIR)
