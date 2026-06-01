-- RPC: delete_user_account
-- Deletes all user data and the auth account for the given user.
-- Called from account.html when a user requests account deletion.

CREATE OR REPLACE FUNCTION delete_user_account(p_user_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Delete user data in dependency order
  DELETE FROM user_notes       WHERE user_id = p_user_id;
  DELETE FROM shared_notes     WHERE user_id = p_user_id;
  DELETE FROM received_shares  WHERE recipient_id = p_user_id;
  DELETE FROM purchases        WHERE user_id = p_user_id;
  DELETE FROM user_credits     WHERE user_id = p_user_id;

  -- Delete the auth user (cascades any remaining auth data)
  DELETE FROM auth.users WHERE id = p_user_id;
END;
$$;

-- Only the user themselves (or service role) can call this
REVOKE ALL ON FUNCTION delete_user_account(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_user_account(UUID) TO authenticated;
