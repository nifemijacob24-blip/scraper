const { scrapeLinkedIn } = require('./brightdata-client');

function getRecords(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.results)) return payload.results;
    if (Array.isArray(payload?.records)) return payload.records;
    return payload ? [payload] : [];
}

function getPendingSnapshot(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null;
    }

    const status = String(payload.status || '').toLowerCase();
    const message = String(payload.message || '').toLowerCase();
    const isPendingStatus = ['closing', 'pending', 'running', 'processing'].includes(status);
    const isNotReadyMessage = message.includes('not ready') || message.includes('try again');

    if (payload.snapshot_id && (isPendingStatus || isNotReadyMessage)) {
        return {
            snapshotId: payload.snapshot_id,
            message: payload.message || 'Snapshot is still being processed'
        };
    }

    return null;
}

function normalizeJob(job) {
    return {
        id: job.job_id || job.job_posting_id || job.id || null,
        title: job.job_title || job.title || null,
        company: job.company_name || job.company || null,
        companyUrl: job.company_url || null,
        location: job.job_location || job.location || null,
        description: job.job_summary || job.description || null,
        employmentType: job.employment_type || null,
        seniorityLevel: job.seniority_level || null,
        workplaceType: job.workplace_type || null,
        salary: job.salary || null,
        postedAt: job.date_posted || job.posted_at || null,
        applyUrl: job.apply_url || job.job_url || job.url || null,
        source: 'linkedin',
        raw: job
    };
}

async function searchJobs(params) {
    const limit = Math.min(Math.max(Number(params.limit) || 5, 1), 25);
    const input = {
        location: params.location,
        keyword: params.keyword,
        country: params.country || '',
        time_range: params.time_range || '',
        company: params.company || '',
        location_radius: params.location_radius || '',
        selective_search: params.selective_search || '',
        jobs_to_not_include: params.jobs_to_not_include || ''
    };

    const payload = await scrapeLinkedIn(input, limit);
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

    if (payload?.snapshot_id && !getRecords(payload).length) {
        return {
            jobs: [],
            nextCursor: null,
            snapshotId: payload.snapshot_id,
            status: 'pending'
        };
    }

    return {
        jobs: getRecords(payload).map(normalizeJob),
        nextCursor: payload?.next_cursor || payload?.cursor || null,
        status: 'complete'
    };
}

module.exports = { searchJobs };
