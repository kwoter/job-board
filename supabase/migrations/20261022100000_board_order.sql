-- Running order (2026-10-22): Andy can see everything on Louis's list, put it in the order he
-- wants it done and move jobs to the top. The board sorts by `position` (lowest first) within
-- each column. A new job with no position goes to the top of its list.
alter table public.board_jobs add column if not exists position double precision;

-- Keep today's order as the starting order: due date, then priority, then newest.
with ranked as (
  select id, row_number() over (
    partition by user_id, status
    order by due_at nulls last,
             case priority when 'high' then 0 when 'low' then 2 else 1 end,
             created_at desc) as rn
  from public.board_jobs)
update public.board_jobs j set position = r.rn from ranked r where r.id = j.id and j.position is null;

create or replace function public.board_jobs_top_position() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.position is null then
    select coalesce(min(position), 1) - 1 into new.position from public.board_jobs where user_id = new.user_id;
  end if;
  return new;
end $$;

drop trigger if exists board_jobs_top_position on public.board_jobs;
create trigger board_jobs_top_position before insert on public.board_jobs
  for each row execute function public.board_jobs_top_position();

-- Members now see the whole of a list shared with them, and can change any job on it
-- (order, status, details). They can still only delete the jobs they added themselves.
drop policy if exists "jobs you sent" on public.board_jobs;
drop policy if exists "jobs on a shared list" on public.board_jobs;
create policy "jobs on a shared list" on public.board_jobs for select using (
  created_by = auth.uid() or exists (
    select 1 from public.board_shares s where s.owner_id = board_jobs.user_id and s.member_id = auth.uid()));

drop policy if exists "change jobs you sent" on public.board_jobs;
drop policy if exists "change jobs on a shared list" on public.board_jobs;
create policy "change jobs on a shared list" on public.board_jobs for update
  using (exists (
    select 1 from public.board_shares s where s.owner_id = board_jobs.user_id and s.member_id = auth.uid()))
  with check (exists (
    select 1 from public.board_shares s where s.owner_id = board_jobs.user_id and s.member_id = auth.uid()));

revoke execute on function public.board_jobs_top_position() from public, anon, authenticated;
