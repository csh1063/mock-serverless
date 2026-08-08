// ===================================================================
// Vercel Serverless Function: 하루치 일정의 구간별 경로를 한 번에 계산
// POST /api/travel/route/day
// Body: { "items": [{ "id","lat","lng","mode","noRoute" }, ...] }  (이미 날짜/순서 정렬됨)
// Response: { "legs": [{ fromItemId,toItemId,mode,status,polyline,steps,distanceMeters,durationSec }] }
//
// status: "OK" | "NO_ROUTE" | "SKIPPED"
//   - SKIPPED: noRoute:true 이거나 도로/대중교통 경로가 의미 없는 수단(기차/곤돌라/차/배 등)
//              → 클라이언트가 점선 직선으로 대체
//   - NO_ROUTE: 실제 경로 탐색을 시도했지만 실패
// 한 구간이 실패해도 배치 전체를 실패시키지 않는다.
//
// route_cache 테이블에 좌표(소수점 5자리 반올림)+수단 단위로 캐싱해서 같은 구간을
// 여러 사용자가 반복 조회해도 Google API 쿼터를 아낀다.
// ===================================================================

import { fetchDirections } from '#lib/directions';
import { supabase } from '#lib/supabaseClient';
import { verifyUser } from '#lib/verifyUser';

// travel_map.html의 ROAD_MODES와 동일 — 이 수단만 실제 도로/대중교통 경로를 찾는다.
const ROUTABLE_MODES = ['walk', 'bus', 'tram', 'metro'];

const MODE_TO_GOOGLE_MODE = {
    walk: 'walking',
    bus: 'transit',
    tram: 'transit',
    metro: 'transit',
};

function round5(n) {
    return Math.round(n * 1e5) / 1e5;
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
    const mode = to.mode || 'walk';
    const base = { fromItemId: from.id, toItemId: to.id, mode };

    if (to.noRoute || !ROUTABLE_MODES.includes(mode)) {
        return { ...base, status: 'SKIPPED' };
    }
    if (from.lat == null || from.lng == null || to.lat == null || to.lng == null) {
        return { ...base, status: 'SKIPPED' };
    }

    const originLat = round5(from.lat);
    const originLng = round5(from.lng);
    const destLat = round5(to.lat);
    const destLng = round5(to.lng);

    try {
        const cached = await lookupCache(originLat, originLng, destLat, destLng, mode);
        if (cached) {
            return { ...base, ...cached };
        }

        const result = await fetchDirections({
            olat: originLat,
            olng: originLng,
            dlat: destLat,
            dlng: destLng,
            mode: MODE_TO_GOOGLE_MODE[mode],
        });

        if (result.status !== 'OK') {
            return { ...base, status: 'NO_ROUTE' };
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

        return { ...base, ...legResult };
    } catch {
        return { ...base, status: 'NO_ROUTE' };
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
