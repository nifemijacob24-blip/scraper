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
            throw new Error(`LurkAPI LinkedIn request timed out after ${timeoutMs}ms.`);
        }
        throw error;
    }

    const text = await response.text();
    let payload;
    try {
        payload = text ? JSON.parse(text) : null;
    } catch {
        const detail = text.trim().replace(/\s+/g, ' ').slice(0, 200);
        throw new Error(`LurkAPI returned invalid JSON (${response.status}): ${detail || 'empty response'}`);
    }

    if (!response.ok || payload?.success === false) {
        const upstreamMessage = payload?.error || payload?.message || response.statusText;
        const code = payload?.code ? ` ${payload.code}` : '';
        const error = new Error(`LurkAPI request failed (${response.status})${code}: ${upstreamMessage}`);
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
