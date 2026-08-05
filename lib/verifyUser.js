import { supabase } from '#lib/supabaseClient';

// travel/* 엔드포인트 중 Google API 쿼터를 쓰는 것만 이걸로 최소한의 인증 게이트를 건다.
// (RLS를 대체하는 게 아니라 순수 남용 방지 목적 — directions.js는 기존 travel_map.html이
//  익명으로 쓰고 있어서 일부러 여기 안 물림)
export async function verifyUser(req) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return null;

    const { data, error } = await supabase.auth.getUser(token);
    if (error) return null;
    return data.user;
}
