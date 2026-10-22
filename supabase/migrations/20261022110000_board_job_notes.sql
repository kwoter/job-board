-- Notepads on jobs (2026-10-22): a note can be attached to a job on your own list or on a list
-- shared with you, new or existing. Anyone who can see the job can open that notepad to read it;
-- only the person who wrote it can change it.
alter table public.board_jobs add column if not exists note_id uuid references public.board_notes(id) on delete set null;
create index if not exists board_jobs_note_idx on public.board_jobs (note_id) where note_id is not null;

drop policy if exists "read notes on jobs you can see" on public.board_notes;
create policy "read notes on jobs you can see" on public.board_notes for select using (exists (
  select 1 from public.board_jobs j
  where j.note_id = board_notes.id
    and (j.user_id = auth.uid() or exists (
      select 1 from public.board_shares s where s.owner_id = j.user_id and s.member_id = auth.uid()))));
