/**
 * EXAMPLE: How to Update Your Reddit Routes with Fallback
 * 
 * Show how to update ONE route, then repeat for the other 4
 * 
 * Your current code:
 *   const data = await scrapeSubredditDetails(name);
 *   req.user.credits -= 1;
 * 
 * New code with fallback:
 *   See below
 */

// ============================================================
// At the TOP of server.js, add this import:
// ============================================================

const redditOrchestrator = require('./src/services/reddit-orchestrator');

// ============================================================
// ROUTE UPDATE EXAMPLE: /v1/reddit/subreddit/details
// ============================================================
// 
// BEFORE:
// ─────────────────────────────────────────────────────────
// app.get('/v1/reddit/subreddit/details', authMiddleware, async (req, res) => {
//     const name = req.query.name || req.query.subreddit;
//     ...
//     const data = await scrapeSubredditDetails(name);
//     req.user.credits -= 1; 
//     ...
// });
//
// AFTER:
// ─────────────────────────────────────────────────────────

app.get('/v1/reddit/subreddit/details', authMiddleware, async (req, res) => {
    const name = req.query.name || req.query.subreddit;

    if (!name) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'name' or 'subreddit'"
        });
    }

    const cacheKey = `reddit_sub_${name.toLowerCase()}`;

    try {
        // Check cache first (UNCHANGED)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0,
                provider: 'cache',  // NEW: show data came from cache
                ...mockRedisCache[cacheKey]
            });
        }

        // --- NEW: Use fallback orchestrator ---
        const result = await redditOrchestrator.execute(
            // Pass your primary scraper as a function
            () => scrapeSubredditDetails(name),
            // Pass the method name for logging
            'subreddit/details'
        );

        // If ALL scrapers failed
        if (!result.success) {
            return res.status(503).json({
                success: false,
                error: result.error,
                details: result.details
            });
        }

        // ✅ NEW: Only deduct credits if external API was used
        // (Your Playwright has creditCost of 0)
        if (result.creditCost > 0) {
            req.user.credits -= result.creditCost;
        }

        mockRedisCache[cacheKey] = result.data;

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: result.creditCost,
            provider: result.provider,  // NEW: Show which provider was used!
            ...result.data
        });

    } catch (error) {
        const statusCode = error.statusCode || 500;
        const errorMessage = error.message || "Internal Server Error";

        if (statusCode >= 500 || statusCode === 403 || statusCode === 429) {
            notifyFailure({
                endpoint: '/v1/reddit/subreddit/details',
                params: { name },
                statusCode,
                errorMsg: errorMessage
            });
        }

        return res.status(statusCode).json({
            success: false,
            error: `${statusCode}: ${errorMessage}`
        });
    }
});

// ============================================================
// PATTERN FOR OTHER 4 ENDPOINTS
// ============================================================
// 
// Repeat the pattern above for:
//   1. /v1/reddit/subreddit/posts    → 'subreddit/posts'
//   2. /v1/reddit/subreddit/search   → 'subreddit/search'
//   3. /v1/reddit/post/comments      → 'post/comments'
//   4. /v1/reddit/search             → 'global/search'
//
// Change only these lines:
//
//   const result = await redditOrchestrator.execute(
//       () => scrapeSubredditPosts(subreddit, sort, timeframe, cursor, limit),
//       'subreddit/posts'  // ← Change this to match
//   );
//
// Everything else stays THE SAME!
//
// ============================================================

module.exports = app;
