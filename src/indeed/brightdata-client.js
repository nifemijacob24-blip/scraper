const BRIGHTDATA_API_URL = 'https://api.brightdata.com/datasets/v3/scrape';

async function scrapeIndeed(input, datasetId, options = {}) {
    const rawToken = process.env.BRIGHTDATA_API_TOKEN;
    if (!rawToken || !rawToken.trim()) {
        throw new Error('Missing BRIGHTDATA_API_TOKEN in environment configuration');
    }
    const token = rawToken.trim().replace(/^Bearer\s+/i, '');

    if (!datasetId) {
        throw new Error('Missing Bright Data Indeed dataset ID in environment configuration');
    }

    const url = new URL(BRIGHTDATA_API_URL);
    url.searchParams.set('dataset_id', datasetId);
    url.searchParams.set('notify', 'false');
    url.searchParams.set('include_errors', 'true');
    if (options.discoverBy) {
        url.searchParams.set('type', 'discover_new');
        url.searchParams.set('discover_by', options.discoverBy);
    }

    const requestBody = {
        input: [input],
        limit_per_input: null
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: ['Bearer', token].join(' '),
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(Number(process.env.BRIGHTDATA_INDEED_TIMEOUT_MS) || 60000)
    });

    const text = await response.text();
    let payload;
    try {
        payload = text ? JSON.parse(text) : null;
    } catch {
        const detail = text.trim().replace(/\s+/g, ' ').slice(0, 200);
        throw new Error(`Bright Data returned invalid JSON (${response.status}): ${detail || 'empty response'}`);
    }

    if (!response.ok) {
        const upstreamMessage = [
            payload?.message,
            payload?.error,
            payload?.detail,
            Array.isArray(payload?.errors) ? payload.errors.map(error => error.message || error).join('; ') : null
        ].filter(Boolean).join(' | ') || response.statusText;
        throw new Error(`Bright Data request failed (${response.status}): ${upstreamMessage}`);
    }

    return payload;
}

module.exports = { scrapeIndeed };
