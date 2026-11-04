-- Found in the first live run with a new agent (lead-d): receipts are per agent, so a newcomer had
-- no receipt for anything sent before it existed, and its first turn was the bridge's whole history
-- of broadcasts. An agent's inbox now starts when it was registered. Unregistered ids (the secret
-- key's legacy callers) keep the old behavior.
create or replace function inbox(p_agent text default null, p_prefix text default null)
returns setof agent_messages
language sql stable as $$
  with me as (
    select coalesce(bridge_agent(), p_agent) as agent, coalesce(bridge_prefix(), p_prefix) as prefix
  ),
  joined as (
    select coalesce((select a.created_at from agents a, me where a.id = me.agent), '-infinity'::timestamptz) as at
  )
  select m.*
    from agent_messages m, me, joined
   where addressed_to(m.to_agent, m.recipients, me.agent, me.prefix)
     and m.from_agent <> me.agent
     and m.created_at >= joined.at
     and not exists (select 1 from message_reads r where r.message_id = m.id and r.agent = me.agent)
   order by m.id
$$;
