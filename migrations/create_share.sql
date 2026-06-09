-- ────────────────────────────────────────────────────────────────────────────
-- create_share — server-enforced "consume a credit + create the share" in ONE
-- atomic transaction. Replaces the old client-driven flow (insert share, insert
-- notes, then optionally call use_credit) which let a technical user skip the
-- credit entirely and send unlimited free letters.
--
-- Because this runs SECURITY DEFINER and does everything in a single function
-- call, the credit is ALWAYS consumed with the share, or neither happens. The
-- browser can no longer create a share without paying a credit.
--
-- Reuses the existing use_credit(uuid) logic (which must derive the user from
-- auth.uid()), so the free/paid/lifetime credit model lives in one place.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.create_share(
  p_id             text,
  p_share_type     text,
  p_playlist_id    text,
  p_playlist_url   text,
  p_playlist_name  text,
  p_sender_name    text,
  p_recipient_name text,
  p_description    text,
  p_sender_content text,
  p_notes          jsonb        -- array of {track_id, note, timestamp, sender_name, track_title, track_artist, playlist_id}
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_credit jsonb;
  n        jsonb;
begin
  -- Must be a logged-in user (identity comes from the JWT, never the client).
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  -- Must actually contain notes.
  if p_notes is null or jsonb_typeof(p_notes) <> 'array' or jsonb_array_length(p_notes) = 0 then
    return jsonb_build_object('ok', false, 'error', 'no_notes');
  end if;

  -- Don't let the same id be created twice (idempotency / replay guard).
  if exists (select 1 from public.shares where id = p_id) then
    return jsonb_build_object('ok', false, 'error', 'duplicate');
  end if;

  -- 1) Consume a credit using the existing, auth.uid()-scoped logic.
  --    If it returns not-ok, bail BEFORE inserting anything.
  v_credit := public.use_credit(v_uid);
  if v_credit is null or coalesce((v_credit->>'ok')::boolean, false) = false then
    return jsonb_build_object('ok', false, 'error', 'no_credit');
  end if;

  -- 2) Insert the share, owned by the caller (user_id from the JWT, not input).
  insert into public.shares
    (id, user_id, share_type, playlist_id, playlist_url, playlist_name,
     sender_name, recipient_name, description, sender_content)
  values
    (p_id, v_uid, p_share_type, p_playlist_id, p_playlist_url, p_playlist_name,
     p_sender_name, p_recipient_name, p_description, p_sender_content);

  -- 3) Insert the (already client-encrypted) notes.
  for n in select value from jsonb_array_elements(p_notes)
  loop
    insert into public.annotations
      (share_id, track_id, note, "timestamp", sender_name, track_title, track_artist, playlist_id)
    values
      (p_id,
       n->>'track_id',
       n->>'note',
       nullif(n->>'timestamp', '')::int,
       coalesce(n->>'sender_name', p_sender_name),
       n->>'track_title',
       n->>'track_artist',
       coalesce(n->>'playlist_id', p_playlist_id));
  end loop;

  return jsonb_build_object('ok', true);

exception
  -- Any unexpected failure rolls back the ENTIRE function (the consumed credit
  -- included), so we never leave a half-made share or a wrongly-spent credit.
  when others then
    return jsonb_build_object('ok', false, 'error', 'server_error');
end;
$$;

-- Only logged-in users may call it; never anon.
revoke all on function public.create_share(
  text, text, text, text, text, text, text, text, text, jsonb
) from public, anon;
grant execute on function public.create_share(
  text, text, text, text, text, text, text, text, text, jsonb
) to authenticated;
