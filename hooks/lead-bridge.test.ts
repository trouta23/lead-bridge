import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SECRET = { agentId: 'lead-a', teamPrefix: 'a-', supabaseUrl: 'https://bridge.test', supabaseSecretKey: 'sb_secret_test', pollSeconds: 5, fyiBatchSeconds: 60 }
const SIGNED_IN = { agentId: 'lead-x', teamPrefix: 'x-', envFile: '/agents/lead-a.env', pollSeconds: 5, fyiBatchSeconds: 60 }
const ENV_FILE = 'SUPABASE_URL=https://bridge.test\nSUPABASE_PUBLISHABLE_KEY=sb_publishable_test\nBRIDGE_EMAIL=lead-a@agents.test\nBRIDGE_PASSWORD=pw\n'

type Row = Record<string, unknown>
type Call = { method: string; path: string; headers: Record<string, string>; body?: string }

const b64url = (s: string) =>
  btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
// A token like Supabase's: identity in app_metadata, as provision.mjs sets it.
const JWT = `x.${b64url(JSON.stringify({ app_metadata: { agent_id: 'lead-a', team_prefix: 'a-' } }))}.sig`

// A fake Supabase answering the mod's $.http.fetch calls from memory: inbox, receipts, sends,
// status, claims and sign-in.
function fakeSupabase(agent = 'lead-a') {
  const db = { messages: [] as Row[], reads: new Set<string>(), status: [] as Row[], calls: [] as Call[] }
  const ok = (value: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(value) } })
  const handler = (_: unknown, e: { url: string; init?: { method?: string; body?: string; headers?: Record<string, string> } }) => {
    const method = e.init?.method ?? 'GET'
    const path = e.url.replace('https://bridge.test/', '')
    db.calls.push({ method, path, headers: e.init?.headers ?? {}, body: e.init?.body })
    if (path.startsWith('auth/v1/token')) return ok({ access_token: JWT, refresh_token: 'r', expires_in: 3600 })
    if (path === 'rest/v1/rpc/inbox') return ok(db.messages.filter(m => !db.reads.has(`${m.id}:${agent}`) && m.from_agent !== agent))
    if (method === 'GET' && path.startsWith('rest/v1/agent_status')) return ok(db.status)
    if (method === 'POST' && path === 'rest/v1/message_reads') {
      for (const r of JSON.parse(e.init!.body!) as { message_id: number; agent: string }[]) db.reads.add(`${r.message_id}:${r.agent}`)
      return ok(null)
    }
    if (method === 'POST' && path === 'rest/v1/agent_messages') {
      const row = { id: db.messages.length + 100, ...JSON.parse(e.init!.body!) }
      db.messages.push(row)
      return ok([row])
    }
    if (method === 'POST' && path === 'rest/v1/rpc/claim_issue') return ok('lead-b')
    return { value: { status: 404, ok: false, headers: {}, text: 'not found' } }
  }
  return { db, handler }
}

function engine(on: On, supabase: ReturnType<typeof fakeSupabase>, drops = 0) {
  const submitted: string[] = []
  on('ui.status', () => ({ value: undefined }))
  on('fs.read', () => ({ value: ENV_FILE }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__lead-bridge__${(e as { name: string }).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', supabase.handler as never)
  on('prompt.submit', (_, e) => {
    if (drops-- > 0) return { drop: 'was removed from the queue before it ran' } as never
    submitted.push(e.text)
    return { text: e.text }
  })
  return { submitted }
}

const msg = (id: number, kind: string, extra: Row = {}, at = 0) => ({
  id, thread_id: null, supersedes: null, from_agent: 'lead-b', to_agent: 'lead-a', recipients: null,
  kind, body: `${kind} ${id}`, refs: {}, created_at: new Date(at).toISOString(), ...extra,
})
const start = ($: Parameters<Parameters<typeof test>[2] & {}>[0]) =>
  $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

test('a message becomes one turn, and its receipt is written only after the turn starts', { options: SECRET }, async ($, on) => {
  const clock = mock.clock(on)
  const supabase = fakeSupabase()
  supabase.db.messages.push(msg(1, 'ask'))
  const { submitted } = engine(on, supabase)

  await start($)
  await clock.advance(5000)

  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('[ASK] #1 thread 1 from lead-b to lead-a: ask 1')
  expect(supabase.db.reads.has('1:lead-a')).toBe(true)
  await clock.advance(5000)
  expect(submitted.length).toBe(1)
})

test('a superseded message is left out of the turn, and both get receipts', { options: SECRET }, async ($, on) => {
  const clock = mock.clock(on)
  const supabase = fakeSupabase()
  supabase.db.messages.push(msg(1, 'blocked', { from_agent: 'ci', to_agent: 'all', body: 'main is red' }), msg(2, 'ask', { from_agent: 'ci', to_agent: 'all', supersedes: 1, body: 'main is green' }))
  const { submitted } = engine(on, supabase)

  await start($)
  await clock.advance(5000)

  expect(submitted[0]).toContain('(replaces #1): main is green')
  expect(submitted[0]).not.toContain('main is red')
  expect(supabase.db.reads.has('1:lead-a') && supabase.db.reads.has('2:lead-a')).toBe(true)
})

test('a dropped turn writes no receipt, so the next poll retries it', { options: SECRET }, async ($, on) => {
  const clock = mock.clock(on)
  const supabase = fakeSupabase()
  supabase.db.messages.push(msg(7, 'handoff'))
  const { submitted } = engine(on, supabase, 1)

  await start($)
  await clock.advance(5000)
  expect(supabase.db.reads.size).toBe(0)
  await clock.advance(5000)
  expect(submitted.length).toBe(1)
  expect(supabase.db.reads.has('7:lead-a')).toBe(true)
})

test('a lone fyi waits for the batch window; an ask delivers it at once', { options: SECRET }, async ($, on) => {
  const clock = mock.clock(on)
  const supabase = fakeSupabase()
  const { submitted } = engine(on, supabase)
  await start($)

  supabase.db.messages.push(msg(1, 'fyi', {}, clock.now()))
  await clock.advance(5000)
  expect(submitted.length).toBe(0)
  await clock.advance(60_000)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('[FYI] #1')

  supabase.db.messages.push(msg(2, 'fyi', {}, clock.now()))
  await clock.advance(5000)
  expect(submitted.length).toBe(1)
  supabase.db.messages.push(msg(3, 'ask', {}, clock.now()))
  await clock.advance(5000)
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('[FYI] #2')
  expect(submitted[1]).toContain('[ASK] #3')
})

test('signed in: identity comes from the token, not the options, and every call carries it', { options: SIGNED_IN }, async ($, on) => {
  const clock = mock.clock(on)
  const supabase = fakeSupabase()
  supabase.db.messages.push(msg(1, 'ask'))
  const { submitted } = engine(on, supabase)

  await start($)
  const sent = await $.tool.call({ tool: 'mcp__lead-bridge__send', to: 'lead-b', kind: 'fyi', body: 'hi' } as never)
  expect(JSON.stringify(sent)).toContain('sent as message')
  expect(supabase.db.messages.at(-1)).toMatchObject({ from_agent: 'lead-a' })

  await clock.advance(5000)
  expect(submitted[0]).toContain('Bridge update for lead-a')
  const inbox = supabase.db.calls.find(c => c.path === 'rest/v1/rpc/inbox')!
  expect(inbox.body).toBe('{}')
  expect(inbox.headers.Authorization).toBe(`Bearer ${JWT}`)
  expect(inbox.headers.apikey).toBe('sb_publishable_test')
  expect(supabase.db.reads.has('1:lead-a')).toBe(true)
})

test('sending to several agents makes one group message; claim reports the holder', { options: SECRET }, async ($, on) => {
  mock.clock(on)
  const supabase = fakeSupabase()
  engine(on, supabase)
  await start($)

  await $.tool.call({ tool: 'mcp__lead-bridge__send', to: 'lead-b, lead-c', kind: 'ask', body: 'which approach?' } as never)
  expect(supabase.db.messages[0]).toMatchObject({ from_agent: 'lead-a', to_agent: 'group', recipients: ['lead-b', 'lead-c'] })

  const claim = await $.tool.call({ tool: 'mcp__lead-bridge__claim', issue: 7 } as never)
  expect(JSON.stringify(claim)).toContain('#7 is held by lead-b')
})
