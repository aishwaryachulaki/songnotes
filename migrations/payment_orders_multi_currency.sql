-- Add multi-currency support to payment_orders table
-- Rename amount_paise to amount_units (more generic) and add currency column
-- Safe to run repeatedly (uses IF NOT EXISTS)

-- Run this once in the Supabase SQL editor after deploying the updated edge functions.

alter table public.payment_orders
  rename column amount_paise to amount_units;

alter table public.payment_orders
  add column if not exists currency text not null default 'INR';

-- Add an index on currency for faster lookups if needed
create index if not exists idx_payment_orders_currency on public.payment_orders(currency);
