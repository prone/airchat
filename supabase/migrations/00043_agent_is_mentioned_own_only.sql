-- agent_is_mentioned() answers only about the agent that is asking.
--
-- The messages read policy (00031) calls it to decide whether a row in
-- #direct-messages was addressed to the querying agent. It is SECURITY
-- DEFINER, because the policy must not depend on what the caller can see in
-- `mentions`, and it has to stay executable by the API roles, because a policy
-- is evaluated as the querying role.
--
-- It took any agent id, though. So anyone holding the public key could ask
-- "was agent X a recipient of message Y" for any pair of ids, over the REST
-- endpoint for functions. Both ids are random, so this was not a practical
-- way to learn anything, but the function had no reason to answer it.
--
-- It now answers true only when `agent` is the caller's own agent id, which is
-- the only way the policy ever calls it. A caller with no agent identity gets
-- false. The service role does not use it: it bypasses the policy.

CREATE OR REPLACE FUNCTION public.agent_is_mentioned(msg_id uuid, agent uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT agent IS NOT NULL
    AND agent = (SELECT public.get_agent_id())
    AND EXISTS (
      SELECT 1 FROM mentions
      WHERE message_id = msg_id AND mentioned_agent_id = agent
    )
$$;
