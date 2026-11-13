const { scrapeIndeed } = require('./brightdata-client');

const DATASET_ID = process.env.BRIGHTDATA_INDEED_DATASET_ID || 'gd_l4dx9j9sscpvs7no2';

function firstArray(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.results)) return payload.results;
    if (Array.isArray(payload?.records)) return payload.records;
    return payload ? [payload] : [];
}

function normalizeJob(job) {
    return {
        id: job.jobid || job.job_id || job.id || null,
        title: job.job_title || job.title || null,
        company: job.company_name || job.company || null,
        location: job.job_location || job.location || null,
        description: job.description_text || job.description || null,
        benefits: job.benefits || [],
        qualifications: job.qualifications || [],
        jobType: job.job_type || job.jobType || null,
        salary: job.salary || null,
        postedAt: job.date_posted_parsed || job.date_posted || job.posted_at || null,
        applyUrl: job.url || job.job_url || job.apply_url || null,
        source: 'indeed',
        raw: job
    };
}

function getPendingSnapshot(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null;
    }

    const status = String(payload.status || '').toLowerCase();
    const message = String(payload.message || '').toLowerCase();
    if (payload.snapshot_id && (
        ['closing', 'pending', 'running', 'processing'].includes(status) ||
        message.includes('not ready') ||
        message.includes('try again')
    )) {
        return {
            snapshotId: payload.snapshot_id,
            message: payload.message || 'Snapshot is still being processed'
        };
    }

    return null;
}

function buildSearchInput({ query, location, locality, fromage, radius, sort, job_type, country }) {
    const mode = process.env.BRIGHTDATA_INDEED_SEARCH_INPUT_MODE || 'keyword';
    if (mode === 'url') {
        const searchUrl = new URL('https://www.indeed.com/jobs');
        searchUrl.searchParams.set('q', query);
        if (location) searchUrl.searchParams.set('l', location);
        if (fromage) searchUrl.searchParams.set('fromage', fromage);
        if (radius) searchUrl.searchParams.set('radius', radius);
        if (sort) searchUrl.searchParams.set('sort', sort);
        if (job_type) searchUrl.searchParams.set('jt', job_type);
        return { url: searchUrl.toString() };
    }

    const normalizedCountry = (country || 'US').trim().toUpperCase();
    const domain = locality
        ? (locality.includes('.') ? locality : `${locality}.indeed.com`)
        : (normalizedCountry === 'FR' ? 'fr.indeed.com' : 'indeed.com');
    const datePosted = {
        '1': 'Last 24 hours',
        '3': 'Last 3 days',
        '7': 'Last 7 days',
        '14': 'Last 14 days',
        '30': 'Last 30 days'
    }[String(fromage || '')] || fromage || '';

    const input = {
        country: normalizedCountry,
        domain,
        keyword_search: query,
        location: location || '',
        date_posted: datePosted,
        posted_by: '',
        location_radius: radius ? String(radius) : ''
    };
    return input;
}

async function searchJobs(params) {
    const usesKeywordDiscovery = (process.env.BRIGHTDATA_INDEED_SEARCH_INPUT_MODE || 'keyword') !== 'url';
    const payload = await scrapeIndeed(
        buildSearchInput(params),
        process.env.BRIGHTDATA_INDEED_SEARCH_DATASET_ID || DATASET_ID,
        usesKeywordDiscovery ? { discoverBy: 'keyword' } : {}
    );
    const pendingSnapshot = getPendingSnapshot(payload);
    if (pendingSnapshot) {
        return {
            jobs: [],
            nextCursor: null,
            snapshotId: pendingSnapshot.snapshotId,
            status: 'pending',
            message: pendingSnapshot.message
        };
    }

    return {
        jobs: firstArray(payload).map(normalizeJob),
        nextCursor: payload?.next_cursor || payload?.cursor || null
    };
}

async function getJobDetails(jobId, locality) {
    const domain = locality ? `https://${locality}.indeed.com` : 'https://www.indeed.com';
    const jobUrl = new URL('/viewjob', domain);
    jobUrl.searchParams.set('jk', jobId);
    const payload = await scrapeIndeed(
        { url: jobUrl.toString() },
        process.env.BRIGHTDATA_INDEED_DETAILS_DATASET_ID || DATASET_ID
    );
    const job = firstArray(payload)[0];
    return job ? normalizeJob(job) : null;
}

module.exports = { searchJobs, getJobDetails };
