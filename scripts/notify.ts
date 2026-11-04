// Sends one bridge message as a signed-in agent, with no dependencies, for CI and other scripts.
//   node --env-file=agents/ci.env notify.ts <to> <kind> <body> [thread-id]
// Reads SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, BRIDGE_EMAIL and BRIDGE_PASSWORD from the
// environment (in GitHub Actions, from secrets). The sender is whoever the sign-in says it is.
// <to> is addressed as the mod's send tool does it (hooks/register.ts): an id, a comma list, or all.

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

async function call(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init)
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).pathname}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

const USAGE = 'usage: node notify.ts <to> <kind> <body> [thread-id]'
const [to, kind, body, thread] = process.argv.slice(2)
try {
  if (!to || !kind || !body) throw new Error(USAGE)
  if (thread !== undefined && !/^\d+$/.test(thread))
    throw new Error(`thread-id must be a message number, not "${thread}"`)
  const url = required('SUPABASE_URL').replace(/\/$/, '')
  const headers = { apikey: required('SUPABASE_PUBLISHABLE_KEY'), 'Content-Type': 'application/json' }

  const token = (await call(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: required('BRIDGE_EMAIL'), password: required('BRIDGE_PASSWORD') }),
  })) as { access_token: string }
  const payload = JSON.parse(Buffer.from(token.access_token.split('.')[1] ?? '', 'base64url').toString('utf8'))
  const from: unknown = payload.app_metadata?.agent_id
  if (typeof from !== 'string') throw new Error('this sign-in has no agent identity; create it with provision.ts')

  const names = to
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)
  const addressing =
    names.length > 1 ? { to_agent: 'group', recipients: names } : { to_agent: names[0], recipients: null }
  const [row] = (await call(`${url}/rest/v1/agent_messages`, {
    method: 'POST',
    headers: { ...headers, Authorization: `Bearer ${token.access_token}`, Prefer: 'return=representation' },
    body: JSON.stringify({ from_agent: from, ...addressing, kind, body, thread_id: thread ? Number(thread) : null }),
  })) as { id: number }[]
  console.log(`sent as ${from}, message ${row?.id}`)
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
