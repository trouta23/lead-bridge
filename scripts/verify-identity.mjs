// Checks the identity, receipt and group rules against the real project, signed in as throwaway
// agents (tv-1, tv-2, tv-3), and cleans up after itself. Run: node verify-identity.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const here = new URL(".", import.meta.url).pathname;
const readEnv = (file) =>
  Object.fromEntries(readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const env = readEnv(`${here}.env.local`);
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const AGENTS = [["tv-1", "t1-"], ["tv-2", "t2-"], ["tv-3", "t3-"]];

const provision = (...args) => execFileSync("node", [`${here}provision.mjs`, ...args], { encoding: "utf8" });
for (const [id, prefix] of AGENTS) provision("add", id, prefix);

async function signIn(id) {
  const e = readEnv(`${here}agents/${id}.env`);
  const client = createClient(e.SUPABASE_URL, e.SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email: e.BRIDGE_EMAIL, password: e.BRIDGE_PASSWORD });
  if (error) throw new Error(`sign in ${id}: ${error.message}`);
  return client;
}
const [t1, t2, t3] = await Promise.all(AGENTS.map(([id]) => signIn(id)));

const results = [];
const created = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}: ${err.message}`);
  }
}
const send = async (client, row) => {
  const r = await client.from("agent_messages").insert(row).select("id").single();
  if (r.data) created.push(r.data.id);
  return r;
};
const inboxIds = async (client) => {
  const { data, error } = await client.rpc("inbox");
  if (error) throw new Error(error.message);
  return data.map((m) => m.id);
};

await check("an agent cannot post as another agent", async () => {
  const { error } = await send(t1, { from_agent: "tv-2", to_agent: "tv-3", kind: "fyi", body: "spoof" });
  assert.ok(error, "spoofed insert was accepted");
});

let dm;
await check("an agent can post as itself, and a third agent can't read that direct message", async () => {
  const { data, error } = await send(t1, { from_agent: "tv-1", to_agent: "tv-2", kind: "ask", body: "direct message" });
  assert.ok(!error, error?.message);
  dm = data.id;
  assert.ok((await inboxIds(t2)).includes(dm), "recipient doesn't see it");
  const { data: peek } = await t3.from("agent_messages").select("id").eq("id", dm);
  assert.equal(peek.length, 0, "a third agent could read it");
  assert.ok(!(await inboxIds(t3)).includes(dm), "it's in a third agent's inbox");
});

await check("inbox ignores parameters when signed in (no reading someone else's inbox)", async () => {
  const { data } = await t3.rpc("inbox", { p_agent: "tv-2", p_prefix: "t2-" });
  assert.ok(!data.map((m) => m.id).includes(dm), "tv-3 read tv-2's inbox by passing its id");
});

await check("a broadcast to 'all' stays unread for each agent until that agent reads it (the receipts fix)", async () => {
  const { data } = await send(t3, { from_agent: "tv-3", to_agent: "all", kind: "fyi", body: "identity test broadcast, no action needed" });
  assert.ok((await inboxIds(t1)).includes(data.id), "tv-1 doesn't see the broadcast");
  const { error } = await t1.from("message_reads").insert({ message_id: data.id, agent: "tv-1" });
  assert.ok(!error, error?.message);
  assert.ok(!(await inboxIds(t1)).includes(data.id), "still unread for tv-1 after reading");
  assert.ok((await inboxIds(t2)).includes(data.id), "tv-1 reading it hid it from tv-2: the old bug");
});

await check("an agent cannot mark a message read for someone else", async () => {
  const { error } = await t1.from("message_reads").insert({ message_id: dm, agent: "tv-2" });
  assert.ok(error, "marked read on tv-2's behalf");
});

await check("a group message reaches exactly its recipients", async () => {
  const { data, error } = await send(t1, { from_agent: "tv-1", to_agent: "group", recipients: ["tv-2", "tv-3"], kind: "ask", body: "group question" });
  assert.ok(!error, error?.message);
  assert.ok((await inboxIds(t2)).includes(data.id) && (await inboxIds(t3)).includes(data.id), "a recipient missed it");
  const { data: other } = await t1.rpc("inbox");
  assert.ok(!other.map((m) => m.id).includes(data.id), "the sender got its own group message");
});

await check("a message to a teammate (t2-x) reaches that team's lead only", async () => {
  const { data } = await send(t1, { from_agent: "tv-1", to_agent: "t2-x", kind: "fyi", body: "for your teammate" });
  assert.ok((await inboxIds(t2)).includes(data.id), "tv-2 didn't get its teammate's message");
  assert.ok(!(await inboxIds(t3)).includes(data.id), "tv-3 got another team's teammate message");
});

await check("status: an agent can set its own and its teammates' rows, not another team's", async () => {
  assert.ok(!(await t1.from("agent_status").upsert({ agent: "tv-1", state: "working", task: "identity test" })).error);
  assert.ok(!(await t1.from("agent_status").upsert({ agent: "t1-2", state: "working", task: "teammate" })).error);
  const { error } = await t1.from("agent_status").upsert({ agent: "tv-2", state: "idle", task: "hijacked" });
  assert.ok(error, "tv-1 overwrote tv-2's status");
});

await check("claims: only for yourself, only give away what you hold", async () => {
  const claim = async (client, args) => {
    const { data, error } = await client.rpc("claim_issue", args);
    return { data, error };
  };
  assert.equal((await claim(t1, { p_issue: 9101, p_agent: "tv-1" })).data, "tv-1");
  assert.ok((await claim(t2, { p_issue: 9101, p_agent: "tv-2", p_from: "tv-1" })).error, "tv-2 took tv-1's claim by pretending to be the holder");
  assert.ok((await claim(t2, { p_issue: 9102, p_agent: "tv-1" })).error, "tv-2 claimed an issue on tv-1's behalf");
  assert.equal((await claim(t2, { p_issue: 9101, p_agent: "tv-2" })).data, "tv-1", "a plain claim didn't report the holder");
  assert.equal((await claim(t1, { p_issue: 9101, p_agent: "tv-2", p_from: "tv-1" })).data, "tv-2", "the holder couldn't hand it over");
});

await check("signed-in agents can read the registry but not change it", async () => {
  const { data } = await t1.from("agents").select("id");
  assert.ok(data.some((a) => a.id === "tv-2"));
  const { error } = await t1.from("agents").insert({ id: "rogue", team_prefix: "rogue-" });
  assert.ok(error, "an agent registered a new agent");
});

// Clean up: messages, statuses, claims, then the throwaway agents.
await admin.from("agent_messages").delete().in("id", created);
await admin.from("agent_status").delete().in("agent", ["tv-1", "t1-2", "tv-2"]);
await admin.from("claims").delete().in("issue", [9101, 9102]);
for (const [id] of AGENTS) {
  provision("remove", id);
  rmSync(`${here}agents/${id}.env`, { force: true });
}
console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
