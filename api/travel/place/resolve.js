// ===================================================================
// Vercel Serverless Function: 구글맵 공유링크 → 장소 정보 해석
// POST /api/travel/place/resolve   Body: { "url": "https://maps.app.goo.gl/XXXX" }
//
// 구글맵 앱 "공유하기"로 나오는 축약 링크(maps.app.goo.gl)를 서버에서 리다이렉트를
// 따라가 실제 URL로 펼친 뒤, place_id 또는 좌표/이름을 파싱한다. place_id가 있으면
// Place Details API로 정확한 이름/주소를 가져오고, 없으면 좌표 역지오코딩으로 대체한다.
// GOOGLE_API_KEY는 서버 전용 비밀키라 클라이언트에 절대 노출하지 않는다.
// ===================================================================

import { verifyUser } from '#lib/verifyUser';

const ALLOWED_HOSTS = [
    'maps.app.goo.gl',
    'goo.gl',
    'google.com',
    'www.google.com',
    'maps.google.com',
];

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

    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'url is required' });
    }

    let host;
    try {
        host = new URL(url).hostname;
    } catch {
        return res.status(400).json({ error: 'invalid url' });
    }
    if (!ALLOWED_HOSTS.includes(host)) {
        return res.status(400).json({ error: 'unsupported host', host });
    }

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'server missing API key' });
    }

    try {
        // 1) 축약 링크 리다이렉트를 서버에서 따라가서 최종 URL 확보
        const expandedRes = await fetch(url, { redirect: 'follow' });
        const finalUrl = expandedRes.url || url;

        const parsed = parseGoogleMapsUrl(finalUrl);

        // 2) place_id를 찾았으면 Place Details로 정확한 데이터 조회 (가장 신뢰도 높음)
        if (parsed.placeId) {
            const place = await fetchPlaceDetails(parsed.placeId, apiKey);
            if (place) {
                return res.status(200).json({ result: true, place });
            }
        }

        // 3) place_id가 없거나 조회 실패 → 좌표 기반 폴백 (있으면 역지오코딩으로 주소 보강)
        if (parsed.lat != null && parsed.lng != null) {
            const address = await reverseGeocode(parsed.lat, parsed.lng, apiKey);
            return res.status(200).json({
                result: true,
                place: {
                    name: parsed.name || address || '선택한 장소',
                    lat: parsed.lat,
                    lng: parsed.lng,
                    address: address ?? null,
                    placeId: null,
                },
            });
        }

        // 4) 좌표/place_id 없이 이름만 뽑힌 경우라도 완전 실패보다는 이름만이라도 채워줌
        if (parsed.name) {
            return res.status(200).json({
                result: true,
                place: { name: parsed.name, lat: null, lng: null, address: null, placeId: null },
            });
        }

        return res.status(200).json({ result: false, error: 'unresolvable_link' });
    } catch (e) {
        return res.status(500).json({ error: 'resolve failed', message: e.message });
    }
}

function parseGoogleMapsUrl(urlString) {
    const result = { placeId: null, lat: null, lng: null, name: null };

    let url;
    try {
        url = new URL(urlString);
    } catch {
        return result;
    }

    // query_place_id=ChIJ... 형태 (search/?api=1 스타일 공유 링크)
    const queryPlaceId = url.searchParams.get('query_place_id');
    if (queryPlaceId) result.placeId = queryPlaceId;

    // 문자열 어디든 ChIJ로 시작하는 표준 Place ID 패턴이 있으면 사용
    if (!result.placeId) {
        const placeIdMatch = urlString.match(/(ChI[A-Za-z0-9_-]{20,})/);
        if (placeIdMatch) result.placeId = placeIdMatch[1];
    }

    // /@lat,lng,zoom 패턴
    const atMatch = url.pathname.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (atMatch) {
        result.lat = parseFloat(atMatch[1]);
        result.lng = parseFloat(atMatch[2]);
    }

    // query=lat,lng / q=lat,lng 폴백 (search 스타일, 구버전 단축 링크)
    if (result.lat == null) {
        const coordParam = url.searchParams.get('query') || url.searchParams.get('q');
        const coordMatch = coordParam && coordParam.match(/^(-?\d+\.\d+),(-?\d+\.\d+)$/);
        if (coordMatch) {
            result.lat = parseFloat(coordMatch[1]);
            result.lng = parseFloat(coordMatch[2]);
        }
    }

    // /place/<name>/ 경로 세그먼트
    const placeMatch = url.pathname.match(/\/place\/([^/]+)/);
    if (placeMatch) {
        result.name = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
    }

    // 좌표를 아직 못 찾았고 q=가 좌표가 아니라 검색어(장소명)인 경우, 이름 후보로라도 사용
    if (result.lat == null && !result.name) {
        const qParam = url.searchParams.get('q');
        if (qParam && !/^-?\d+\.\d+,-?\d+\.\d+$/.test(qParam)) {
            result.name = qParam;
        }
    }

    return result;
}

async function fetchPlaceDetails(placeId, apiKey) {
    const detailsUrl =
        `https://maps.googleapis.com/maps/api/place/details/json` +
        `?place_id=${encodeURIComponent(placeId)}` +
        `&fields=name,formatted_address,geometry` +
        `&key=${apiKey}`;

    const response = await fetch(detailsUrl);
    const data = await response.json();
    if (data.status !== 'OK' || !data.result) return null;

    const { result: place } = data;
    return {
        name: place.name,
        lat: place.geometry?.location?.lat ?? null,
        lng: place.geometry?.location?.lng ?? null,
        address: place.formatted_address ?? null,
        placeId,
    };
}

async function reverseGeocode(lat, lng, apiKey) {
    const geocodeUrl =
        `https://maps.googleapis.com/maps/api/geocode/json` +
        `?latlng=${lat},${lng}&key=${apiKey}`;

    try {
        const response = await fetch(geocodeUrl);
        const data = await response.json();
        if (data.status !== 'OK' || !data.results?.[0]) return null;
        return data.results[0].formatted_address ?? null;
    } catch {
        return null;
    }
}
