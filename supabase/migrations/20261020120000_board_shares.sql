-- Shared lists (2026-10-20): a member can add jobs to an owner's list as well as keep their own.
-- The member sees and can change only the jobs they sent there, never the owner's other jobs.
-- The owner gets a push for each job someone else adds (board-push, via notified_at).
create table if not exists public.board_shares (
  owner_id uuid not null references auth.users(id) on delete cascade,
  member_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, member_id),
  check (owner_id <> member_id)
);
alter table public.board_shares enable row level security;

drop policy if exists "see your shares" on public.board_shares;
create policy "see your shares" on public.board_shares for select
  using (owner_id = auth.uid() or member_id = auth.uid());

alter table public.board_jobs add column if not exists created_by uuid references auth.users(id) on delete set null default auth.uid();
alter table public.board_jobs add column if not exists notified_at timestamptz;
update public.board_jobs set created_by = user_id where created_by is null;

drop policy if exists "add to a shared list" on public.board_jobs;
create policy "add to a shared list" on public.board_jobs for insert
  with check (created_by = auth.uid() and exists (
    select 1 from public.board_shares s where s.owner_id = board_jobs.user_id and s.member_id = auth.uid()));

drop policy if exists "jobs you sent" on public.board_jobs;
create policy "jobs you sent" on public.board_jobs for select using (created_by = auth.uid());

drop policy if exists "change jobs you sent" on public.board_jobs;
create policy "change jobs you sent" on public.board_jobs for update
  using (created_by = auth.uid() and user_id <> auth.uid())
  with check (created_by = auth.uid() and exists (
    select 1 from public.board_shares s where s.owner_id = board_jobs.user_id and s.member_id = auth.uid()));

drop policy if exists "delete jobs you sent" on public.board_jobs;
create policy "delete jobs you sent" on public.board_jobs for delete
  using (created_by = auth.uid() and user_id <> auth.uid());

-- Names of the people you share with (so "Louis's list" and "From Andy" can be shown).
drop policy if exists "read linked profiles" on public.board_profiles;
create policy "read linked profiles" on public.board_profiles for select using (exists (
  select 1 from public.board_shares s
  where (s.owner_id = board_profiles.user_id and s.member_id = auth.uid())
     or (s.member_id = board_profiles.user_id and s.owner_id = auth.uid())));

-- Andy can add to Louis's list.
insert into public.board_shares (owner_id, member_id)
select o.user_id, m.user_id from public.board_profiles o, public.board_profiles m
where o.username = 'louis' and m.username = 'andy'
on conflict do nothing;
