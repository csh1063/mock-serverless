// ===================================================================
// Vercel Serverless Function: 하루치 일정의 구간별 경로를 한 번에 계산
// POST /api/travel/route/day
// Body: { "items": [{ "id","lat","lng","mode","noRoute" }, ...] }  (이미 날짜/순서 정렬됨)
// Response: { "legs": [{ fromItemId,toItemId,mode,status,polyline,steps,distanceMeters,durationSec }] }
//
// status: "OK" | "NO_ROUTE" | "SKIPPED"
//   - SKIPPED: noRoute:true 이거나 좌표가 없는 경우
//   - NO_ROUTE: 실제 경로 탐색을 시도했지만 실패
// 한 구간이 실패해도 배치 전체를 실패시키지 않는다.
//
// 이동수단 결정 규칙(앱의 "걷기/대중교통/차" 3단계 선택과 대응):
//   - mode === 'car' (사용자가 명시적으로 "차"를 고른 경우)만 실제 자동차 경로를 구한다.
//   - 그 외(걷기를 골랐든, 대중교통을 골랐든, 아무것도 안 정했든)는 항상 걷기와 대중교통
//     경로를 둘 다 구해서 비교한다 — 대중교통이 걷기보다 확실히(MIN_TRANSIT_TIME_SAVED_SEC
//     이상) 빠를 때만 대중교통을 추천하고, 별 차이 없으면 그냥 걷기를 추천한다. "차"만 이
//     비교에서 제외되는 이유는 차는 사용자가 이미 확정한 선택(렌트/택시 등)이라 검색이
//     걷기와 비교해서 되돌릴 이유가 없기 때문.
//
// route_cache 테이블에 좌표(소수점 5자리 반올림)+수단 단위로 캐싱해서 같은 구간을
// 여러 사용자가 반복 조회해도 Google API 쿼터를 아낀다. 걷기/대중교통 비교 결과는 'auto'라는
// 별도 수단 키로 캐싱한다(실제로 뭘 골랐는지는 응답 안 mode 필드에 들어있음).
// ===================================================================

import { fetchDirections } from '#lib/directions';
import { supabase } from '#lib/supabaseClient';
import { verifyUser } from '#lib/verifyUser';

// Google transit_details.line.vehicle.type → 우리 TransportMode rawValue.
// TravelerAnimationEngine.mapVehicleToMode(Swift)와 동일하게 맞춘 매핑.
const VEHICLE_TO_MODE = {
    SUBWAY: 'metro',
    METRO_RAIL: 'metro',
    TRAM: 'tram',
    LIGHT_RAIL: 'tram',
    BUS: 'bus',
    INTERCITY_BUS: 'bus',
    TROLLEYBUS: 'bus',
    SHARE_TAXI: 'bus',
    HEAVY_RAIL: 'train',
    RAIL: 'train',
    COMMUTER_TRAIN: 'train',
    HIGH_SPEED_TRAIN: 'train',
    LONG_DISTANCE_TRAIN: 'train',
    FUNICULAR: 'funicular',
    GONDOLA_LIFT: 'gondola',
    CABLE_CAR: 'gondola',
    FERRY: 'boat',
};

// 대중교통이 걷기보다 이만큼(초) 이상 빨라야 "확실히 빠르다"고 보고 추천한다.
// 이보다 적게 아끼는 거면 갈아타고 기다리느니 그냥 걷는 게 나으므로 걷기를 추천.
const MIN_TRANSIT_TIME_SAVED_SEC = 5 * 60;

function round5(n) {
    return Math.round(n * 1e5) / 1e5;
}

// 실제로 탄 구간(도보 제외) 중 가장 긴 구간의 수단을 그 leg의 대표 수단으로 삼는다.
function inferModeFromSteps(steps) {
    let best = null;
    let bestDistance = -1;
    for (const step of steps || []) {
        if (step.travelMode === 'WALKING') continue;
        const mapped = VEHICLE_TO_MODE[step.vehicleType] || 'train';
        if (step.distanceMeters > bestDistance) {
            bestDistance = step.distanceMeters;
            best = mapped;
        }
    }
    return best || 'walk';
}

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

    const user = await verifyUser(req);
    if (!user) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length < 2) {
        return res.status(200).json({ legs: [] });
    }

    const legs = [];
    for (let i = 0; i < items.length - 1; i++) {
        const from = items[i];
        const to = items[i + 1];
        legs.push(await resolveLeg(from, to));
    }

    return res.status(200).json({ legs });
}

async function resolveLeg(from, to) {
    const base = { fromItemId: from.id, toItemId: to.id };

    if (to.noRoute) {
        return { ...base, mode: to.mode || 'walk', status: 'SKIPPED' };
    }
    if (from.lat == null || from.lng == null || to.lat == null || to.lng == null) {
        return { ...base, mode: to.mode || 'walk', status: 'SKIPPED' };
    }

    if (to.mode === 'car') {
        return await resolveCar(base, from, to);
    }
    return await resolveWalkOrTransit(base, from, to);
}

async function resolveCar(base, from, to) {
    const originLat = round5(from.lat);
    const originLng = round5(from.lng);
    const destLat = round5(to.lat);
    const destLng = round5(to.lng);

    const cached = await lookupCache(originLat, originLng, destLat, destLng, 'car');
    if (cached) return { ...base, mode: 'car', ...cached };

    const result = await tryGoogleMode(originLat, originLng, destLat, destLng, 'driving', 'car');
    if (!result) return { ...base, mode: 'car', status: 'NO_ROUTE' };

    const legResult = {
        status: 'OK',
        polyline: result.polyline,
        steps: result.steps,
        distanceMeters: result.distanceMeters,
        durationSec: result.durationSec,
    };
    writeCache(originLat, originLng, destLat, destLng, 'car', legResult).catch(() => {});
    return { ...base, mode: 'car', ...legResult };
}

async function resolveWalkOrTransit(base, from, to) {
    const originLat = round5(from.lat);
    const originLng = round5(from.lng);
    const destLat = round5(to.lat);
    const destLng = round5(to.lng);

    const cached = await lookupCache(originLat, originLng, destLat, destLng, 'auto');
    if (cached) return { ...base, ...cached };

    const [walkResult, transitResult] = await Promise.all([
        tryGoogleMode(originLat, originLng, destLat, destLng, 'walking', 'walk'),
        tryGoogleMode(originLat, originLng, destLat, destLng, 'transit', null),
    ]);
    if (transitResult) {
        transitResult.mode = inferModeFromSteps(transitResult.steps);
    }

    let resolved;
    if (walkResult && transitResult) {
        const timeSaved = walkResult.durationSec - transitResult.durationSec;
        resolved = timeSaved >= MIN_TRANSIT_TIME_SAVED_SEC ? transitResult : walkResult;
    } else {
        resolved = walkResult || transitResult;
    }

    if (!resolved) {
        return { ...base, mode: 'walk', status: 'NO_ROUTE' };
    }

    const legResult = {
        status: 'OK',
        mode: resolved.mode,
        polyline: resolved.polyline,
        steps: resolved.steps,
        distanceMeters: resolved.distanceMeters,
        durationSec: resolved.durationSec,
    };
    writeCache(originLat, originLng, destLat, destLng, 'auto', legResult).catch(() => {});
    return { ...base, ...legResult };
}

async function tryGoogleMode(originLat, originLng, destLat, destLng, googleMode, fixedMode) {
    try {
        const result = await fetchDirections({
            olat: originLat,
            olng: originLng,
            dlat: destLat,
            dlng: destLng,
            mode: googleMode,
        });
        if (result.status !== 'OK') return null;
        return {
            mode: fixedMode,
            polyline: result.polyline,
            steps: result.steps,
            distanceMeters: result.distanceMeters,
            durationSec: result.durationSec,
        };
    } catch {
        return null;
    }
}

async function lookupCache(originLat, originLng, destLat, destLng, mode) {
    const { data, error } = await supabase
        .from('route_cache')
        .select('status, response')
        .eq('origin_lat', originLat)
        .eq('origin_lng', originLng)
        .eq('dest_lat', destLat)
        .eq('dest_lng', destLng)
        .eq('mode', mode)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error || !data) return null;
    if (data.status !== 'OK') return null;
    return { status: 'OK', ...data.response };
}

async function writeCache(originLat, originLng, destLat, destLng, mode, legResult) {
    await supabase.from('route_cache').insert({
        origin_lat: originLat,
        origin_lng: originLng,
        dest_lat: destLat,
        dest_lng: destLng,
        mode,
        status: legResult.status,
        response: legResult,
    });
}
