// ===================================================================
// Vercel Serverless Function: 하루치 일정의 구간별 경로를 한 번에 계산
// POST /api/travel/route/day
// Body: { "items": [{ "id","lat","lng","mode","noRoute" }, ...] }  (이미 날짜/순서 정렬됨)
// Response: { "legs": [{ fromItemId,toItemId,mode,status,polyline,steps,distanceMeters,durationSec,alternatives }] }
// alternatives(선택): 걷기/대중교통 비교 시 추천되지 못한 나머지 경로들 —
//   [{ mode,polyline,distanceMeters,durationSec }] — 지도에 같이 그리기용, 애니메이션 대상 아님.
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
// 걷기 시간 자체가 이 이상이면(오래 걸어야 하면), 대중교통이 5분만큼 확실히 안 빨라도
// 그냥 대중교통을 추천한다 — 짧은 거리에서나 "5분 차이면 그냥 걷지"가 말이 되지, 오래
// 걸어야 하는 거리에서까지 그 기준을 그대로 적용하면 안 되기 때문.
const WALK_LONG_THRESHOLD_SEC = 25 * 60;
// 대중교통 후보는 최대 이만큼만(걷기까지 합치면 지도에 최대 3개 경로가 그려진다).
const MAX_TRANSIT_ALTERNATIVES = 2;

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

// 대중교통 경로 안에 포함된 도보 구간(역까지 걷기, 환승 중 걷기 등)의 합계 시간.
function walkingWithinSec(steps) {
    return (steps || [])
        .filter((step) => step.travelMode === 'WALKING')
        .reduce((sum, step) => sum + (step.durationSec || 0), 0);
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

// 걷기 1개 + 대중교통 후보(최대 MAX_TRANSIT_ALTERNATIVES개)를 전부 구해서, 그중 "제일
// 추천하는" 하나를 골라 top-level(mode/polyline/steps/...)에 싣고, 나머지는 지도에 같이
// 그릴 수 있게 alternatives 배열에 담아 함께 돌려준다.
//
// 추천 우선순위:
//   1) 대중교통 후보끼리는 시간 짧은 순 → 환승 적은 순 → (그래도 같으면) 그 경로 안에
//      도보 구간이 적은 순으로 1등을 고른다(같은 "대중교통"이어도 역까지 한참 걸어야
//      하면 우선순위가 떨어진다).
//   2) 그 1등 대중교통과 걷기를 비교한다 — 걷기가 25분 미만이면 대중교통이 5분 이상
//      확실히 빨라야만 대중교통을 추천하고(짧은 거리에서 몇 분 아끼자고 갈아타는 건
//      번거로움 대비 이득이 적으므로), 걷기가 25분 이상이면 대중교통이 5분씩 안
//      아껴도(느려지지만 않으면) 대중교통을 추천한다.
async function resolveWalkOrTransit(base, from, to) {
    const originLat = round5(from.lat);
    const originLng = round5(from.lng);
    const destLat = round5(to.lat);
    const destLng = round5(to.lng);

    const cached = await lookupCache(originLat, originLng, destLat, destLng, 'auto');
    if (cached) return { ...base, ...cached };

    const [walkResult, transitRoutes] = await Promise.all([
        tryGoogleMode(originLat, originLng, destLat, destLng, 'walking', 'walk'),
        fetchTransitAlternatives(originLat, originLng, destLat, destLng),
    ]);

    const candidates = [];
    if (walkResult) candidates.push({ ...walkResult, transferCount: 0, walkingWithinSec: walkResult.durationSec });
    for (const route of transitRoutes) {
        candidates.push({
            mode: inferModeFromSteps(route.steps),
            polyline: route.polyline,
            steps: route.steps,
            distanceMeters: route.distanceMeters,
            durationSec: route.durationSec,
            transferCount: Math.max(route.steps.filter((s) => s.travelMode === 'TRANSIT').length - 1, 0),
            walkingWithinSec: walkingWithinSec(route.steps),
        });
    }

    if (candidates.length === 0) {
        return { ...base, mode: 'walk', status: 'NO_ROUTE' };
    }

    const recommended = pickRecommended(candidates, walkResult);
    const alternatives = candidates
        .filter((candidate) => candidate !== recommended)
        .map((candidate) => ({
            mode: candidate.mode,
            polyline: candidate.polyline,
            distanceMeters: candidate.distanceMeters,
            durationSec: candidate.durationSec,
        }));

    const legResult = {
        status: 'OK',
        mode: recommended.mode,
        polyline: recommended.polyline,
        steps: recommended.steps,
        distanceMeters: recommended.distanceMeters,
        durationSec: recommended.durationSec,
        alternatives,
    };
    writeCache(originLat, originLng, destLat, destLng, 'auto', legResult).catch(() => {});
    return { ...base, ...legResult };
}

function pickRecommended(candidates, walkResult) {
    const transitCandidates = candidates.filter((candidate) => candidate.mode !== 'walk');
    if (transitCandidates.length === 0) return candidates[0];

    // 시간 짧은 순 → 환승 적은 순 → 그 안에 도보 구간 적은 순으로 대중교통 후보 중 1등을 고른다.
    transitCandidates.sort(
        (a, b) =>
            a.durationSec - b.durationSec ||
            a.transferCount - b.transferCount ||
            a.walkingWithinSec - b.walkingWithinSec
    );
    const bestTransit = transitCandidates[0];
    if (!walkResult) return bestTransit;

    const timeSaved = walkResult.durationSec - bestTransit.durationSec;
    const walkIsLong = walkResult.durationSec >= WALK_LONG_THRESHOLD_SEC;
    // 걷기가 짧으면 대중교통이 확실히(5분 이상) 빨라야 추천하고, 걷기가 이미 길면
    // (25분 이상) 대중교통이 느려지지만 않으면 그대로 추천한다.
    const transitIsWorthwhile = timeSaved >= MIN_TRANSIT_TIME_SAVED_SEC || (walkIsLong && timeSaved >= 0);
    if (transitIsWorthwhile) return bestTransit;
    return candidates.find((candidate) => candidate.mode === 'walk') || bestTransit;
}

async function fetchTransitAlternatives(originLat, originLng, destLat, destLng) {
    try {
        const result = await fetchDirections({
            olat: originLat,
            olng: originLng,
            dlat: destLat,
            dlng: destLng,
            mode: 'transit',
            alternatives: true,
        });
        if (result.status !== 'OK' || !result.routes) return [];
        return result.routes.slice(0, MAX_TRANSIT_ALTERNATIVES);
    } catch {
        return [];
    }
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
