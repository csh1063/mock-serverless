// api/geocode.js — Vercel Serverless Function
// POST /api/geocode
// Body: { locations: [{ id, lat, lng }] }
// Returns: { results: [{ id, isKorea, sido, city, gu, adm_nm }] }

import * as turf from '@turf/turf';

const GEOJSON_URL = "https://etmflezkphoumjzvszyy.supabase.co/storage/v1/object/public/korea/HangJeongDong_slim.geojson";

let cachedGeoJSON = null;

async function getGeoJSON() {
    if (cachedGeoJSON) return cachedGeoJSON;

    console.log("Fetching GeoJSON from source...");
    const response = await fetch(GEOJSON_URL);
    if (!response.ok) throw new Error("Failed to fetch GeoJSON");

    cachedGeoJSON = await response.json();
    return cachedGeoJSON;
}

// "수원시팔달구" → { city: "수원시", gu: "팔달구" }
// "강서구"       → { city: null,    gu: "강서구" }
// "시흥시"       → { city: "시흥시", gu: null }
// "가평군"       → { city: null,    gu: "가평군" }
function parseSggnm(sggnm) {
    if (sggnm.endsWith("구")) {
        const siIdx = sggnm.indexOf("시");
        if (siIdx !== -1) {
            return {
                city: sggnm.slice(0, siIdx + 1),
                gu: sggnm.slice(siIdx + 1),
            };
        }
        return { city: null, gu: sggnm };
    }

    if (sggnm.endsWith("시")) {
        return { city: sggnm, gu: sggnm };
    }

    return { city: null, gu: sggnm };
}

function parseAdmNm(adm_nm) {
    const tokens = adm_nm.split(" ");
    const sido = tokens[0];
    const sggnm = tokens[1];
    const dong = tokens[2];

    const { city, gu } = parseSggnm(sggnm);

    return { sido, city: city ?? sido, gu, dong };
}

export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method Not Allowed" });
    }

    const { locations } = req.body;

    if (!Array.isArray(locations) || locations.length === 0) {
        return res.status(400).json({ error: "locations array is required" });
    }

    try {
        const geojson = await getGeoJSON();

        // 결과 Map 초기화 - 기본값 isKorea: false (해외 좌표 혹은 미매칭 안전 처리)
        const results = new Map(
            locations.map(({ id, lat, lng }) => [id, { id, isKorea: false, _point: turf.point([lng, lat]) }])
        );

        // 아직 주소를 못 찾은 location들
        let remaining = locations.map(({ id }) => id);

        for (const feature of geojson.features) {
            if (remaining.length === 0) break; // 전부 찾았으면 early exit

            const { adm_nm } = feature.properties;
            const { sido, city, gu, dong } = parseAdmNm(adm_nm);
            const nextRemaining = [];

            for (const id of remaining) {
                const entry = results.get(id);
                if (turf.booleanPointInPolygon(entry._point, feature)) {
                    // 주소 채우기
                    entry.isKorea = true;
                    entry.administrativeArea = sido; // 서울시 / 경기도
                    entry.locality = city; // 서울시 / 용인시
                    entry.subLocality = gu; // 구 / 군
                    entry.thoroughfare = dong; // 동 / 로 / 읍
                    //   entry.adm_nm = adm_nm; 
                    // remaining에서 제거 (nextRemaining에 안 넣음)
                } else {
                    nextRemaining.push(id);
                }
            }

            remaining = nextRemaining;
        }

        if (remaining.length > 0) {
            for (const id of remaining) {
                const entry = results.get(id);
                let minDist = Infinity;
                let nearestFeature = null;

                for (const feature of geojson.features) {
                    const center = turf.centroid(feature);
                    const dist = turf.distance(entry._point, center);
                    if (dist < minDist) {
                        minDist = dist;
                        nearestFeature = feature;
                    }
                }

                if (nearestFeature && minDist <= 15) {
                    const { adm_nm } = nearestFeature.properties;
                    const { sido, city, gu, dong } = parseAdmNm(adm_nm);
                    entry.isKorea = true;
                    entry.administrativeArea = sido;
                    entry.locality = city;
                    entry.subLocality = gu;
                    entry.thoroughfare = dong;
                }
            }
        }

        // results는 Map이라 배열로 변환
        // Map.values() → 이터레이터
        // [...] → 배열로 펼치기
        // _point 제거 후 반환
        // 구조분해로 _point만 빼고 나머지를 rest로
        const output = [...results.values()].map(({ _point, ...rest }) => rest);

        return res.status(200).json({ data: output, result: true });

    } catch (error) {
        console.error("Error:", error);
        return res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
}