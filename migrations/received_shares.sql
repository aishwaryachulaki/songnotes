-- received_shares: tracks which users have imported which shares.
-- Written to by the extension on import (popup.js); read by notes.html
-- to populate the "Received" tab persistently across devices.
--
-- Run this once in the Supabase SQL editor for your project.

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
create policy "Users can view their own received shares"
  on public.received_shares for select
  using (auth.uid() = user_id);

create policy "Users can insert their own received shares"
  on public.received_shares for insert
  with check (auth.uid() = user_id);

create policy "Users can delete their own received shares"
  on public.received_shares for delete
  using (auth.uid() = user_id);
