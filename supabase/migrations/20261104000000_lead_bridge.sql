-- lead-bridge: lead agents on different machines and Claude accounts message each other, share
-- status and claim issues, with no human relaying. Give the bridge its own Supabase project.
--
-- Identity: every agent signs in as its own Supabase user, created by scripts/provision.ts. Its
-- agent id and team prefix live in the user's app_metadata, which only the secret key can set, and
-- the registry ties that id to the user. A caller counts as an agent only while both agree, so a
-- self-registered user, or the leftover token of a removed agent, can do nothing. Teammates (ids
-- under a lead's prefix, such as a-2) have no sign-in: their lead reads and writes for them.
--
-- What holds for a signed-in agent:
--   messages and receipts are append-only, and an agent reads only messages it sent or that are
--     addressed to it, its teammates, a group naming either, or 'all';
--   an agent writes only as itself, and only its own team's status rows;
--   claims change hands only through claim_issue.

-- Registry -------------------------------------------------------------------------------------

create table public.agents (
  id text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and id not in ('all', 'group') and length(id) <= 64),
  team_prefix text not null unique check (team_prefix ~ '^[a-z0-9]+-$' and length(team_prefix) <= 32),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Overlap would let one lead read another team's mail: prefixes like a- and a-b-, or an id that
-- falls under someone else's prefix. The lock makes two provisions run one after the other, so
-- neither misses the other's row.
create function public.agents_no_overlap() returns trigger
language plpgsql set search_path = '' as $$
begin
  lock table public.agents in share row exclusive mode;
  if exists (select 1 from public.agents a
             where a.id <> new.id
               and (starts_with(a.team_prefix, new.team_prefix) or starts_with(new.team_prefix, a.team_prefix))) then
    raise exception 'team prefix % overlaps another agent''s prefix', new.team_prefix;
  end if;
  if exists (select 1 from public.agents a
             where a.id <> new.id
               and (starts_with(new.id, a.team_prefix) or starts_with(a.id, new.team_prefix))) then
    raise exception 'agent id % falls under another team''s prefix, or the reverse', new.id;
  end if;
  return new;
end;
$$;

create trigger agents_no_overlap
  before insert or update on public.agents
  for each row execute function public.agents_no_overlap();

-- Identity -------------------------------------------------------------------------------------

create function public.bridge_agent() returns text
language sql stable set search_path = '' as $$
  select auth.jwt() -> 'app_metadata' ->> 'agent_id'
$$;

create function public.bridge_prefix() returns text
language sql stable set search_path = '' as $$
  select auth.jwt() -> 'app_metadata' ->> 'team_prefix'
$$;

-- Whether the caller is a registered agent: the token's agent id belongs to the token's user. Runs
-- as its owner, since the registry's own policy calls it.
create function public.is_agent() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.agents a where a.id = public.bridge_agent() and a.user_id = auth.uid())
$$;

-- Whether an id is the calling agent or one of its teammates.
create function public.is_own_team(p_agent text) returns boolean
language sql stable set search_path = '' as $$
  select public.is_agent() and (p_agent = public.bridge_agent() or starts_with(p_agent, public.bridge_prefix()))
$$;

-- Whether a message is for an agent: its id, 'all', one of its teammates, or a group naming either.
create function public.addressed_to(p_to text, p_recipients text[], p_agent text, p_prefix text) returns boolean
language sql immutable set search_path = '' as $$
  select p_to = p_agent
      or p_to = 'all'
      or starts_with(p_to, p_prefix)
      or exists (select 1 from unnest(coalesce(p_recipients, '{}')) r where r = p_agent or starts_with(r, p_prefix))
$$;

-- Whether an address reaches someone: a registered agent, or an id under a registered prefix.
create function public.is_address(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.agents a where a.id = p_name or starts_with(p_name, a.team_prefix))
$$;

-- Messages ---------------------------------------------------------------------------------------

-- to_agent is an agent id, a teammate id, 'all', or 'group' with the recipients listed. The size
-- limits bound what one message can put into every recipient's prompt.
create table public.agent_messages (
  id bigint generated always as identity primary key,
  thread_id bigint references public.agent_messages (id),
  supersedes bigint references public.agent_messages (id),
  from_agent text not null,
  to_agent text not null check (length(to_agent) <= 64),
  recipients text[] check (cardinality(recipients) <= 16 and length(array_to_string(recipients, '')) <= 1024
                           and not recipients && array['all', 'group']),
  kind text not null check (kind in (
    'fyi', 'ask', 'reply', 'handoff', 'accept', 'decline', 'blocked',
    'plan', 'dispute', 'ruling', 'duck', 'resolved', 'vote'
  )),
  body text not null check (length(body) <= 4000),
  refs jsonb not null default '{}' check (pg_column_size(refs) <= 4096),
  created_at timestamptz not null default now(),
  check ((to_agent = 'group') = (recipients is not null and cardinality(recipients) > 0))
);

create index agent_messages_sender_recent on public.agent_messages (from_agent, created_at);

-- A receipt per agent, so one lead reading a broadcast doesn't hide it from the others.
create table public.message_reads (
  message_id bigint not null references public.agent_messages (id) on delete cascade,
  agent text not null references public.agents (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (message_id, agent)
);

-- Refuses mail to nobody (a typo would otherwise vanish) and caps each sender at 20 messages a
-- minute: a speed limit for runaway loops, not a cap on debate. Clients can't set created_at, so
-- the count can't be dodged by backdating.
create function public.agent_messages_check() returns trigger
language plpgsql set search_path = '' as $$
declare
  name text;
begin
  foreach name in array case when new.to_agent = 'group' then new.recipients else array[new.to_agent] end loop
    if name <> 'all' and not public.is_address(name) then
      raise exception 'no agent or team is called %', name;
    end if;
  end loop;
  if (select count(*) from public.agent_messages
      where from_agent = new.from_agent and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'rate limit: % sent 20 messages in the last minute', new.from_agent;
  end if;
  return new;
end;
$$;

create trigger agent_messages_check
  before insert on public.agent_messages
  for each row execute function public.agent_messages_check();

-- Status and claims ------------------------------------------------------------------------------

create table public.agent_status (
  agent text primary key check (length(agent) <= 64),
  state text not null check (state in ('working', 'blocked', 'idle')),
  task text check (length(task) <= 500),
  issue int,
  branch text check (length(branch) <= 200),
  files text[] not null default '{}' check (cardinality(files) <= 100 and length(array_to_string(files, '')) <= 10000),
  plan text check (length(plan) <= 2000),
  updated_at timestamptz not null default now()
);

-- updated_at is when the status last changed, so saving the same status again notifies no one.
create function public.agent_status_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.state, new.task, new.issue, new.branch, new.files, new.plan)
     is distinct from (old.state, old.task, old.issue, old.branch, old.files, old.plan) then
    new.updated_at = now();
  else
    new.updated_at = old.updated_at;
  end if;
  return new;
end;
$$;

create trigger agent_status_touch
  before update on public.agent_status
  for each row execute function public.agent_status_touch();

-- One holder per issue, changed only through claim_issue. Removing an agent frees its claims.
create table public.claims (
  issue int primary key,
  agent text not null references public.agents (id) on delete cascade,
  claimed_at timestamptz not null default now()
);

-- Functions --------------------------------------------------------------------------------------

-- The caller's unread mail, oldest first, starting from when the caller was registered (so a new
-- agent doesn't get the bridge's whole history).
create function public.inbox() returns setof public.agent_messages
language sql stable set search_path = '' as $$
  select m.*
    from public.agent_messages m
    join public.agents me on me.id = public.bridge_agent() and me.user_id = auth.uid()
   where public.addressed_to(m.to_agent, m.recipients, me.id, me.team_prefix)
     and m.from_agent <> me.id
     and m.created_at >= me.created_at
     and not exists (select 1 from public.message_reads r where r.message_id = m.id and r.agent = me.id)
   order by m.id
$$;

-- Claims an issue for the caller, hands the caller's claim to another agent (p_give_to), or
-- releases it (p_release). Returns whoever holds the issue afterwards, or null when nobody does.
-- Runs as its owner because callers may see who holds an issue but not change it directly.
create function public.claim_issue(p_issue int, p_give_to text default null, p_release boolean default false)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  me text := public.bridge_agent();
  holder text;
begin
  if not public.is_agent() then
    raise exception 'claim_issue needs a signed-in agent';
  end if;
  if p_release and p_give_to is not null then
    raise exception 'give a claim away or release it, not both';
  end if;
  if p_give_to is not null and not exists (select 1 from public.agents where id = p_give_to) then
    raise exception 'no agent is called %', p_give_to;
  end if;

  if p_release then
    delete from public.claims where issue = p_issue and agent = me;
  elsif p_give_to is not null then
    update public.claims set agent = p_give_to, claimed_at = now() where issue = p_issue and agent = me;
  else
    insert into public.claims (issue, agent) values (p_issue, me) on conflict (issue) do nothing;
    return (select agent from public.claims where issue = p_issue);
  end if;

  if not found then
    holder := (select agent from public.claims where issue = p_issue);
    raise exception 'you don''t hold #%: %', p_issue, coalesce(holder || ' does', 'nobody does');
  end if;
  return (select agent from public.claims where issue = p_issue);
end;
$$;

-- Row Level Security -----------------------------------------------------------------------------
-- The identity functions are called directly, not wrapped as (select f()): the message policies
-- read agent_messages themselves, and Postgres refuses a policy whose subquery reaches a policy
-- that has subqueries of its own on the same table.

alter table public.agents enable row level security;
alter table public.agent_messages enable row level security;
alter table public.message_reads enable row level security;
alter table public.agent_status enable row level security;
alter table public.claims enable row level security;

create policy agents_visible on public.agents for select to authenticated
  using (public.is_agent());

create policy messages_visible on public.agent_messages for select to authenticated
  using (public.is_agent()
         and (from_agent = public.bridge_agent()
              or public.addressed_to(to_agent, recipients, public.bridge_agent(), public.bridge_prefix())));
-- Send only as yourself, and supersede only your own messages (or anyone could hide anyone's).
create policy messages_send_as_self on public.agent_messages for insert to authenticated
  with check (public.is_agent()
              and from_agent = public.bridge_agent()
              and (supersedes is null
                   or exists (select 1 from public.agent_messages o
                              where o.id = agent_messages.supersedes and o.from_agent = public.bridge_agent())));

create policy reads_own on public.message_reads for select to authenticated
  using (public.is_agent() and agent = public.bridge_agent());
create policy reads_mark_own on public.message_reads for insert to authenticated
  with check (public.is_agent()
              and agent = public.bridge_agent()
              and exists (select 1 from public.agent_messages m where m.id = message_reads.message_id));

create policy status_visible on public.agent_status for select to authenticated
  using (public.is_agent());
create policy status_insert_own_team on public.agent_status for insert to authenticated
  with check (public.is_own_team(agent));
create policy status_update_own_team on public.agent_status for update to authenticated
  using (public.is_own_team(agent))
  with check (public.is_own_team(agent));

create policy claims_visible on public.claims for select to authenticated
  using (public.is_agent());

-- Privileges -------------------------------------------------------------------------------------
-- Supabase grants every new table and function to anon and authenticated. Take that back and grant
-- only what the policies above use, column by column, so clients can't set ids or timestamps.

revoke all on public.agents, public.agent_messages, public.message_reads, public.agent_status, public.claims
  from anon, authenticated;
grant select on public.agents, public.agent_messages, public.message_reads, public.agent_status, public.claims
  to authenticated;
grant insert (thread_id, supersedes, from_agent, to_agent, recipients, kind, body, refs)
  on public.agent_messages to authenticated;
grant insert (message_id, agent) on public.message_reads to authenticated;
-- An upsert sets every column it sends, the key included, so agent is updatable; the policy still
-- keeps it within the caller's team.
grant insert (agent, state, task, issue, branch, files, plan), update (agent, state, task, issue, branch, files, plan)
  on public.agent_status to authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.bridge_agent(), public.bridge_prefix(), public.is_agent(), public.is_own_team(text),
  public.addressed_to(text, text[], text, text), public.is_address(text), public.inbox(),
  public.claim_issue(int, text, boolean)
  to authenticated;
