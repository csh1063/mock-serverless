// ===================================================================
// Vercel Serverless Function: 구글 Directions API 프록시 (단일 구간)
// 목적: API 키를 클라이언트(HTML)에 노출하지 않고 서버(Vercel)에서만 사용
//
// travel_map.html이 이 URL을 익명으로 그대로 쓰고 있어서 계약(쿼리 파라미터/응답 형식)을
// 절대 바꾸지 않는다. 실제 로직은 lib/directions.js로 옮겨서
// api/travel/route/day.js(하루치 배치 조회)와 공유한다.
// ===================================================================

import { fetchDirections } from '#lib/directions';

export default async function handler(req, res) {
    // CORS 허용
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { olat, olng, dlat, dlng, mode } = req.query;

    if (!olat || !olng || !dlat || !dlng) {
        return res.status(400).json({ error: 'missing coordinates' });
    }

    try {
        const result = await fetchDirections({ olat, olng, dlat, dlng, mode });
        return res.status(200).json(result);
    } catch (e) {
        return res.status(500).json({ error: 'fetch failed', message: e.message });
    }
}
