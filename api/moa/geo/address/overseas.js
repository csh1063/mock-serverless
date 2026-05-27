const chunkArray = (array, size) => {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
};

exports.handler = async (event) => {
    const allCoordinates = JSON.parse(event.body).coordinates;
    const apiKey = process.env.HERE_API_KEY;
    
    const chunks = chunkArray(allCoordinates, 50);
    let allResults = [];
    try {
        for (const chunk of chunks) {
            const promises = chunk.map(coord => {
                const url = `https://revgeocode.search.hereapi.com/v1/revgeocode?at=${coord.lat},${coord.lng}&lang=ko&apiKey=${apiKey}`;
                return fetch(url).then(res => res.json());
            });
            const chunkResults = await Promise.all(promises);
            allResults = allResults.concat(chunkResults);
        }

        const finalAddresses = allResults.map(result => {
            if (!result.items?.length) return { isKorea: false, administrativeArea: null, locality: null, subLocality: null, thoroughfare: null };
            const addr = result.items[0].address;
            return {
                isKorea: false,
                administrativeArea: addr.state ?? addr.countryName,
                locality: addr.city ?? addr.county ?? addr.state,
                subLocality: addr.district ?? null,
                thoroughfare: null,
            };
        });

        return { statusCode: 200, body: JSON.stringify({ addresses: finalAddresses }) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};