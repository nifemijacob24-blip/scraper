const LURKAPI_BASE_URL = 'https://api.lurkapi.com/v1/linkedin';

async function lurkRequest(path, params) {
    const rawToken = process.env.LURKAPI_API_KEY;
    if (!rawToken || !rawToken.trim()) {
        throw new Error('Missing LURKAPI_API_KEY in environment configuration');
    }

    const url = new URL(`${LURKAPI_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params || {})) {
        if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, String(value));
        }
    }

    const timeoutMs = Number(process.env.LURKAPI_LINKEDIN_TIMEOUT_MS) || 90000;
    let response;
    try {
        response = await fetch(url, {
            method: 'GET',
            headers: {
                'x-api-key': rawToken.trim(),
                Accept: 'application/json'
            },
            signal: AbortSignal.timeout(timeoutMs)
        });
    } catch (error) {
        if (error.name === 'AbortError' || error.name === 'TimeoutError') {
            throw new Error(`LinkedIn request timed out after ${timeoutMs}ms.`);
        }
        throw error;
    }

    const text = await response.text();
    let payload;
    try {
        payload = text ? JSON.parse(text) : null;
    } catch {
        const detail = text.trim().replace(/\s+/g, ' ').slice(0, 200);
        throw new Error(`Upstream returned invalid JSON (${response.status}): ${detail || 'empty response'}`);
    }

    if (!response.ok || payload?.success === false) {
        let upstreamMessage;
        if (response.status === 429) {
            upstreamMessage = 'Rate limit exceeded';
        } else if ([502, 503, 504].includes(response.status)) {
            upstreamMessage = 'Upstream LinkedIn service temporarily unavailable';
        } else {
            upstreamMessage = payload?.error || payload?.message || 'LinkedIn job service request failed';
        }
        const error = new Error(upstreamMessage);
        error.status = response.ok ? 502 : response.status;
        error.code = payload?.code;
        throw error;
    }

    return payload;
}

async function searchLinkedInJobs(params) {
    return lurkRequest('/jobs/search', params);
}

async function getLinkedInJob(url) {
    return lurkRequest('/job', { url });
}

module.exports = { searchLinkedInJobs, getLinkedInJob };
