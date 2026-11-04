-- Teams of 3+ and real identity (2026-11-04).
-- 1. Per-recipient read receipts: a broadcast to 'all' used to be marked read for everyone by the
--    first lead that read it, so the others never saw it.
-- 2. Group addressing: to_agent = 'group' with a recipients list.
-- 3. An agent registry: unique ids, prefixes that can't overlap.
-- 4. Identity: each agent signs in as its own Supabase user. Its agent id and team prefix live in
--    app_metadata (only the secret key can set them), and Row Level Security pins every write to
--    them, so an agent can no longer post as someone else. The secret key still bypasses all of
--    this, for the admin and the legacy channel bridge.

-- Registry -----------------------------------------------------------------------------------

create table agents (
  id text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  team_prefix text not null unique check (team_prefix ~ '^[a-z0-9]+-$'),
  user_id uuid unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- A prefix that is a prefix of another (a- and ab-? no: a- and a-b-) would let one lead take
-- another team's mail, and so would an id that falls under someone else's prefix.
create function agents_no_overlap() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from agents a
             where a.id <> new.id
               and (starts_with(a.team_prefix, new.team_prefix) or starts_with(new.team_prefix, a.team_prefix))) then
    raise exception 'team prefix % overlaps another agent''s prefix', new.team_prefix;
  end if;
  if exists (select 1 from agents a
             where a.id <> new.id
               and (starts_with(new.id, a.team_prefix) or starts_with(a.id, new.team_prefix))) then
    raise exception 'agent id % falls under another team''s prefix (or the reverse)', new.id;
  end if;
  return new;
end;
$$;

create trigger agents_no_overlap
  before insert or update on agents
  for each row execute function agents_no_overlap();

-- Groups and receipts ---------------------------------------------------------------------------

alter table agent_messages add column recipients text[];
alter table agent_messages drop constraint agent_messages_kind_check;
alter table agent_messages add constraint agent_messages_kind_check check (kind in (
  'fyi', 'ask', 'reply', 'handoff', 'accept', 'decline', 'blocked',
  'plan', 'dispute', 'ruling', 'duck', 'resolved', 'vote'
));
alter table agent_messages add constraint agent_messages_group_check
  check ((to_agent = 'group') = (recipients is not null and cardinality(recipients) > 0));

create table message_reads (
  message_id bigint not null references agent_messages (id) on delete cascade,
  agent text not null,
  read_at timestamptz not null default now(),
  primary key (message_id, agent)
);

-- Identity helpers: the caller's agent id and prefix from its JWT; null under the secret key.
create function bridge_agent() returns text
language sql stable as $$ select auth.jwt() -> 'app_metadata' ->> 'agent_id' $$;

create function bridge_prefix() returns text
language sql stable as $$ select auth.jwt() -> 'app_metadata' ->> 'team_prefix' $$;

-- Is a message for this agent? Its own id, 'all', one of its teammates (prefix), or a group naming
-- it or one of its teammates.
create function addressed_to(p_to text, p_recipients text[], p_agent text, p_prefix text) returns boolean
language sql immutable as $$
  select p_to = p_agent
      or p_to = 'all'
      or (p_prefix is not null and starts_with(p_to, p_prefix))
      or p_agent = any (coalesce(p_recipients, '{}'))
      or (p_prefix is not null and exists (select 1 from unnest(coalesce(p_recipients, '{}')) r where starts_with(r, p_prefix)))
$$;

-- Unread mail in one call. Signed in, the caller's identity comes from its JWT and the parameters
-- are ignored (RLS would hide anyone else's mail anyway); under the secret key, the parameters say
-- whose inbox to read.
create function inbox(p_agent text default null, p_prefix text default null)
returns setof agent_messages
language sql stable as $$
  with me as (
    select coalesce(bridge_agent(), p_agent) as agent, coalesce(bridge_prefix(), p_prefix) as prefix
  )
  select m.*
    from agent_messages m, me
   where addressed_to(m.to_agent, m.recipients, me.agent, me.prefix)
     and m.from_agent <> me.agent
     and not exists (select 1 from message_reads r where r.message_id = m.id and r.agent = me.agent)
   order by m.id
$$;

-- Claims enforce identity themselves (they run as their owner, so RLS can't get in the way of
-- reporting who holds an issue): you may only claim for yourself, and only give away what you hold.
create or replace function claim_issue(p_issue int, p_agent text, p_from text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  me text := bridge_agent();
  holder text;
begin
  if me is not null and not ((p_from is null and p_agent = me) or p_from = me) then
    raise exception 'agent % can only claim for itself or give away its own claims', me;
  end if;
  insert into claims (issue, agent) values (p_issue, p_agent)
  on conflict (issue) do update
     set agent = case when claims.agent = p_from then excluded.agent else claims.agent end,
         claimed_at = case when claims.agent = p_from then now() else claims.claimed_at end
  returning agent into holder;
  return holder;
end;
$$;

-- Row Level Security for signed-in agents -----------------------------------------------------------

alter table agents enable row level security;
alter table message_reads enable row level security;

create policy agents_visible on agents for select to authenticated using (true);

create policy messages_visible on agent_messages for select to authenticated
  using (from_agent = bridge_agent() or addressed_to(to_agent, recipients, bridge_agent(), bridge_prefix()));
create policy messages_send_as_self on agent_messages for insert to authenticated
  with check (from_agent = bridge_agent() and read_at is null);

create policy reads_own on message_reads for select to authenticated using (agent = bridge_agent());
create policy reads_mark_own on message_reads for insert to authenticated with check (agent = bridge_agent());

create policy status_visible on agent_status for select to authenticated using (true);
create policy status_write_own_team on agent_status for insert to authenticated
  with check (agent = bridge_agent() or starts_with(agent, bridge_prefix()));
create policy status_update_own_team on agent_status for update to authenticated
  using (agent = bridge_agent() or starts_with(agent, bridge_prefix()))
  with check (agent = bridge_agent() or starts_with(agent, bridge_prefix()));

create policy claims_visible on claims for select to authenticated using (true);

grant select on agents to authenticated;
grant select, insert on agent_messages to authenticated;
grant select, insert on message_reads to authenticated;
grant select, insert, update on agent_status to authenticated;
grant select on claims to authenticated;
grant execute on function inbox(text, text), claim_issue(int, text, text), bridge_agent(), bridge_prefix(),
  addressed_to(text, text[], text, text) to authenticated;
revoke execute on function claim_issue(int, text, text) from anon, public;
grant execute on function claim_issue(int, text, text) to authenticated, service_role;
