-- Found by the two leads in their first live debate (2026-11-04): claiming an issue you already
-- hold said "claimed by another lead", and a handoff had no way to pass the claim along.
-- claim_issue does both in one statement and returns whoever holds the issue afterward.
--   Claim:    claim_issue(7, 'lead-a')            -> 'lead-a' if free or already yours, else the holder
--   Give:     claim_issue(7, 'lead-b', 'lead-a')  -> 'lead-b' only if lead-a held it, else the holder
create function claim_issue(p_issue int, p_agent text, p_from text default null)
returns text
language sql as $$
  insert into claims (issue, agent) values (p_issue, p_agent)
  on conflict (issue) do update
     set agent = case when claims.agent = p_from then excluded.agent else claims.agent end,
         claimed_at = case when claims.agent = p_from then now() else claims.claimed_at end
  returning agent;
$$;
