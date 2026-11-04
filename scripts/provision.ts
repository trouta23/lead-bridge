// Gives each agent its own sign-in on the bridge. Run by the admin, who holds scripts/.env.local.
//   node provision.ts add <agent-id> <team-prefix>   creates the user and writes agents/<id>.env
//   node provision.ts remove <agent-id>              deletes the user, its registry row, receipts,
//                                                    claims, its team's status rows and its file
//   node provision.ts list                           lists registered agents
// The id and prefix go in the user's app_metadata, which only the secret key can set, and the
// database accepts the agent only while that matches the registry. Hand agents/<id>.env to that
// person privately (a password manager): it holds their password, never the secret key.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { adminClient, adminEnv, agentFile, SCRIPTS_DIR } from './env.ts'

const env = adminEnv()
const admin = adminClient(env)
const emailFor = (id: string): string => `${id}@agents.lead-bridge.example.com`

async function add(id: string, prefix: string): Promise<void> {
  const password = randomBytes(24).toString('base64url')
  const { data, error } = await admin.auth.admin.createUser({
    email: emailFor(id),
    password,
    email_confirm: true,
    app_metadata: { agent_id: id, team_prefix: prefix },
  })
  if (error) throw new Error(`create user ${id}: ${error.message}`)
  const { error: registerError } = await admin.from('agents').insert({ id, team_prefix: prefix, user_id: data.user.id })
  if (registerError) {
    await admin.auth.admin.deleteUser(data.user.id)
    throw new Error(`register ${id}: ${registerError.message} (the user was removed again)`)
  }
  mkdirSync(new URL('agents/', SCRIPTS_DIR), { recursive: true })
  const file = agentFile(id)
  const lines = [
    `SUPABASE_URL=${env.url}`,
    `SUPABASE_PUBLISHABLE_KEY=${env.publishableKey}`,
    `BRIDGE_EMAIL=${emailFor(id)}`,
    `BRIDGE_PASSWORD=${password}`,
  ]
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 })
  console.log(`added ${id} (prefix ${prefix}); its sign-in is in ${file.pathname}`)
}

// Deleting the user cascades to the registry row, receipts and claims. Status rows have no foreign
// key (teammates have no registry row), so they go explicitly.
async function remove(id: string): Promise<void> {
  const { data, error } = await admin.from('agents').select('user_id, team_prefix').eq('id', id).single()
  if (error) throw new Error(`find ${id}: ${error.message}`)
  const { error: statusError } = await admin
    .from('agent_status')
    .delete()
    .or(`agent.eq.${id},agent.like.${data.team_prefix}*`)
  if (statusError) throw new Error(`remove ${id}'s status rows: ${statusError.message}`)
  const { error: deleteError } = await admin.auth.admin.deleteUser(data.user_id)
  if (deleteError) throw new Error(`remove ${id}: ${deleteError.message}`)
  rmSync(agentFile(id), { force: true })
  console.log(`removed ${id}`)
}

async function list(): Promise<void> {
  const { data, error } = await admin.from('agents').select('id, team_prefix, created_at').order('id')
  if (error) throw new Error(error.message)
  if (!data.length) console.log('no agents registered')
  for (const agent of data) console.log(`${agent.id}\t${agent.team_prefix}\t${agent.created_at}`)
}

const USAGE = 'usage: node provision.ts add <agent-id> <team-prefix> | remove <agent-id> | list'
const [command, id, prefix] = process.argv.slice(2)
try {
  if (command === 'add' && id && prefix) await add(id, prefix)
  else if (command === 'remove' && id) await remove(id)
  else if (command === 'list') await list()
  else throw new Error(USAGE)
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
