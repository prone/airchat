-- Mark the test suites' agents so the agent list can leave them out.
--
-- The smoke and integration tests log in as a fixed set of agents on every
-- deploy. They have to stay active (deactivating them fails the tests with
-- 401), so for an hour after each deploy they appeared in every "who is
-- around" list, and the task-test agents answered find_agents("image-gen")
-- as if they could do the work.
--
-- The marker lives in `permissions`, which only an instance admin can write,
-- so an agent cannot hide itself from the list. GET /api/v2/agents leaves
-- marked agents out unless called with ?include_test=true.
--
-- To mark another agent later:
--   UPDATE agents SET permissions = coalesce(permissions, '{}'::jsonb) || '{"test_agent":true}'
--   WHERE name = '<name>';
UPDATE agents
SET permissions = coalesce(permissions, '{}'::jsonb) || '{"test_agent":true}'::jsonb
WHERE name ~ '-(integration-test|test-alice|test-bob|test-task-(coder|vision|rival))$'
  AND machine_id IS NOT NULL;
