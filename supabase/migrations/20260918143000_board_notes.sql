create table if not exists public.board_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default 'Untitled note',
  drawing jsonb not null default '{"version":1,"strokes":[]}'::jsonb,
  clean_text text not null default '',
  page_style text not null default 'dot' check (page_style in ('dot', 'ruled', 'plain')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.board_notes enable row level security;

drop policy if exists "Users can read their own notes" on public.board_notes;
create policy "Users can read their own notes"
  on public.board_notes for select
  using (auth.uid() = user_id);

drop policy if exists "Users can create their own notes" on public.board_notes;
create policy "Users can create their own notes"
  on public.board_notes for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own notes" on public.board_notes;
create policy "Users can update their own notes"
  on public.board_notes for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own notes" on public.board_notes;
create policy "Users can delete their own notes"
  on public.board_notes for delete
  using (auth.uid() = user_id);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'board_notes'
  ) then
    alter publication supabase_realtime add table public.board_notes;
  end if;
end
$$;

create index if not exists board_notes_user_updated_idx
  on public.board_notes (user_id, updated_at desc);
