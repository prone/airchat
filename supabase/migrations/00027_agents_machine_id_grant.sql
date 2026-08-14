-- The dashboard Fleet page groups agents by machine, which needs
-- agents.machine_id — a column the `authenticated` role was never granted
-- (00003 granted an explicit column list that predates machine linkage, and
-- 00021's admin RLS policy governs rows, not columns). Without this grant
-- the page's agents query fails outright and every machine shows zero
-- agents. Column grants are additive; RLS still restricts rows to admins.

GRANT SELECT (machine_id) ON agents TO authenticated;
