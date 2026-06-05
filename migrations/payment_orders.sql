-- payment_orders: records every Razorpay order the server creates, so that when
-- a payment comes back to verify-razorpay-payment, the credits granted are derived
-- from the SERVER's record of what was ordered — never from client-supplied values.
-- The status flip created -> fulfilled is also the replay/idempotency guard.
--
-- Only the edge functions (service role) touch this table. RLS is on with NO
-- policies, so anon/authenticated get nothing; the service role bypasses RLS.
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.payment_orders (
  order_id     text        primary key,           -- Razorpay order id
  user_id      uuid        not null references auth.users(id) on delete cascade,
  package_id   text        not null,              -- key into the server catalog
  amount_paise int         not null,
  status       text        not null default 'created',  -- 'created' | 'fulfilled'
  payment_id   text,
  created_at   timestamptz not null default now(),
  fulfilled_at timestamptz
);

alter table public.payment_orders enable row level security;
-- (intentionally no policies — service role only)
