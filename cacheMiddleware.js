const crypto = require('crypto');

// In-memory cache. For production, replace this with a Redis client.
const globalCacheStore = {}; 

function parseMaxAgeToMs(maxAgeStr) {
    if (!maxAgeStr) return 0;
    const days = parseInt(maxAgeStr.replace('d', ''), 10);
    if (isNaN(days)) return 0;
    return days * 24 * 60 * 60 * 1000;
}

const universalCacheMiddleware = (req, res, next) => {
    // We intercept cache_max_age, but we DO NOT remove it from req.query
    // because some upstream providers (like ScrapeCreators) might also need it to save you costs.
    const { cache_max_age } = req.query;
    const maxAgeMs = parseMaxAgeToMs(cache_max_age);

    // If the user didn't ask for a cache, skip this entirely
    if (maxAgeMs === 0) {
        return next();
    }

    // Generate a unique hash for this specific endpoint AND its exact parameters
    const endpointBase = req.path.replace(/\//g, '_');
    // Ensure the order of query params doesn't matter by sorting them
    const sortedParams = Object.keys(req.query)
        .sort()
        .reduce((acc, key) => {
            acc[key] = req.query[key];
            return acc;
        }, {});
    
    const paramString = JSON.stringify(sortedParams);
    const hash = crypto.createHash('md5').update(paramString).digest('hex');
    const cacheKey = `${endpointBase}_${hash}`;

    // 1. Check if we have valid cached data
    if (globalCacheStore[cacheKey]) {
        const cachedItem = globalCacheStore[cacheKey];
        const currentAgeMs = Date.now() - cachedItem.timestamp;

        if (currentAgeMs <= maxAgeMs) {
            console.log(`[Cache Hit] Serving cached data for ${cacheKey}`);
            // Return immediately. The actual route code is never executed.
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, // Cached results are free
                ...cachedItem.data
            });
        }
    }

    // 2. Cache miss. Override res.json to capture the output when the route finishes
    const originalJson = res.json;
    
    res.json = function(body) {
        // Only save to cache if the request was successful (200 OK)
        if (res.statusCode === 200 && body && body.success) {
            // Strip out the dynamic billing metadata so it doesn't get hardcoded into the cache
            const { success, credits_remaining, credits_charged, ...dataToCache } = body;
            
            globalCacheStore[cacheKey] = {
                timestamp: Date.now(),
                data: dataToCache
            };
            console.log(`[Cache Save] Stored data for ${cacheKey}`);
        }
        
        // Call the original res.json function to actually send the response to the user
        originalJson.call(this, body);
    };

    next();
};

module.exports = { universalCacheMiddleware };