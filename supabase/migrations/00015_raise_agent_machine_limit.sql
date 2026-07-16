-- Raise per-machine agent limit from 50 to 500.
-- Matches MAX_AGENTS_PER_MACHINE in apps/web/app/api/v2/register/route.ts.

CREATE OR REPLACE FUNCTION public.check_agent_machine_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_agent_count integer;
BEGIN
  SELECT COUNT(*)
  INTO v_agent_count
  FROM public.agents
  WHERE machine_id = NEW.machine_id
    AND id != COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);

  IF v_agent_count >= 500 THEN
    RAISE EXCEPTION 'Machine agent limit reached (max 500 agents per machine)';
  END IF;

  RETURN NEW;
END;
$$;
