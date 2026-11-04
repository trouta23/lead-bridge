// Checks the bridge's security rules against a live project, signed in as throwaway agents
// (tv-1, tv-2, tv-3) and two users that aren't agents, then removes them and everything they wrote.
// Run: node verify.ts. Exits non-zero if any check fails.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { adminClient, adminEnv, agentFile, readEnv } from './env.ts'

const env = adminEnv()
const admin = adminClient(env)
const AGENTS = [
  ['tv-1', 't1-'],
  ['tv-2', 't2-'],
  ['tv-3', 't3-'],
] as const
const AGENT_IDS: string[] = AGENTS.map(([id]) => id)
const ISSUES = [9101, 9102, 9103]

const provision = (...args: string[]): string =>
  execFileSync('node', [new URL('provision.ts', import.meta.url).pathname, ...args], { encoding: 'utf8' })

async function signIn(email: string, password: string): Promise<SupabaseClient> {
  const client = createClient(env.url, env.publishableKey, { auth: { persistSession: false } })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign in ${email}: ${error.message}`)
  return client
}

async function signInAgent(id: string): Promise<SupabaseClient> {
  const creds = readEnv(agentFile(id))
  return signIn(creds.BRIDGE_EMAIL ?? '', creds.BRIDGE_PASSWORD ?? '')
}

// A signed-in user the registry doesn't vouch for: self-registered (no identity), or claiming an
// agent's identity under a different user, as a removed agent's leftover token would.
const outsiders: string[] = []
async function signInOutsider(appMetadata: Record<string, string>): Promise<SupabaseClient> {
  const email = `tv-outsider-${outsiders.length}@agents.lead-bridge.example.com`
  const password = randomBytes(24).toString('base64url')
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: appMetadata,
  })
  if (error) throw new Error(`create outsider: ${error.message}`)
  outsiders.push(data.user.id)
  return signIn(email, password)
}

type Row = Record<string, unknown>
type Result = { id: number | undefined; error: string | undefined; code: string | undefined }
const results: string[] = []
const created: number[] = []

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    results.push(`PASS  ${name}`)
  } catch (err) {
    results.push(`FAIL  ${name}: ${err instanceof Error ? err.message : err}`)
  }
}

async function send(client: SupabaseClient, row: Row): Promise<Result> {
  const { data, error } = await client.from('agent_messages').insert(row).select('id').single()
  if (data) created.push(data.id)
  return { id: data?.id, error: error?.message, code: error?.code }
}

async function inbox(client: SupabaseClient): Promise<number[]> {
  const { data, error } = await client.rpc('inbox')
  if (error) throw new Error(error.message)
  return (data as { id: number }[]).map(m => m.id)
}

async function claim(
  client: SupabaseClient,
  issue: number,
  options: { giveTo?: string; release?: boolean } = {},
): Promise<{ holder: unknown; error: string | undefined }> {
  const { data, error } = await client.rpc('claim_issue', {
    p_issue: issue,
    p_give_to: options.giveTo ?? null,
    p_release: options.release ?? false,
  })
  return { holder: data, error: error?.message }
}

async function rowsVisible(client: SupabaseClient, table: string): Promise<number> {
  const { data } = await client.from(table).select('*').limit(5)
  return data?.length ?? 0
}

// Leftovers from a run that crashed before cleaning up.
async function removeThrowawayAgents(): Promise<void> {
  const { data } = await admin.from('agents').select('id').in('id', AGENT_IDS)
  for (const { id } of data ?? []) provision('remove', id)
}

await removeThrowawayAgents()
try {
  for (const [id, prefix] of AGENTS) provision('add', id, prefix)
  const [t1, t2, t3] = [await signInAgent('tv-1'), await signInAgent('tv-2'), await signInAgent('tv-3')]
  const anon = createClient(env.url, env.publishableKey, { auth: { persistSession: false } })
  let dm: number | undefined
  let broadcast: number | undefined

  // Sending and reading ----------------------------------------------------------------------------

  await check('an agent cannot post as another agent', async () => {
    const spoof = await send(t1, { from_agent: 'tv-2', to_agent: 'tv-3', kind: 'fyi', body: 'spoof' })
    assert.ok(spoof.error, 'spoofed insert accepted')
  })

  await check('a direct message reaches its recipient and no third agent', async () => {
    const sent = await send(t1, { from_agent: 'tv-1', to_agent: 'tv-2', kind: 'ask', body: 'direct message' })
    assert.ok(!sent.error, sent.error)
    dm = sent.id
    assert.ok((await inbox(t2)).includes(dm!), "the recipient doesn't see it")
    const { data: peek } = await t3.from('agent_messages').select('id').eq('id', dm!)
    assert.equal(peek?.length, 0, 'a third agent can read it')
    assert.ok(!(await inbox(t3)).includes(dm!), "it's in a third agent's inbox")
  })

  await check('a broadcast stays unread for each agent until that agent reads it', async () => {
    broadcast = (await send(t3, { from_agent: 'tv-3', to_agent: 'all', kind: 'fyi', body: 'verify broadcast' })).id
    assert.ok((await inbox(t1)).includes(broadcast!), "tv-1 doesn't see the broadcast")
    const { error } = await t1.from('message_reads').insert({ message_id: broadcast, agent: 'tv-1' })
    assert.ok(!error, error?.message)
    assert.ok(!(await inbox(t1)).includes(broadcast!), 'still unread for tv-1 after reading it')
    assert.ok((await inbox(t2)).includes(broadcast!), 'tv-1 reading it hid it from tv-2')
  })

  await check("an agent cannot write a receipt for someone else, or for a message it can't see", async () => {
    assert.ok((await t1.from('message_reads').insert({ message_id: dm, agent: 'tv-2' })).error, 'receipt for tv-2')
    assert.ok((await t3.from('message_reads').insert({ message_id: dm, agent: 'tv-3' })).error, 'receipt, unseen')
  })

  await check('a group message reaches exactly its recipients', async () => {
    const sent = await send(t1, {
      from_agent: 'tv-1',
      to_agent: 'group',
      recipients: ['tv-2', 'tv-3'],
      kind: 'ask',
      body: 'group question',
    })
    assert.ok(!sent.error, sent.error)
    assert.ok((await inbox(t2)).includes(sent.id!) && (await inbox(t3)).includes(sent.id!), 'a recipient missed it')
    assert.ok(!(await inbox(t1)).includes(sent.id!), 'the sender got its own group message')
  })

  await check("a message to a teammate (t2-x) reaches that team's lead only", async () => {
    const { id } = await send(t1, { from_agent: 'tv-1', to_agent: 't2-x', kind: 'fyi', body: 'for your teammate' })
    assert.ok((await inbox(t2)).includes(id!), "tv-2 didn't get its teammate's message")
    assert.ok(!(await inbox(t3)).includes(id!), "tv-3 got another team's message")
  })

  await check("mail to nobody is refused, and 'all' or 'group' can't hide inside a group", async () => {
    const typo = await send(t1, { from_agent: 'tv-1', to_agent: 'tv-22', kind: 'fyi', body: 'typo' })
    assert.match(typo.error ?? '', /no agent or team is called tv-22/)
    const mixed = await send(t1, {
      from_agent: 'tv-1',
      to_agent: 'group',
      recipients: ['tv-2', 'all'],
      kind: 'fyi',
      body: 'mixed',
    })
    assert.ok(mixed.error, "a group naming 'all' was accepted")
  })

  await check("an agent can supersede its own message, not someone else's", async () => {
    const own = await send(t1, { from_agent: 'tv-1', to_agent: 'tv-2', kind: 'ask', body: 'fixed', supersedes: dm })
    assert.ok(!own.error, own.error)
    const hijack = await send(t3, { from_agent: 'tv-3', to_agent: 'tv-2', kind: 'fyi', body: 'x', supersedes: dm })
    assert.ok(hijack.error, "tv-3 superseded tv-1's message, hiding it from tv-2")
  })

  await check("clients can't choose a message's id or time, and sizes are capped", async () => {
    const backdated = await send(t1, {
      from_agent: 'tv-1',
      to_agent: 'tv-2',
      kind: 'fyi',
      body: 'backdated',
      created_at: '2000-01-01T00:00:00Z',
    })
    assert.equal(backdated.code, '42501', `a backdated message got ${backdated.code ?? 'accepted'}`)
    const huge = await send(t1, {
      from_agent: 'tv-1',
      to_agent: 'tv-2',
      kind: 'fyi',
      body: 'x',
      refs: { blob: 'x'.repeat(5000) },
    })
    assert.ok(huge.error, '5 KB of refs accepted')
    const plan = await t1.from('agent_status').upsert({ agent: 'tv-1', state: 'working', plan: 'x'.repeat(2001) })
    assert.ok(plan.error, 'a 2,001-character plan accepted')
  })

  // Status, claims, registry -----------------------------------------------------------------------

  await check("status: an agent sets its own and its teammates' rows, not another team's", async () => {
    assert.ok(!(await t1.from('agent_status').upsert({ agent: 'tv-1', state: 'working', task: 'verify' })).error)
    assert.ok(!(await t1.from('agent_status').upsert({ agent: 't1-2', state: 'working', task: 'teammate' })).error)
    assert.ok((await t1.from('agent_status').upsert({ agent: 'tv-2', state: 'idle' })).error, "wrote tv-2's status")
    assert.ok((await t1.from('agent_status').upsert({ agent: 't2-x', state: 'idle' })).error, "wrote a tv-2 teammate's")
  })

  await check('saving the same status again keeps its time, so nobody is notified twice', async () => {
    const row = { agent: 'tv-1', state: 'working', task: 'verify' }
    const { data: before } = await t1.from('agent_status').upsert(row).select('updated_at').single()
    await new Promise(resolve => setTimeout(resolve, 1100))
    const { data: same } = await t1.from('agent_status').upsert(row).select('updated_at').single()
    assert.equal(same?.updated_at, before?.updated_at, 'an unchanged status got a new time')
    const { data: changed } = await t1
      .from('agent_status')
      .upsert({ ...row, task: 'next' })
      .select('updated_at')
      .single()
    assert.notEqual(changed?.updated_at, before?.updated_at, 'a changed status kept its old time')
  })

  await check('claims: the first claim wins; only the holder can hand it on or release it', async () => {
    assert.equal((await claim(t1, 9101)).holder, 'tv-1')
    assert.equal((await claim(t2, 9101)).holder, 'tv-1', "a second claim didn't report the holder")
    assert.match((await claim(t2, 9101, { giveTo: 'tv-2' })).error ?? '', /you don't hold #9101: tv-1 does/)
    assert.match((await claim(t2, 9102, { giveTo: 'tv-1' })).error ?? '', /nobody does/)
    assert.match((await claim(t1, 9101, { giveTo: 'nobody' })).error ?? '', /no agent is called nobody/)
    assert.match((await claim(t2, 9101, { release: true })).error ?? '', /you don't hold #9101/)
    assert.equal((await claim(t1, 9101, { giveTo: 'tv-2' })).holder, 'tv-2', "the holder couldn't hand it over")
    assert.equal((await claim(t2, 9101, { release: true })).holder, null, "the holder couldn't release it")
  })

  await check('the registry is readable but not writable by agents', async () => {
    const { data } = await t1.from('agents').select('id')
    assert.ok(data?.some(a => a.id === 'tv-2'))
    const { data: tv2 } = await admin.from('agents').select('user_id').eq('id', 'tv-2').single()
    const { error } = await t1.from('agents').insert({ id: 'rogue', team_prefix: 'rogue-', user_id: tv2?.user_id })
    assert.equal(error?.code, '42501', `registering an agent got ${error?.code ?? 'accepted'}`)
  })

  await check("messages and receipts can't be edited or deleted, even by their author", async () => {
    await t2.from('message_reads').insert({ message_id: dm, agent: 'tv-2' })
    await t1.from('agent_messages').update({ body: 'rewritten' }).eq('id', dm!)
    await t1.from('agent_messages').delete().eq('id', dm!)
    await t2.from('message_reads').delete().eq('agent', 'tv-2')
    await t1.from('agent_status').delete().eq('agent', 'tv-1')
    const { data: message } = await admin.from('agent_messages').select('body').eq('id', dm!).single()
    assert.equal(message?.body, 'direct message', 'the author changed or deleted a sent message')
    const { count: reads } = await admin
      .from('message_reads')
      .select('*', { count: 'exact', head: true })
      .eq('agent', 'tv-2')
    assert.ok((reads ?? 0) > 0, 'an agent deleted its receipts')
    const { count: rows } = await admin
      .from('agent_status')
      .select('*', { count: 'exact', head: true })
      .eq('agent', 'tv-1')
    assert.equal(rows, 1, 'an agent deleted its status row')
  })

  // Who counts as an agent ---------------------------------------------------------------------------

  await check('signed out, the publishable key reads, sends and claims nothing', async () => {
    for (const table of ['agent_messages', 'agent_status', 'claims', 'agents']) {
      assert.equal(await rowsVisible(anon, table), 0, `read ${table} signed out`)
    }
    assert.ok((await send(anon, { from_agent: 'tv-1', to_agent: 'tv-2', kind: 'fyi', body: 'anon' })).error, 'sent')
    assert.ok((await claim(anon, 9102)).error, 'claimed signed out')
  })

  await check('a signed-in user with no agent identity (a self sign-up) sees and does nothing', async () => {
    const stranger = await signInOutsider({})
    for (const table of ['agent_messages', 'agent_status', 'claims', 'agents']) {
      assert.equal(await rowsVisible(stranger, table), 0, `a stranger read ${table}`)
    }
    assert.ok((await claim(stranger, 9102)).error, 'a stranger claimed an issue')
  })

  await check("a user claiming an agent's identity without being that agent's user gets nothing", async () => {
    const impostor = await signInOutsider({ agent_id: 'tv-1', team_prefix: 't1-' })
    assert.equal(await rowsVisible(impostor, 'agent_messages'), 0, "the impostor read tv-1's mail")
    assert.deepEqual(await inbox(impostor), [], "the impostor opened tv-1's inbox")
    const sent = await send(impostor, { from_agent: 'tv-1', to_agent: 'tv-2', kind: 'fyi', body: 'impostor' })
    assert.ok(sent.error, 'the impostor sent as tv-1')
  })

  await check("editing your own profile doesn't change who you are", async () => {
    await t1.auth.updateUser({ data: { agent_id: 'tv-2', team_prefix: 't2-' } })
    await t1.auth.refreshSession()
    const promoted = await send(t1, { from_agent: 'tv-2', to_agent: 'tv-3', kind: 'fyi', body: 'self-promoted' })
    assert.ok(promoted.error, 'user_metadata changed the identity')
    const sent = await send(t1, { from_agent: 'tv-1', to_agent: 'tv-3', kind: 'fyi', body: 'still tv-1' })
    assert.ok(!sent.error, sent.error)
  })

  await check(
    "rate limit: an agent's 21st message in a minute is refused, and other agents aren't slowed",
    async () => {
      let refusal: string | undefined
      for (let i = 0; i < 25 && !refusal; i++) {
        refusal = (await send(t3, { from_agent: 'tv-3', to_agent: 'tv-1', kind: 'fyi', body: `burst ${i}` })).error
      }
      assert.match(refusal ?? '', /rate limit/, '25 messages in a row were accepted')
      const { count } = await admin
        .from('agent_messages')
        .select('*', { count: 'exact', head: true })
        .eq('from_agent', 'tv-3')
        .gt('created_at', new Date(Date.now() - 60_000).toISOString())
      assert.ok((count ?? 0) <= 20, `${count} messages got through in a minute`)
      const sent = await send(t2, { from_agent: 'tv-2', to_agent: 'tv-1', kind: 'fyi', body: 'not limited' })
      assert.ok(!sent.error, sent.error)
    },
  )

  await check("a removed agent's claims are freed and its unexpired token stops working", async () => {
    assert.equal((await claim(t3, 9103)).holder, 'tv-3')
    provision('remove', 'tv-3')
    const { data } = await admin.from('claims').select('agent').eq('issue', 9103)
    assert.equal(data?.length, 0, 'the removed agent still holds #9103')
    assert.equal(await rowsVisible(t3, 'agent_messages'), 0, "the removed agent's token still reads mail")
    await t3.from('agent_status').upsert({ agent: 'tv-3', state: 'working' })
    const { count } = await admin.from('agent_status').select('*', { count: 'exact', head: true }).eq('agent', 'tv-3')
    assert.equal(count, 0, "the removed agent's token still writes status")
  })
} finally {
  await admin.from('agent_messages').delete().in('id', created)
  await admin.from('claims').delete().in('issue', ISSUES).in('agent', AGENT_IDS)
  await removeThrowawayAgents()
  for (const userId of outsiders) await admin.auth.admin.deleteUser(userId)
}

console.log(results.join('\n'))
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0)
