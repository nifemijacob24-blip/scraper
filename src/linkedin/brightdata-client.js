const BRIGHTDATA_API_URL = 'https://api.brightdata.com/datasets/v3/scrape';

async function scrapeLinkedIn(input, limitPerInput) {
    const token = process.env.BRIGHTDATA_API_TOKEN;
    if (!token) {
        throw new Error('Missing BRIGHTDATA_API_TOKEN in environment configuration');
    }

    const datasetId = process.env.BRIGHTDATA_LINKEDIN_JOBS_DATASET_ID || 'gd_lpfll7v5hcqtkxl6l';
    const url = new URL(BRIGHTDATA_API_URL);
    url.searchParams.set('dataset_id', datasetId);
    url.searchParams.set('notify', 'false');
    url.searchParams.set('include_errors', 'true');
    url.searchParams.set('type', 'discover_new');
    url.searchParams.set('discover_by', 'keyword');

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            input: [input],
            limit_per_input: limitPerInput
        }),
        signal: AbortSignal.timeout(60000)
    });

    const text = await response.text();
    let payload;
    try {
        payload = text ? JSON.parse(text) : null;
    } catch {
        throw new Error(`Bright Data returned invalid JSON (${response.status})`);
    }

    if (!response.ok) {
        const upstreamMessage = payload?.message || payload?.error || response.statusText;
        throw new Error(`Bright Data request failed (${response.status}): ${upstreamMessage}`);
    }

    return payload;
}

module.exports = { scrapeLinkedIn };
