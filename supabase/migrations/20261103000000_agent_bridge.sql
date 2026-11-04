-- Agent bridge: lets two people's lead agents share context with no human in the loop.
-- Design: ../../DESIGN.md. Lives in its own Supabase project, separate from the app's database.

create table agent_messages (
  id bigint generated always as identity primary key,
  thread_id bigint references agent_messages(id),
  supersedes bigint references agent_messages(id),
  from_agent text not null,
  to_agent text not null,
  kind text not null check (kind in (
    'fyi', 'ask', 'reply', 'handoff', 'accept', 'decline', 'blocked',
    'plan', 'dispute', 'ruling', 'duck', 'resolved'
  )),
  body text not null check (length(body) <= 4000),
  refs jsonb not null default '{}',
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index agent_messages_unread on agent_messages (to_agent, created_at) where read_at is null;

create table agent_status (
  agent text primary key,
  state text not null check (state in ('working', 'blocked', 'idle')),
  task text,
  issue int,
  branch text,
  files text[] not null default '{}',
  plan text,
  updated_at timestamptz not null default now()
);

-- One claim per issue: the second lead to claim the same issue gets a unique-violation error.
create table claims (
  issue int primary key,
  agent text not null,
  claimed_at timestamptz not null default now()
);

-- Speed limit, not a debate cap: more than 20 messages a minute from one sender is a runaway loop.
create function agent_messages_rate_limit() returns trigger
language plpgsql as $$
begin
  if (select count(*) from agent_messages
      where from_agent = new.from_agent and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'rate limit: % sent 20 messages in the last minute', new.from_agent;
  end if;
  return new;
end;
$$;

create trigger agent_messages_rate_limit
  before insert on agent_messages
  for each row execute function agent_messages_rate_limit();

create function agent_status_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger agent_status_touch
  before update on agent_status
  for each row execute function agent_status_touch();

-- Catch-up in one round trip: claim every unread message for this lead (its own address,
-- its teammates' prefix, or 'all') and mark them read in the same statement.
create function take_unread(p_agent text, p_team_prefix text)
returns setof agent_messages
language sql as $$
  update agent_messages
     set read_at = now()
   where read_at is null
     and from_agent <> p_agent
     and (to_agent = p_agent or to_agent = 'all' or to_agent like p_team_prefix || '%')
  returning *;
$$;

-- Only the bridge's secret key (held by each lead's channel server and CI) may read or write.
alter table agent_messages enable row level security;
alter table agent_status enable row level security;
alter table claims enable row level security;

alter publication supabase_realtime add table agent_messages, agent_status;
