// ===================================================================
// Vercel Serverless Function: 구글 Directions API 프록시
// 목적: API 키를 클라이언트(HTML)에 노출하지 않고 서버(Vercel)에서만 사용
//
// 배포 방법:
// 1. 새 폴더 만들기 (예: trip-directions-proxy)
// 2. 그 폴더 안에 "api" 폴더 만들고, 이 파일을 api/directions.js 로 저장
//    (파일 경로가 곧 URL 경로가 됨: /api/directions)
// 3. 터미널에서 그 폴더로 이동 후:
//      vercel
//    (처음이면 로그인 요청 → 브라우저에서 로그인 → 이후 질문들 기본값 Enter로 진행)
// 4. 배포 후 Vercel 대시보드(vercel.com) → 방금 만든 프로젝트 클릭
//    → "Settings" → "Environment Variables"
//    → Name: GOOGLE_API_KEY, Value: 발급받은 구글 API 키 → Save
// 5. 환경변수 추가했으면 재배포 필요:
//      vercel --prod
// 6. 최종 URL은 이런 형태: https://프로젝트이름.vercel.app/api/directions
//    이 URL을 HTML 지도 파일의 WORKER_URL에 넣으면 끝!
//
// (로컬 폴더 없이 그냥 vercel.com 대시보드에서 "New Project"로
//  GitHub 저장소 연결하는 방식으로 배포해도 동일하게 작동합니다.
//  그 경우 이 파일을 github 저장소의 api/directions.js 경로에 커밋하면 됩니다.)
// ===================================================================

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

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'server missing API key' });
  }

  const travelMode = mode || 'transit'; // transit, driving, walking, bicycling

  const gUrl = `https://maps.googleapis.com/maps/api/directions/json` +
    `?origin=${olat},${olng}` +
    `&destination=${dlat},${dlng}` +
    `&mode=${encodeURIComponent(travelMode)}` +
    `&key=${apiKey}`;

  try {
    const gRes = await fetch(gUrl);
    const data = await gRes.json();

    if (data.status !== 'OK' || !data.routes || !data.routes[0]) {
      return res.status(200).json({ error: 'no route', status: data.status });
    }

    const route = data.routes[0];
    const encodedPolyline = route.overview_polyline.points;

    return res.status(200).json({
      status: 'OK',
      polyline: encodedPolyline,
      distanceMeters: route.legs[0].distance.value,
      durationSec: route.legs[0].duration.value,
    });
  } catch (e) {
    return res.status(500).json({ error: 'fetch failed', message: e.message });
  }
}