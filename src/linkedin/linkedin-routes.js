const express = require('express');
const { searchJobs } = require('./linkedin-service');

function createLinkedInRouter(logApiRequest) {
    const router = express.Router();

    router.get('/jobs/search', async (req, res) => {
        const {
            location,
            keyword,
            country,
            time_range,
            company,
            location_radius,
            selective_search,
            jobs_to_not_include,
            limit
        } = req.query;

        if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
            return res.status(400).json({
                success: false,
                error: "Missing required parameter 'keyword'."
            });
        }

        if (!location || typeof location !== 'string' || !location.trim()) {
            return res.status(400).json({
                success: false,
                error: "Missing required parameter 'location'."
            });
        }

        const cost = 1;
        if (req.user.credits < cost) {
            return res.status(403).json({
                success: false,
                error: `Insufficient credits. This request requires ${cost} credit.`
            });
        }

        const params = {
            location: location.trim(),
            keyword: keyword.trim(),
            country,
            time_range,
            company,
            location_radius,
            selective_search,
            jobs_to_not_include,
            limit
        };

        try {
            const result = await searchJobs(params);
            if (result.status === 'pending') {
                await logApiRequest(req, '/v1/linkedin/jobs/search', 0, params, 202);
                return res.status(202).json({
                    success: true,
                    status: 'pending',
                    message: result.message || 'Bright Data is still collecting LinkedIn jobs. Poll the snapshot in Bright Data or retry with a narrower search.',
                    snapshot_id: result.snapshotId,
                    credits_charged: 0,
                    credits_remaining: req.user.credits
                });
            }

            req.user.credits -= cost;
            await logApiRequest(req, '/v1/linkedin/jobs/search', cost, params, 200);

            return res.json({
                success: true,
                credits_charged: cost,
                credits_remaining: req.user.credits,
                keyword: params.keyword,
                location: params.location,
                ...result
            });
        } catch (error) {
            console.error('[LinkedIn jobs search]', error);
            await logApiRequest(req, '/v1/linkedin/jobs/search', 0, params, 502);
            return res.status(502).json({
                success: false,
                error: error.message
            });
        }
    });

    return router;
}

module.exports = createLinkedInRouter;
