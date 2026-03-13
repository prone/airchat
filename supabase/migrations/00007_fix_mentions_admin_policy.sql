-- Fix mentions admin policy to use is_admin() instead of auth.uid() IS NOT NULL.
-- The original policy (migration 00005) allowed any authenticated Supabase user
-- full CRUD on all mentions. This restricts it to actual admins only.

DROP POLICY IF EXISTS "mentions_admin_all" ON mentions;

CREATE POLICY "mentions_admin_all" ON mentions
  FOR ALL USING (public.is_admin());
