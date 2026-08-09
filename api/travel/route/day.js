// ===================================================================
// Vercel Serverless Function: 하루치 일정의 구간별 경로를 한 번에 계산
// POST /api/travel/route/day
// Body: { "items": [{ "id","lat","lng","mode","noRoute" }, ...] }  (이미 날짜/순서 정렬됨)
// Response: { "legs": [{ fromItemId,toItemId,mode,status,polyline,steps,distanceMeters,durationSec }] }
//
// status: "OK" | "NO_ROUTE" | "SKIPPED"
//   - SKIPPED: noRoute:true 이거나(명시적으로 수단을 골랐는데) 도로/대중교통 경로가 의미
//              없는 수단(기차/곤돌라/차/배 등) → 클라이언트가 점선 직선으로 대체
//   - NO_ROUTE: 실제 경로 탐색을 시도했지만 실패
// 한 구간이 실패해도 배치 전체를 실패시키지 않는다.
//
// mode가 비어있으면(클라이언트가 특정 수단을 강제하지 않았으면) 예전엔 그냥 'walk'로
// 찍고 걷기 경로를 구했었다 — 그래서 실제론 기차/버스를 타야 하는 먼 거리도 전부 "걷기"로
// 나왔다. 이제 그럴 땐 직선거리를 보고 걷기/대중교통/자동차 중 실제로 되는 걸 순서대로
// 시도해서 자동으로 가장 그럴듯한 수단을 고른다(resolveAuto).
//
// route_cache 테이블에 좌표(소수점 5자리 반올림)+수단 단위로 캐싱해서 같은 구간을
// 여러 사용자가 반복 조회해도 Google API 쿼터를 아낀다. 자동 판단 결과는 'auto'라는
// 별도 수단 키로 캐싱한다(실제로 뭘 골랐는지는 응답 안에 mode로 들어있음).
// ===================================================================

import { fetchDirections } from '#lib/directions';
import { supabase } from '#lib/supabaseClient';
import { verifyUser } from '#lib/verifyUser';

// travel_map.html의 ROAD_MODES와 동일 — "사용자가 명시적으로 이 수단을 골랐을 때"만
// 실제 도로/대중교통 경로를 찾는다. (자동 판단 경로는 이 목록과 무관하게 동작한다.)
const ROUTABLE_MODES = ['walk', 'bus', 'tram', 'metro'];

const MODE_TO_GOOGLE_MODE = {
    walk: 'walking',
    bus: 'transit',
    tram: 'transit',
    metro: 'transit',
};

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

// 이 이내 직선거리는 굳이 대중교통을 찾지 않고 바로 걷기로 시도한다.
const WALK_MAX_METERS = 1200;

function round5(n) {
    return Math.round(n * 1e5) / 1e5;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const R = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
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

    // 사용자가 이 항목에 수단을 명시적으로 골라뒀으면 그 선택을 그대로 존중한다 — 기존과 동일.
    if (to.mode) {
        if (!ROUTABLE_MODES.includes(to.mode)) {
            return { ...base, mode: to.mode, status: 'SKIPPED' };
        }
        return await resolveExplicit(base, from, to, to.mode);
    }

    // 수단 미지정 — 거리를 보고 실제로 되는 수단을 자동으로 찾는다.
    return await resolveAuto(base, from, to);
}

async function resolveExplicit(base, from, to, mode) {
    const originLat = round5(from.lat);
    const originLng = round5(from.lng);
    const destLat = round5(to.lat);
    const destLng = round5(to.lng);

    try {
        const cached = await lookupCache(originLat, originLng, destLat, destLng, mode);
        if (cached) {
            return { ...base, mode, ...cached };
        }

        const result = await fetchDirections({
            olat: originLat,
            olng: originLng,
            dlat: destLat,
            dlng: destLng,
            mode: MODE_TO_GOOGLE_MODE[mode],
        });

        if (result.status !== 'OK') {
            return { ...base, mode, status: 'NO_ROUTE' };
        }

        const legResult = {
            status: 'OK',
            polyline: result.polyline,
            steps: result.steps,
            distanceMeters: result.distanceMeters,
            durationSec: result.durationSec,
        };

        // 캐시 저장은 best-effort — 실패해도 이번 응답에는 영향 없음
        writeCache(originLat, originLng, destLat, destLng, mode, legResult).catch(() => {});

        return { ...base, mode, ...legResult };
    } catch {
        return { ...base, mode, status: 'NO_ROUTE' };
    }
}

async function resolveAuto(base, from, to) {
    const originLat = round5(from.lat);
    const originLng = round5(from.lng);
    const destLat = round5(to.lat);
    const destLng = round5(to.lng);

    const cached = await lookupCache(originLat, originLng, destLat, destLng, 'auto');
    if (cached) {
        return { ...base, ...cached };
    }

    const straight = haversineMeters(from.lat, from.lng, to.lat, to.lng);
    let resolved = null;

    if (straight <= WALK_MAX_METERS) {
        resolved = await tryGoogleMode(originLat, originLng, destLat, destLng, 'walking', 'walk');
    }
    if (!resolved) {
        resolved = await tryGoogleMode(originLat, originLng, destLat, destLng, 'transit', null);
        if (resolved) resolved.mode = inferModeFromSteps(resolved.steps);
    }
    if (!resolved) {
        resolved = await tryGoogleMode(originLat, originLng, destLat, destLng, 'driving', 'car');
    }
    if (!resolved && straight > WALK_MAX_METERS) {
        // 대중교통도 자동차 경로도 못 찾았으면 마지막으로 걷기라도 시도해본다.
        resolved = await tryGoogleMode(originLat, originLng, destLat, destLng, 'walking', 'walk');
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
