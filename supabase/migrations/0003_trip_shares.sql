-- 여행 공유 링크 (전체공개 / 비공개+비밀번호)
-- 실행 방법: Supabase 대시보드 > SQL Editor에 전체 붙여넣고 실행 (RUN)

-- =========================================================
-- trip_shares — 여행당 링크 1개(trip_id UNIQUE), 설정 변경 시 토큰은 유지
-- =========================================================
create table public.trip_shares (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null unique references public.trips (id) on delete cascade,
  token text not null unique,
  visibility text not null default 'public'
    check (visibility in ('public', 'password')),
  password_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index trip_shares_token_idx on public.trip_shares (token);

alter table public.trip_shares enable row level security;

create policy "trip_shares_all_via_trip_owner"
  on public.trip_shares for all
  using (exists (
    select 1 from public.trips t
    where t.id = trip_shares.trip_id and t.owner_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.trips t
    where t.id = trip_shares.trip_id and t.owner_id = auth.uid()
  ));

-- 공유 링크 생성/수정 — security invoker라 호출자(owner) RLS 그대로 적용.
-- trip_id UNIQUE라 upsert하면 "설정 변경 = 기존 링크 업데이트, 토큰 유지"가 자연히 만족된다.
create function public.upsert_trip_share(
  p_trip_id uuid,
  p_visibility text,
  p_password text default null
) returns public.trip_shares
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.trip_shares;
begin
  insert into trip_shares (trip_id, token, visibility, password_hash)
  values (
    p_trip_id,
    translate(encode(gen_random_bytes(9), 'base64'), '+/', '-_'),
    p_visibility,
    case when p_visibility = 'password' and p_password is not null
         then crypt(p_password, gen_salt('bf')) end
  )
  on conflict (trip_id) do update
    set visibility = excluded.visibility,
        password_hash = case when excluded.visibility = 'password' and p_password is not null
                              then excluded.password_hash
                              when excluded.visibility = 'public' then null
                              else trip_shares.password_hash end,
        updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

-- 공유 중지 — 다시 공유하면 새 토큰이 발급된다.
create function public.revoke_trip_share(p_trip_id uuid)
returns void
language sql
security invoker
set search_path = public
as $$
  delete from trip_shares where trip_id = p_trip_id;
$$;

-- 공개 조회 — security definer로 RLS 우회하지만, 토큰(+필요시 비밀번호) 검증을
-- 통과했을 때만 예산/결제/메모를 뺀 딱 필요한 필드만 반환한다.
create function public.get_shared_trip(p_token text, p_password text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share public.trip_shares%rowtype;
  v_result jsonb;
begin
  select * into v_share from trip_shares where token = p_token;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;

  if v_share.visibility = 'password' then
    if p_password is null or v_share.password_hash is null
       or crypt(p_password, v_share.password_hash) <> v_share.password_hash then
      return jsonb_build_object('error', 'password_required');
    end if;
  end if;

  select jsonb_build_object(
    'trip', jsonb_build_object('id', t.id, 'name', t.name, 'startDate', t.start_date, 'endDate', t.end_date),
    'countries', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'countryCode', c.country_code, 'color', c.color, 'sortOrder', c.sort_order
      ) order by c.sort_order), '[]'::jsonb)
      from trip_countries c where c.trip_id = t.id
    ),
    'days', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id, 'countryCode', d.country_code, 'dayDate', d.day_date, 'dayIndex', d.day_index
      ) order by d.day_index), '[]'::jsonb)
      from trip_days d where d.trip_id = t.id
    ),
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', i.id, 'dayId', i.day_id, 'sortOrder', i.sort_order, 'itemType', i.item_type,
        'arrivalMode', i.arrival_mode, 'name', i.name, 'lat', i.lat, 'lng', i.lng
      ) order by i.day_id, i.sort_order), '[]'::jsonb)
      from itinerary_items i where i.trip_id = t.id
    ),
    'routeLegs', (
      select coalesce(jsonb_object_agg(r.day_id, r.legs), '{}'::jsonb)
      from trip_route_legs r where r.trip_id = t.id
    )
  ) into v_result
  from trips t where t.id = v_share.trip_id;

  return v_result;
end;
$$;

grant execute on function public.get_shared_trip(text, text) to anon;

-- =========================================================
-- 웹(공유 링크)에서 "오늘 경로 갱신"을 익명으로 호출할 때 쓰는 좁은 통로 2개.
-- 둘 다 security definer로 RLS를 우회하지만, 토큰으로 확인된 트립의 "그 날짜" 한
-- 건에만 한정된다 — password_hash 등 다른 필드는 절대 안 돌려준다.
-- =========================================================

-- 쿨다운 체크 + 재계산에 필요한 좌표를 한 번에 가져온다.
create function public.get_shared_trip_day_for_refresh(p_token text, p_day_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trip_id uuid;
  v_result jsonb;
begin
  select trip_id into v_trip_id from trip_shares where token = p_token;
  if v_trip_id is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if not exists (select 1 from trip_days where id = p_day_id and trip_id = v_trip_id) then
    return jsonb_build_object('error', 'not_found');
  end if;

  select jsonb_build_object(
    'tripId', v_trip_id,
    'legs', coalesce(r.legs, '[]'::jsonb),
    'updatedAt', r.updated_at,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', i.id, 'lat', i.lat, 'lng', i.lng, 'mode', i.arrival_mode, 'noRoute', i.no_route
      ) order by i.sort_order), '[]'::jsonb)
      from itinerary_items i where i.day_id = p_day_id
    )
  ) into v_result
  from (select 1) dummy
  left join trip_route_legs r on r.day_id = p_day_id;

  return v_result;
end;
$$;

grant execute on function public.get_shared_trip_day_for_refresh(text, uuid) to anon;

-- 재계산된 legs를 저장한다. p_day_id가 진짜 그 토큰이 가리키는 트립 소속인지 다시 확인한다.
create function public.save_shared_trip_day_legs(p_token text, p_day_id uuid, p_legs jsonb)
returns public.trip_route_legs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trip_id uuid;
  v_row public.trip_route_legs%rowtype;
begin
  select trip_id into v_trip_id from trip_shares where token = p_token;
  if v_trip_id is null or not exists (
    select 1 from trip_days where id = p_day_id and trip_id = v_trip_id
  ) then
    raise exception 'forbidden';
  end if;

  insert into trip_route_legs (day_id, trip_id, legs, updated_at)
  values (p_day_id, v_trip_id, p_legs, now())
  on conflict (day_id) do update
    set legs = excluded.legs, updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.save_shared_trip_day_legs(text, uuid, jsonb) to anon;
