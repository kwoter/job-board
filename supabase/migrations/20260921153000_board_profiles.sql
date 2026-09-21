-- Accounts (2026-09-21): one profile per person. Accounts are created by an admin through the
-- board-accounts edge function (service role, checks is_admin). Reminders are per-owner in
-- board-push from the same date. Edge function sources live in the Supabase project.
create table if not exists public.board_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9][a-z0-9._-]{1,23}$'),
  display_name text not null check (char_length(display_name) between 1 and 40),
  is_admin boolean not null default false,
  pin_length smallint not null default 6 check (pin_length between 4 and 8),
  created_at timestamptz not null default now()
);

alter table public.board_profiles enable row level security;

drop policy if exists "read own profile" on public.board_profiles;
create policy "read own profile"
  on public.board_profiles for select
  using (user_id = auth.uid());

insert into public.board_profiles (user_id, username, display_name, is_admin, pin_length)
select id, 'louis', 'Louis', true, 4 from auth.users where email = 'media@kwoter.co.uk'
on conflict (user_id) do nothing;
