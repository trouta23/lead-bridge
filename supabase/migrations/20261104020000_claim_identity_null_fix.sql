-- Fix found by verify-identity.mjs: claiming with no p_from on someone else's behalf slipped through.
-- `p_from = me` is NULL (not false) when p_from is NULL, so `not (false or NULL)` was NULL and the
-- check never raised. `is not distinct from` treats NULL as a plain value.
create or replace function claim_issue(p_issue int, p_agent text, p_from text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  me text := bridge_agent();
  holder text;
begin
  if me is not null
     and not ((p_from is null and p_agent is not distinct from me) or p_from is not distinct from me) then
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
