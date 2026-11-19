const express = require('express');
const { searchJobs, getJobDetails } = require('./linkedin-service');

function createLinkedInRouter(logApiRequest) {
    const router = express.Router();

    router.get('/jobs/search', async (req, res) => {
        const {
            query,
            keyword,
            location,
            datePosted,
            date_posted,
            companyId,
            company_id,
            cursor
        } = req.query;

        const searchQuery = typeof query === 'string'
            ? query.trim()
            : (typeof keyword === 'string' ? keyword.trim() : '');

        if (!searchQuery) {
            return res.status(400).json({
                success: false,
                error: "Missing required parameter 'query'."
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
            query: searchQuery,
            location: typeof location === 'string' ? location.trim() : undefined,
            datePosted: typeof datePosted === 'string'
                ? datePosted.trim()
                : (typeof date_posted === 'string' ? date_posted.trim() : undefined),
            companyId: typeof companyId === 'string'
                ? companyId.trim()
                : (typeof company_id === 'string' ? company_id.trim() : undefined),
            cursor: typeof cursor === 'string' ? cursor.trim() : undefined
        };

        try {
            const result = await searchJobs(params);
            req.user.credits -= cost;
            await logApiRequest(req, '/v1/linkedin/jobs/search', cost, params, 200);

            return res.json({
                success: true,
                credits_charged: cost,
                credits_remaining: req.user.credits,
                query: params.query,
                location: params.location || null,
                ...result
            });
        } catch (error) {
            console.error('[LinkedIn jobs search]', error);
            await logApiRequest(req, '/v1/linkedin/jobs/search', 0, params, error.status || 502);
            const status = error.status >= 400 && error.status < 600 ? error.status : 502;
            return res.status(status).json({
                success: false,
                code: error.code,
                error: error.message
            });
        }
    });

    router.get('/job', async (req, res) => {
        const url = typeof req.query.url === 'string' ? req.query.url.trim() : '';
        if (!url) {
            return res.status(400).json({
                success: false,
                error: "Missing required parameter 'url'."
            });
        }

        const cost = 1;
        if (req.user.credits < cost) {
            return res.status(403).json({
                success: false,
                error: `Insufficient credits. This request requires ${cost} credit.`
            });
        }

        const params = { url };
        try {
            const job = await getJobDetails(url);
            req.user.credits -= cost;
            await logApiRequest(req, '/v1/linkedin/job', cost, params, 200);
            return res.json({
                success: true,
                credits_charged: cost,
                credits_remaining: req.user.credits,
                job
            });
        } catch (error) {
            console.error('[LinkedIn job details]', error);
            await logApiRequest(req, '/v1/linkedin/job', 0, params, error.status || 502);
            const status = error.status >= 400 && error.status < 600 ? error.status : 502;
            return res.status(status).json({
                success: false,
                code: error.code,
                error: error.message
            });
        }
    });

    return router;
}

module.exports = createLinkedInRouter;
