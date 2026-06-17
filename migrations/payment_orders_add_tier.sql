-- Add tier column to payment_orders to track which pricing tier was used
-- Run this once in the Supabase SQL editor after deploying the updated edge functions.

alter table public.payment_orders
  add column if not exists tier int not null default 1;

-- Add an index for faster lookups
create index if not exists idx_payment_orders_tier on public.payment_orders(tier);
