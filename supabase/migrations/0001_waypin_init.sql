-- Waypin (여행 일정 앱) 초기 스키마
-- 실행 방법: Supabase 대시보드 > SQL Editor에 전체 붙여넣고 실행 (RUN)
-- 이 프로젝트의 다른 앱(moa, walkie)과 같은 Supabase 프로젝트를 공유하므로
-- 테이블명은 travel/Waypin 전용으로 짓되, 별도 스키마는 만들지 않고 public에 둠.

create extension if not exists pgcrypto;

-- =========================================================
-- profiles
-- =========================================================
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar_url text,
  preferred_currency text not null default 'KRW',
  locale text not null default 'ko',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (id = auth.uid());

create policy "profiles_update_own"
  on public.profiles for update
  using (id = auth.uid());

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (id = auth.uid());

-- 첫 로그인 시 auth.users에 새 유저가 생기면 profiles 행을 자동 생성
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =========================================================
-- trips
-- =========================================================
create table public.trips (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  start_date date not null,
  end_date date not null,
  status text not null default 'planning'
    check (status in ('planning', 'confirmed', 'completed', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);

create index trips_owner_id_idx on public.trips (owner_id);

alter table public.trips enable row level security;

create policy "trips_all_own"
  on public.trips for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- =========================================================
-- trip_countries
-- =========================================================
create table public.trip_countries (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  country_code text not null,
  color text not null,
  sort_order int not null default 0,
  unique (trip_id, country_code)
);

alter table public.trip_countries enable row level security;

create policy "trip_countries_all_via_trip_owner"
  on public.trip_countries for all
  using (exists (
    select 1 from public.trips t
    where t.id = trip_countries.trip_id and t.owner_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.trips t
    where t.id = trip_countries.trip_id and t.owner_id = auth.uid()
  ));

-- =========================================================
-- trip_days
-- =========================================================
create table public.trip_days (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  country_code text not null,
  day_date date not null,
  day_index int not null,
  label text,
  unique (trip_id, day_date)
);

create index trip_days_trip_id_idx on public.trip_days (trip_id);

alter table public.trip_days enable row level security;

create policy "trip_days_all_via_trip_owner"
  on public.trip_days for all
  using (exists (
    select 1 from public.trips t
    where t.id = trip_days.trip_id and t.owner_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.trips t
    where t.id = trip_days.trip_id and t.owner_id = auth.uid()
  ));

-- =========================================================
-- itinerary_items
-- =========================================================
create table public.itinerary_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  day_id uuid not null references public.trip_days (id) on delete cascade,
  sort_order int not null default 0,

  item_type text not null default 'sight'
    check (item_type in ('start', 'sight', 'meal', 'lodge', 'transport', 'activity', 'shopping', 'free_time', 'other')),
  arrival_mode text
    check (arrival_mode in ('start', 'walk', 'tram', 'metro', 'train', 'bus', 'gondola', 'funicular', 'car', 'boat')),
  planned_duration_min int,
  no_route boolean not null default false,

  name text not null,
  place_id text,
  lat double precision,
  lng double precision,
  address text,

  source text not null default 'manual'
    check (source in ('manual', 'link', 'share_extension')),
  source_url text,

  start_time time,
  cost_amount numeric(12, 2),
  cost_currency text,
  cost_amount_krw numeric(12, 2),
  cost_category text
    check (cost_category in ('entrance', 'transport', 'food', 'lodging', 'shopping', 'activity', 'other')),
  payment_status text
    check (payment_status in ('paid', 'fixed', 'pending', 'variable', 'passinc', 'free')),
  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index itinerary_items_trip_id_idx on public.itinerary_items (trip_id);
create index itinerary_items_day_sort_idx on public.itinerary_items (day_id, sort_order);

alter table public.itinerary_items enable row level security;

create policy "itinerary_items_all_via_trip_owner"
  on public.itinerary_items for all
  using (exists (
    select 1 from public.trips t
    where t.id = itinerary_items.trip_id and t.owner_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.trips t
    where t.id = itinerary_items.trip_id and t.owner_id = auth.uid()
  ));

-- 드래그앤드롭 재정렬을 한 번의 트랜잭션으로 반영하는 RPC
-- p_updates 예: '[{"id":"...","day_id":"...","sort_order":0}, ...]'::jsonb
create function public.reorder_itinerary_items(p_updates jsonb)
returns void
language plpgsql
security invoker
as $$
begin
  update public.itinerary_items as it
  set
    day_id = (u.value ->> 'day_id')::uuid,
    sort_order = (u.value ->> 'sort_order')::int,
    updated_at = now()
  from jsonb_array_elements(p_updates) as u(value)
  where it.id = (u.value ->> 'id')::uuid;
end;
$$;

-- =========================================================
-- route_cache — 사용자 간 공유되는 서버측 경로 캐시 (PII 없음)
-- =========================================================
create table public.route_cache (
  id bigint generated always as identity primary key,
  origin_lat double precision not null,
  origin_lng double precision not null,
  dest_lat double precision not null,
  dest_lng double precision not null,
  mode text not null,
  status text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days')
);

create index route_cache_lookup_idx
  on public.route_cache (origin_lat, origin_lng, dest_lat, dest_lng, mode);

alter table public.route_cache enable row level security;

create policy "route_cache_select_all"
  on public.route_cache for select
  using (true);

create policy "route_cache_insert_all"
  on public.route_cache for insert
  with check (true);
