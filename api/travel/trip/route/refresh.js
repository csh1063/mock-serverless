// ===================================================================
// Vercel Serverless Function: 트립 단위로 저장된 경로를 갱신한다
// POST /api/travel/trip/route/refresh
// Body: { tripId, dayId?, scope: 'all' | 'today', shareToken? }
//
// 인증 분기:
//   - shareToken 있음(웹/공유 링크에서 온 요청) — 유저 세션이 없으므로 토큰으로만
//     신원을 확인하고, scope은 무조건 'today'로 강제한다(웹엔 "오늘 경로 갱신"만
//     있음). 이 경로는 RLS를 우회하는 security definer RPC 2개
//     (get_shared_trip_day_for_refresh / save_shared_trip_day_legs)로만 데이터에
//     접근한다 — 그 토큰이 가리키는 트립의 "그 날짜" 한 건 밖으로는 못 나간다.
//   - shareToken 없음(앱에서 온 요청) — Authorization Bearer 토큰을 그대로 실어
//     보내는 사용자 전용 Supabase 클라이언트를 만들어서, 기존 owner-only RLS가
//     자연스럽게(auth.uid() 매칭) 적용되게 한다. day.js의 verifyUser 401 게이트와
//     달리 여기서는 실제로 그 유저 권한으로 테이블에 접근해야 하므로 앱 경로
//     전용으로 세션 클라이언트를 새로 만든다.
//
// 쿨다운 판단은 항상 서버가 최종 결정한다 — 클라이언트(앱/웹)는 몇 분 남았는지
// 몰라도 되고, 쿨다운 중이어도 "방금 갱신된 것 같은" 응답을 그대로 받는다(저장된
// 최신값을 그대로 돌려줌). 실제 재계산 여부는 응답 모양으로 구분되지 않는다.
//
// 거리 이상치 가드(isPlausibleDistance)는 day.js의 computeDayLegs를 그대로
// 재사용하므로 이 엔드포인트에서도 동일하게 적용된다.
// ===================================================================

import { createClient } from '@supabase/supabase-js';
import { supabase } from '#lib/supabaseClient';
import { verifyUser } from '#lib/verifyUser';
import { computeDayLegs } from '../../route/day.js';

const FULL_SEARCH_COOLDOWN_MS = 60 * 60 * 1000; // 전체 경로 탐색: 1시간
const TODAY_REFRESH_COOLDOWN_MS = 10 * 60 * 1000; // 오늘 경로 갱신: 10분

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { tripId, dayId, scope, shareToken } = req.body || {};
    if (!tripId || (scope !== 'all' && scope !== 'today')) {
        return res.status(400).json({ error: 'invalid_request' });
    }

    if (shareToken) {
        return await handleSharedRefresh(res, shareToken, dayId);
    }
    return await handleOwnerRefresh(req, res, tripId, dayId, scope);
}

// ------------------------- 웹(공유 링크) 경로 -------------------------

async function handleSharedRefresh(res, shareToken, dayId) {
    if (!dayId) {
        return res.status(400).json({ error: 'invalid_request' });
    }

    const { data, error } = await supabase.rpc('get_shared_trip_day_for_refresh', {
        p_token: shareToken,
        p_day_id: dayId,
    });
    if (error || !data || data.error) {
        return res.status(404).json({ error: 'not_found' });
    }

    if (isWithinCooldown(data.updatedAt, TODAY_REFRESH_COOLDOWN_MS)) {
        return res.status(200).json({ days: [{ dayId, legs: data.legs }] });
    }

    const legs = await computeDayLegs(data.items);
    await supabase.rpc('save_shared_trip_day_legs', {
        p_token: shareToken,
        p_day_id: dayId,
        p_legs: legs,
    });

    return res.status(200).json({ days: [{ dayId, legs }] });
}

// ------------------------- 앱 경로 -------------------------

async function handleOwnerRefresh(req, res, tripId, dayId, scope) {
    const user = await verifyUser(req);
    if (!user) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    // RLS(owner-only)가 auth.uid()로 자연스럽게 적용되도록, 이 요청의 Bearer 토큰을
    // 그대로 실어 보내는 사용자 전용 클라이언트를 만든다 — 이후 이 클라이언트로 하는
    // 모든 조회/저장은 "이 트립 소유자"인지를 우리가 따로 필터링할 필요 없이 DB가
    // 알아서 막아준다.
    const token = req.headers.authorization.slice('Bearer '.length);
    const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: trip, error: tripError } = await userClient
        .from('trips')
        .select('id, last_full_route_search_at')
        .eq('id', tripId)
        .maybeSingle();
    if (tripError || !trip) {
        return res.status(404).json({ error: 'not_found' });
    }

    if (scope === 'today') {
        if (!dayId) {
            return res.status(400).json({ error: 'invalid_request' });
        }
        const legs = await refreshDay(userClient, tripId, dayId, TODAY_REFRESH_COOLDOWN_MS);
        return res.status(200).json({ days: [{ dayId, legs }] });
    }

    // scope === 'all'
    if (isWithinCooldown(trip.last_full_route_search_at, FULL_SEARCH_COOLDOWN_MS)) {
        const { data: rows } = await userClient.from('trip_route_legs').select('day_id, legs').eq('trip_id', tripId);
        return res.status(200).json({ days: (rows || []).map((r) => ({ dayId: r.day_id, legs: r.legs })) });
    }

    const { data: days } = await userClient
        .from('trip_days')
        .select('id')
        .eq('trip_id', tripId)
        .order('day_index');

    const results = [];
    for (const day of days || []) {
        // 전체 탐색은 트립 단위 1시간 쿨다운으로 이미 걸렀으니, 날짜별 10분 쿨다운은
        // 여기서 또 안 본다(방금 막 지났는데 "10분 전에 갱신됨"이라고 스킵되면 안 됨).
        const legs = await refreshDay(userClient, tripId, day.id, 0);
        results.push({ dayId: day.id, legs });
    }

    await userClient.from('trips').update({ last_full_route_search_at: new Date().toISOString() }).eq('id', tripId);

    return res.status(200).json({ days: results });
}

async function refreshDay(client, tripId, dayId, cooldownMs) {
    const { data: existing } = await client
        .from('trip_route_legs')
        .select('legs, updated_at')
        .eq('day_id', dayId)
        .maybeSingle();

    if (existing && isWithinCooldown(existing.updated_at, cooldownMs)) {
        return existing.legs;
    }

    const { data: items } = await client
        .from('itinerary_items')
        .select('id, lat, lng, arrival_mode, no_route')
        .eq('day_id', dayId)
        .order('sort_order');

    const requestItems = (items || []).map((item) => ({
        id: item.id,
        lat: item.lat,
        lng: item.lng,
        mode: item.arrival_mode,
        noRoute: item.no_route,
    }));

    const legs = await computeDayLegs(requestItems);

    await client.from('trip_route_legs').upsert({
        day_id: dayId,
        trip_id: tripId,
        legs,
        updated_at: new Date().toISOString(),
    });

    return legs;
}

function isWithinCooldown(timestamp, cooldownMs) {
    if (!timestamp) return false;
    return Date.now() - new Date(timestamp).getTime() < cooldownMs;
}
