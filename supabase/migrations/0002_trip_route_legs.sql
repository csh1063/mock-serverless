-- 트립 단위로 저장되는 경로 결과 ("전체 경로 탐색"/"오늘 경로 갱신" 결과 저장소)
-- 실행 방법: Supabase 대시보드 > SQL Editor에 전체 붙여넣고 실행 (RUN)

alter table public.trips add column last_full_route_search_at timestamptz;

create table public.trip_route_legs (
  day_id uuid primary key references public.trip_days (id) on delete cascade,
  trip_id uuid not null references public.trips (id) on delete cascade,
  legs jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

create index trip_route_legs_trip_id_idx on public.trip_route_legs (trip_id);

alter table public.trip_route_legs enable row level security;

create policy "trip_route_legs_all_via_trip_owner"
  on public.trip_route_legs for all
  using (exists (
    select 1 from public.trips t
    where t.id = trip_route_legs.trip_id and t.owner_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.trips t
    where t.id = trip_route_legs.trip_id and t.owner_id = auth.uid()
  ));
