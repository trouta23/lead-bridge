import { expect, mock, test } from 'claude-code/testing'

const OPTIONS = { agentId: 'lead-a', teamPrefix: 'a-', supabaseUrl: 'https://bridge.test', supabaseSecretKey: 'sb_secret_test', pollSeconds: 5 }

type Row = Record<string, unknown>

// A fake Supabase REST API, answering the mod's $.http.fetch calls from memory.
function fakeSupabase() {
  const db = { messages: [] as Row[], status: [] as Row[], calls: [] as { method: string; url: string; body?: string }[] }
  const respond = (value: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(value) } })
  const handler = (_: unknown, e: { url: string; init?: { method?: string; body?: string } }) => {
    const method = e.init?.method ?? 'GET'
    db.calls.push({ method, url: e.url, body: e.init?.body })
    const path = e.url.replace('https://bridge.test/rest/v1/', '')
    if (method === 'GET' && path.startsWith('agent_messages')) return respond(db.messages.filter(m => !m.read_at))
    if (method === 'GET' && path.startsWith('agent_status')) return respond(db.status)
    if (method === 'PATCH' && path.startsWith('agent_messages?id=in.')) {
      const ids = path.match(/in\.\(([\d,]+)\)/)![1].split(',').map(Number)
      for (const m of db.messages) if (ids.includes(m.id as number)) m.read_at = 'now'
      return respond(null)
    }
    if (method === 'POST' && path === 'agent_messages') {
      const row = { id: db.messages.length + 100, ...JSON.parse(e.init!.body!) }
      db.messages.push(row)
      return respond([row])
    }
    if (method === 'POST' && path === 'rpc/claim_issue') return respond('lead-b')
    return { value: { status: 404, ok: false, headers: {}, text: 'not found' } }
  }
  return { db, handler }
}

function engine(on: Parameters<Parameters<typeof test>[1]>[1], supabase: ReturnType<typeof fakeSupabase>) {
  const submitted: string[] = []
  on('ui.status', () => ({ value: undefined }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__lead-bridge__${(e as { name: string }).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', supabase.handler as never)
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  return { submitted }
}

test('a message for this lead becomes one turn, and is marked read only after the turn starts', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on)
  const supabase = fakeSupabase()
  supabase.db.messages.push({ id: 1, thread_id: null, supersedes: null, from_agent: 'lead-b', to_agent: 'lead-a', kind: 'ask', body: 'which table holds status?', refs: {}, read_at: null })
  const { submitted } = engine(on, supabase)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)

  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('[ASK] #1 thread 1 from lead-b to lead-a: which table holds status?')
  const methods = supabase.db.calls.map(c => c.method)
  expect(methods.indexOf('PATCH')).toBeGreaterThan(-1)
  expect(supabase.db.messages[0].read_at).toBe('now')

  await clock.advance(5000)
  expect(submitted.length).toBe(1)
})

test('a superseded message is left out of the turn but still marked read', { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on)
  const supabase = fakeSupabase()
  supabase.db.messages.push(
    { id: 1, thread_id: null, supersedes: null, from_agent: 'ci', to_agent: 'all', kind: 'blocked', body: 'main is red', refs: {}, read_at: null },
    { id: 2, thread_id: null, supersedes: 1, from_agent: 'ci', to_agent: 'all', kind: 'fyi', body: 'main is green', refs: {}, read_at: null },
  )
  const { submitted } = engine(on, supabase)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)

  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('(replaces #1): main is green')
  expect(submitted[0]).not.toContain('main is red')
  expect(supabase.db.messages.every(m => m.read_at === 'now')).toBe(true)
})

test("a dropped turn leaves the message unread, so the next poll retries it", { options: OPTIONS }, async ($, on) => {
  const clock = mock.clock(on)
  const supabase = fakeSupabase()
  supabase.db.messages.push({ id: 7, thread_id: null, supersedes: null, from_agent: 'lead-b', to_agent: 'lead-a', kind: 'handoff', body: 'take #14', refs: {}, read_at: null })
  let drops = 1
  on('ui.status', () => ({ value: undefined }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__lead-bridge__${(e as { name: string }).name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', supabase.handler as never)
  const submitted: string[] = []
  on('prompt.submit', (_, e) => {
    if (drops-- > 0) return { drop: 'was removed from the queue before it ran' } as never
    submitted.push(e.text)
    return { text: e.text }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5000)
  expect(supabase.db.messages[0].read_at).toBe(null)
  await clock.advance(5000)
  expect(submitted.length).toBe(1)
  expect(supabase.db.messages[0].read_at).toBe('now')
})

test('the send tool posts a row as this lead, and claim reports the holder', { options: OPTIONS }, async ($, on) => {
  mock.clock(on)
  const supabase = fakeSupabase()
  engine(on, supabase)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const sent = await $.tool.call({ tool: 'mcp__lead-bridge__send', to: 'lead-b', kind: 'fyi', body: 'renamed startsAt' } as never)
  expect(JSON.stringify(sent)).toContain('sent as message 100')
  expect(supabase.db.messages[0]).toMatchObject({ from_agent: 'lead-a', to_agent: 'lead-b', kind: 'fyi' })

  const claim = await $.tool.call({ tool: 'mcp__lead-bridge__claim', issue: 7 } as never)
  expect(JSON.stringify(claim)).toContain('#7 is held by lead-b')
})
