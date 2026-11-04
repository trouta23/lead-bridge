#!/usr/bin/env node
// Admin tool: gives each agent its own sign-in on the bridge. Run by whoever holds the secret key.
//   node provision.mjs add <agent-id> <team-prefix>   creates the user and writes agents/<id>.env
//   node provision.mjs remove <agent-id>                deletes the user and its registry row
//   node provision.mjs list                             lists registered agents
// The agent's id and prefix go in the user's app_metadata, which only the secret key can set, and
// the database's Row Level Security pins every write to them. Hand agents/<id>.env to that person
// privately (a password manager); it holds their password, never the secret key.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("./.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const emailFor = (id) => `${id}@agents.lead-bridge.example.com`;

async function add(id, prefix) {
  if (!id || !prefix) throw new Error("usage: add <agent-id> <team-prefix>");
  const password = randomBytes(24).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({
    email: emailFor(id),
    password,
    email_confirm: true,
    app_metadata: { agent_id: id, team_prefix: prefix },
  });
  if (error) throw new Error(`create user: ${error.message}`);
  const { error: regError } = await admin.from("agents").insert({ id, team_prefix: prefix, user_id: data.user.id });
  if (regError) {
    await admin.auth.admin.deleteUser(data.user.id);
    throw new Error(`register ${id}: ${regError.message} (user removed again)`);
  }
  mkdirSync(new URL("./agents/", import.meta.url), { recursive: true });
  const file = new URL(`./agents/${id}.env`, import.meta.url);
  writeFileSync(
    file,
    [
      `SUPABASE_URL=${env.SUPABASE_URL}`,
      `SUPABASE_PUBLISHABLE_KEY=${env.SUPABASE_PUBLISHABLE_KEY}`,
      `BRIDGE_EMAIL=${emailFor(id)}`,
      `BRIDGE_PASSWORD=${password}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  console.log(`added ${id} (prefix ${prefix}); its sign-in is in ${file.pathname}`);
}

async function remove(id) {
  const { data: row, error } = await admin.from("agents").select("user_id").eq("id", id).single();
  if (error) throw new Error(`find ${id}: ${error.message}`);
  const { error: delError } = await admin.auth.admin.deleteUser(row.user_id);
  if (delError) throw new Error(`delete ${id}: ${delError.message}`);
  console.log(`removed ${id}`);
}

async function list() {
  const { data, error } = await admin.from("agents").select("id, team_prefix, created_at").order("id");
  if (error) throw new Error(error.message);
  for (const a of data) console.log(`${a.id}\t${a.team_prefix}\t${a.created_at}`);
  if (!data.length) console.log("no agents registered");
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === "add") await add(...args);
  else if (cmd === "remove") await remove(...args);
  else if (cmd === "list") await list();
  else throw new Error("usage: node provision.mjs add <agent-id> <team-prefix> | remove <agent-id> | list");
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
