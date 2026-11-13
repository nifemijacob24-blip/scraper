const express = require('express');
const { searchJobs, getJobDetails } = require('./indeed-service');

function createIndeedRouter(logApiRequest) {
    const router = express.Router();

router.get('/jobs/search', async (req, res) => {
    const { query, location, locality, fromage, radius, country, limit } = req.query;
    if (!query || typeof query !== 'string' || !query.trim()) {
        return res.status(400).json({ success: false, error: "Missing required parameter 'query'." });
    }

    const cost = 1;
    if (req.user.credits < cost) {
        return res.status(403).json({ success: false, error: `Insufficient credits. This request requires ${cost} credit.` });
    }

    const params = {
        query: query.trim(),
        location: typeof location === 'string' ? location.trim() : undefined,
        country: typeof country === 'string' ? country.trim() : undefined,
        locality,
        fromage,
        radius,
        limit
    };

    try {
        const result = await searchJobs(params);
        if (result.status === 'pending') {
            await logApiRequest(req, '/v1/indeed/jobs/search', 0, params, 202);
            return res.status(202).json({
                success: true,
                status: 'pending',
                message: result.message || 'Bright Data is still collecting Indeed jobs. Retry shortly.',
                snapshot_id: result.snapshotId,
                credits_charged: 0,
                credits_remaining: req.user.credits
            });
        }

        req.user.credits -= cost;
        await logApiRequest(req, '/v1/indeed/jobs/search', cost, params, 200);
        return res.json({
            success: true,
            credits_charged: cost,
            credits_remaining: req.user.credits,
            query: params.query,
            location: params.location || null,
            ...result
        });
    } catch (error) {
        console.error('[Indeed search]', error);
        await logApiRequest(req, '/v1/indeed/jobs/search', 0, params, 502);
        return res.status(502).json({ success: false, error: error.message });
    }
});

router.get('/jobs/:job_id', async (req, res) => {
    const jobId = typeof req.params.job_id === 'string' ? req.params.job_id.trim() : '';
    if (!jobId) {
        return res.status(400).json({ success: false, error: "Missing required parameter 'job_id'." });
    }

    const cost = 1;
    if (req.user.credits < cost) {
        return res.status(403).json({ success: false, error: `Insufficient credits. This request requires ${cost} credit.` });
    }

    const params = { job_id: jobId, locality: req.query.locality || null };
    try {
        const job = await getJobDetails(jobId, params.locality);
        if (!job) {
            await logApiRequest(req, '/v1/indeed/jobs/:job_id', 0, params, 404);
            return res.status(404).json({ success: false, error: 'Indeed job was not found.' });
        }

        req.user.credits -= cost;
        await logApiRequest(req, '/v1/indeed/jobs/:job_id', cost, params, 200);
        return res.json({
            success: true,
            credits_charged: cost,
            credits_remaining: req.user.credits,
            job
        });
    } catch (error) {
        console.error('[Indeed details]', error);
        await logApiRequest(req, '/v1/indeed/jobs/:job_id', 0, params, 502);
        return res.status(502).json({ success: false, error: error.message });
    }
});

    return router;
}

module.exports = createIndeedRouter;
