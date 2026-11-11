-- Let a new machine be registered through the API.
--
-- `machine_keys.key_hash` is the pre-00008 shared-secret column. Nothing has
-- authenticated with it since machines moved to signed registration, but it
-- was still NOT NULL, and POST /api/v2/admin/register-machine only sets
-- `machine_name` and `public_key`. So on a database built from these
-- migrations the route could update an existing machine but answered 500 for
-- a new one. Existing values are left as they are.
ALTER TABLE machine_keys ALTER COLUMN key_hash DROP NOT NULL;
