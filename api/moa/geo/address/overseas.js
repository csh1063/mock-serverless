import countries from 'i18n-iso-countries';

// 의도적으로 대기 시간을 주는 헬퍼 함수
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method Not Allowed" });
    }

    // 대량이 아닌, 쪼개진 청크 단위(ex: 25개)의 locations를 받습니다.
    const { locations } = req.body;

    if (!Array.isArray(locations) || locations.length === 0) {
        return res.status(400).json({ error: "locations array is required" });
    }

    const apiKey = process.env.HERE_API_KEY;
    
    let chunkResults = [];
    let pendingLocations = [...locations];
    let attempt = 1;

    try {
        // 청크 내부에서 실패한 건이 있다면 성공할 때까지 재시도 큐를 돕니다.
        while (pendingLocations.length > 0) {
            const nextToRetry = [];

            for (const loc of pendingLocations) {
                const atParam = encodeURIComponent(`${loc.lat},${loc.lng}`);
                const url = `https://revgeocode.search.hereapi.com/v1/revgeocode?at=${atParam}&lang=ko&apiKey=${apiKey}`;

                try {
                    const response = await fetch(url);

                    if (!response.ok) {
                        nextToRetry.push(loc);
                        if (response.status === 429) {
                            await sleep(1000); // 429 제한을 만나면 잠시 숨을 고릅니다.
                        }
                        continue;
                    }

                    const data = await response.json();
                    chunkResults.push({ ids: loc.ids, data });

                } catch (err) {
                    nextToRetry.push(loc); // 네트워크 끊김 등 예외 상황 시 재시도 등록
                }

                // 🔥 무조건 건당 200ms씩 쉬어서 '1초에 최대 5회' 속도를 엄격하게 준수합니다.
                await sleep(200);
            }

            pendingLocations = nextToRetry;
            attempt++;

            // 만약 서버리스 함수 자체 한계에 부딪히는 무한 루프를 방지하기 위한 탈출 조건 (최대 3회 시도)
            if (attempt > 3 && pendingLocations.length > 0) {
                // 3번 다 실패한 녀석들은 유실 방지를 위해 빈 값으로 처리해서 채워줍니다.
                pendingLocations.forEach(loc => {
                    chunkResults.push({ ids: loc.ids, data: { items: [] } });
                });
                break;
            }
        }

        const data = chunkResults.flatMap(({ ids, data: result }) => {
            if (!result.items?.length) {
                return ids.map(id => ({ 
                    id, isKorea: false, isoCountryCode: null, country: null, 
                    administrativeArea: null, locality: null, subLocality: null, thoroughfare: null 
                }));
            }
            
            const addr = result.items[0].address;
            const parsed = {
                isKorea: false,
                isoCountryCode: countries.alpha3ToAlpha2(addr.countryCode) ?? "none",
                country: addr.countryName ?? null,
                administrativeArea: addr.state ?? addr.countryName,
                locality: addr.city ?? addr.county ?? addr.state,
                subLocality: addr.district ?? null,
                thoroughfare: null,
            };
            return ids.map(id => ({ id, ...parsed }));
        });

        return res.status(200).json({ result: true, data });

    } catch (error) {
        console.error("Error:", error);
        return res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
}