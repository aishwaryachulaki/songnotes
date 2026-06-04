-- Vault: zero-knowledge cross-device key recovery (opt-in).
--
-- Each of a user's per-share AES keys is stored here WRAPPED (encrypted) with a
-- master key derived from the user's vault PASSPHRASE via PBKDF2. The server only
-- ever sees the wrapped blobs + a salt — never the passphrase or master key — so
-- a full read of these tables is useless without the passphrase. That's what keeps
-- the "even we can't read them" promise while enabling cross-device relive.
--
-- Run this once in the Supabase SQL editor.

-- One row per user: the salt + KDF params + a verifier to detect a wrong passphrase.
create table if not exists public.user_vault (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  salt       text        not null,            -- base64, 16 random bytes
  iterations int         not null default 600000,
  verifier   text        not null,            -- encryptField("keepsake-vault-v1", masterKey)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per (user, share): that letter's key, wrapped with the user's master key.
create table if not exists public.vault_keys (
  user_id     uuid        not null references auth.users(id) on delete cascade,
  share_id    text        not null references public.shares(id) on delete cascade,
  wrapped_key text        not null,           -- encryptField(rawKeyB64, masterKey)
  created_at  timestamptz not null default now(),
  primary key (user_id, share_id)
);

alter table public.user_vault enable row level security;
alter table public.vault_keys enable row level security;

-- Each user can only touch their own rows (mirrors received_shares.sql).
create policy "view own vault"   on public.user_vault for select using (auth.uid() = user_id);
create policy "insert own vault" on public.user_vault for insert with check (auth.uid() = user_id);
create policy "update own vault" on public.user_vault for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own vault" on public.user_vault for delete using (auth.uid() = user_id);

create policy "view own vault keys"   on public.vault_keys for select using (auth.uid() = user_id);
create policy "insert own vault keys" on public.vault_keys for insert with check (auth.uid() = user_id);
create policy "update own vault keys" on public.vault_keys for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own vault keys" on public.vault_keys for delete using (auth.uid() = user_id);
