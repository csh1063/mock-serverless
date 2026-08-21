// ===================================================================
// Vercel Serverless Function: 공유 링크 토큰(+비밀번호)으로 여행 조회
// POST /api/travel/trip/share
// Body: { token, password? }
//
// 실제 조회/검증은 전부 Postgres RPC(get_shared_trip, security definer)가 한다 —
// 여기는 그 RPC를 대신 호출해주는 얇은 프록시일 뿐이다. 이렇게 감싸는 이유:
//   - 비밀번호를 URL 쿼리스트링이 아니라 POST body로 받아서, 서버 접속 로그/브라우저
//     히스토리에 비밀번호가 남지 않게 한다.
//   - share.html이 Supabase URL/anon key/SDK를 전혀 몰라도 되게 한다 — 이 앱의 다른
//     모든 웹 호출(예: "오늘 경로 갱신")과 동일하게 mock-serverless 하나만 바라본다.
// ===================================================================

import { supabase } from '#lib/supabaseClient';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { token, password } = req.body || {};
    if (!token) {
        return res.status(400).json({ error: 'invalid_request' });
    }

    const { data, error } = await supabase.rpc('get_shared_trip', {
        p_token: token,
        p_password: password ?? null,
    });

    if (error) {
        return res.status(500).json({ error: 'internal_error' });
    }

    return res.status(200).json(data);
}
