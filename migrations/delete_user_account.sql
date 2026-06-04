-- RPC: delete_user_account
-- Permanently deletes the CALLER's account and all their data.
-- Called from account.html.
--
-- Security: identity comes from auth.uid() (the verified login token), NOT the
-- p_user_id parameter — so a logged-in user can only ever delete their OWN
-- account, never someone else's. The parameter is kept only so the existing
-- client call (sb.rpc("delete_user_account", { p_user_id })) keeps working.
--
-- Run this in the Supabase SQL editor to replace the old (broken) version.

CREATE OR REPLACE FUNCTION public.delete_user_account(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Notes on the user's own letters (annotations has no user_id — scope via shares).
  DELETE FROM annotations WHERE share_id IN (SELECT id FROM shares WHERE user_id = v_uid);

  -- The user's own rows in the per-user tables.
  DELETE FROM received_shares WHERE user_id = v_uid;
  DELETE FROM vault_keys      WHERE user_id = v_uid;
  DELETE FROM user_vault      WHERE user_id = v_uid;
  DELETE FROM purchases       WHERE user_id = v_uid;
  DELETE FROM user_credits    WHERE user_id = v_uid;

  -- The user's letters. FKs from received_shares / vault_keys / annotations to
  -- shares (on delete cascade) clean up any rows other users hold for these shares.
  DELETE FROM shares WHERE user_id = v_uid;

  -- Finally, the auth account itself.
  DELETE FROM auth.users WHERE id = v_uid;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_user_account(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delete_user_account(uuid) TO authenticated;
