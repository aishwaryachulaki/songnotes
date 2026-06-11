-- received_shares: tracks which users have imported which shares.
-- Written to by the extension on import (popup.js side-panel import AND
-- share-bridge.js when the recipient is signed in); read by notes.html to
-- populate the "Received" tab persistently across devices.
--
-- Run this once in the Supabase SQL editor for your project. Idempotent.

create table if not exists public.received_shares (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  share_id    text        not null references public.shares(id) on delete cascade,
  imported_at timestamptz not null default now(),

  -- Prevent the same user importing the same share twice creating duplicate rows.
  unique(user_id, share_id)
);

alter table public.received_shares enable row level security;

-- Each user can only see, add, and remove their own rows.
drop policy if exists "Users can view their own received shares" on public.received_shares;
create policy "Users can view their own received shares"
  on public.received_shares for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own received shares" on public.received_shares;
create policy "Users can insert their own received shares"
  on public.received_shares for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own received shares" on public.received_shares;
create policy "Users can delete their own received shares"
  on public.received_shares for delete
  using (auth.uid() = user_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Recipients must be able to READ the shares + annotations they've imported, so
-- notes.html's Received tab (which joins received_shares -> shares -> annotations)
-- can render. These are ADDITIVE select policies (OR'd with the existing
-- owner-only policies). They expose nothing new: get_share() already makes share
-- metadata + song list publicly fetchable by id, and all note/description/name
-- content stays end-to-end encrypted (the key never reaches the server).
-- ────────────────────────────────────────────────────────────────────────────
drop policy if exists "Recipients can view received shares" on public.shares;
create policy "Recipients can view received shares"
  on public.shares for select
  using (exists (
    select 1 from public.received_shares r
    where r.share_id = public.shares.id
      and r.user_id = auth.uid()
  ));

drop policy if exists "Recipients can view received annotations" on public.annotations;
create policy "Recipients can view received annotations"
  on public.annotations for select
  using (exists (
    select 1 from public.received_shares r
    where r.share_id = public.annotations.share_id
      and r.user_id = auth.uid()
  ));
