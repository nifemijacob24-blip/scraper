const { searchLinkedInJobs, getLinkedInJob } = require('./brightdata-client');

function normalizeJob(job) {
    return {
        id: job.id || job.jobId || job.job_id || job.job_posting_id || null,
        title: job.title || job.jobTitle || job.job_title || null,
        company: job.company || job.companyName || job.company_name || null,
        companyUrl: job.companyUrl || job.company_url || null,
        location: job.location || job.jobLocation || job.job_location || null,
        description: job.description || job.job_summary || null,
        employmentType: job.employmentType || job.employment_type || null,
        seniorityLevel: job.seniorityLevel || job.seniority_level || null,
        workplaceType: job.workplaceType || job.workplace_type || null,
        salary: job.salary || null,
        postedAt: job.listedAt || job.datePosted || job.date_posted || job.postedAt || job.posted_at || null,
        applyUrl: job.url || job.apply_url || job.job_url || null,
        source: 'linkedin',
        raw: job
    };
}

async function searchJobs(params) {
    const payload = await searchLinkedInJobs({
        query: params.query,
        location: params.location,
        datePosted: params.datePosted,
        companyId: params.companyId,
        cursor: params.cursor
    });
    const jobs = Array.isArray(payload?.jobs)
        ? payload.jobs
        : Array.isArray(payload?.data?.jobs)
            ? payload.data.jobs
            : Array.isArray(payload?.results)
                ? payload.results
                : Array.isArray(payload?.data)
                    ? payload.data
                    : Array.isArray(payload)
                        ? payload
                        : [];
    return {
        jobs: jobs.map(normalizeJob),
        nextCursor: payload?.cursor ?? payload?.data?.cursor ?? payload?.next_cursor ?? null,
        status: 'complete'
    };
}

async function getJobDetails(url) {
    const payload = await getLinkedInJob(url);
    if (payload?.job) return payload.job;
    if (payload?.data && !Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload?.data) && payload.data.length) return payload.data[0];
    if (payload && payload.success === false) return null;
    return payload && typeof payload === 'object' ? payload : null;
}

module.exports = { searchJobs, getJobDetails };
