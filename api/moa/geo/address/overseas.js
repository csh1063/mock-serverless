import countries from 'i18n-iso-countries';

const chunkArray = (array, size) => {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
};

export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method Not Allowed" });
    }

    const { locations } = req.body;

    if (!Array.isArray(locations) || locations.length === 0) {
        return res.status(400).json({ error: "locations array is required" });
    }

    const apiKey = process.env.HERE_API_KEY;

    const chunks = chunkArray(locations, 50);
    let allResults = [];
    try {
        for (const chunk of chunks) {
            const promises = chunk.map(({ ids, lat, lng }) => {
                const url = `https://revgeocode.search.hereapi.com/v1/revgeocode?at=${lat},${lng}&lang=ko&apiKey=${apiKey}`;
                return fetch(url).then(res => res.json()).then(data => ({ ids, data }));
            });
            const chunkResults = await Promise.all(promises);
            allResults = allResults.concat(chunkResults);
        }

        const data = allResults.flatMap(({ ids, data: result }) => {
            if (!result.items?.length) return ids.map(id => ({ id, isKorea: false, isoCountryCode: null, country: null, administrativeArea: null, locality: null, subLocality: null, thoroughfare: null }));
            const addr = result.items[0].address;
            const parsed = {
                isKorea: false,
                isoCountryCode: countries.alpha3ToAlpha2(addr.countryCode) ?? null,
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