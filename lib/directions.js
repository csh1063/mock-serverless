// 구글 Directions API 호출 + 응답 가공 로직.
// api/travel/directions.js(단일 구간, travel_map.html이 익명으로 쓰는 기존 엔드포인트)와
// api/travel/route/day.js(하루치 배치 조회, 신규) 둘 다 이 함수를 공유한다.

export async function fetchDirections({ olat, olng, dlat, dlng, mode, alternatives = false }) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        return { error: 'server missing API key' };
    }

    const travelMode = mode || 'transit'; // transit, driving, walking, bicycling

    const gUrl =
        `https://maps.googleapis.com/maps/api/directions/json` +
        `?origin=${olat},${olng}` +
        `&destination=${dlat},${dlng}` +
        `&mode=${encodeURIComponent(travelMode)}` +
        (alternatives ? '&alternatives=true' : '') +
        `&key=${apiKey}`;

    const gRes = await fetch(gUrl);
    const data = await gRes.json();

    if (data.status !== 'OK' || !data.routes || !data.routes[0]) {
        return { error: 'no route', status: data.status };
    }

    const routes = data.routes.map((route) => {
        const leg = route.legs[0];

        // 세부 구간(steps)별로 이동수단/노선타입/각 구간 폴리라인까지 추출
        const steps = (leg.steps || []).map((step) => {
            const s = {
                travelMode: step.travel_mode, // 'WALKING' | 'TRANSIT'
                polyline: step.polyline.points,
                distanceMeters: step.distance ? step.distance.value : 0,
                durationSec: step.duration ? step.duration.value : 0,
            };
            if (step.travel_mode === 'TRANSIT' && step.transit_details) {
                s.vehicleType = step.transit_details.line.vehicle.type;
                s.lineName = step.transit_details.line.short_name || step.transit_details.line.name || '';
            }
            return s;
        });

        return {
            polyline: route.overview_polyline.points,
            steps,
            distanceMeters: leg.distance.value,
            durationSec: leg.duration.value,
        };
    });

    // 여러 경로(alternatives)를 요청한 경우엔 전부 돌려주고, 단일 경로 요청이면 기존처럼
    // 첫 번째 경로를 최상위 필드로 그대로 펼쳐서 돌려준다(호출부 하위호환).
    if (alternatives) {
        return { status: 'OK', routes };
    }
    return { status: 'OK', ...routes[0] };
}
