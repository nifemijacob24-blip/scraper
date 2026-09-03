require('dotenv').config();
require('./patch-playwright');
const express = require('express');

const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const { DodoPayments } = require('dodopayments');

// --- IMPORTS ---
const { scrapeSubredditDetails } = require('./src/scrapers/reddit');
const { scrapeSubredditPosts } = require('./src/scrapers/reddit');
const { scrapeSubredditSearch } = require('./src/scrapers/reddit');
const { notifyFailure } = require('./src/utils/notifier');

// --- 1. INITIALIZE SUPABASE ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; 

// Initialize Supabase with the manual WebSocket injected
const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
        persistSession: false // Best practice for server-side clients
    },
    global: {
        WebSocket: WebSocket // <-- This is the magic fix for Node 20
    }
});

// --- 2. INITIALIZE DODO PAYMENTS ---
const dodo = new DodoPayments({
    bearerToken: process.env.DODO_PAYMENTS_API_KEY,
    webhookKey: process.env.DODO_PAYMENTS_WEBHOOK_KEY,
    environment: 'live_mode' // Change to 'live_mode' when you launch!
});

// --- INITIALIZE EXPRESS ---
const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// ROUTING ORDER CRITICAL
// 1. Webhook (Raw Body)
// 2. Global Parsers (JSON & CORS)
// 3. Checkout & Other Routes
// ==========================================

// --- 1. WEBHOOK (Must be before express.json) ---
app.post('/api/webhook/dodo', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        // Verify the cryptographic signature securely using the SDK
        const event = dodo.webhooks.unwrap(req.body, req.headers);

        // Look for successful payments
        if (event.type === 'payment.succeeded') {
            const payment = event.data;
            
            // Extract the custom metadata we passed during checkout
            const userId = payment.metadata?.user_id;
            const tier = payment.metadata?.tier; 
            
            if (userId && tier) {
                // Determine how many credits to add based on the tier
                let creditsToAdd = 0;
                
                if (tier === 'freelance') {
                    creditsToAdd = 25000;
                } else if (tier === 'business') {
                    creditsToAdd = 500000;
                } else {
                    console.warn(`Unrecognized tier mapped in webhook: ${tier}`);
                }

                // Find the user in Supabase and add their credits
                if (creditsToAdd > 0) {
                    const { data: profile } = await supabase
                        .from('profiles')
                        .select('credits')
                        .eq('id', userId)
                        .single();
                    
                    if (profile) {
                        const newBalance = profile.credits + creditsToAdd;
                        
                        await supabase
                            .from('profiles')
                            .update({ credits: newBalance })
                            .eq('id', userId);
                            
                        console.log(`✅ Payment Succeeded: Granted ${creditsToAdd} credits to user ${userId}. New balance: ${newBalance}`);
                    }
                }
            }
        }

        // Always return 200 OK so Dodo knows you received it
        res.status(200).send('Webhook processed');
    } catch (err) {
        console.error('Webhook Verification Error:', err.message);
        res.status(401).send(`Webhook Error: ${err.message}`);
    }
});

// --- 2. GLOBAL PARSERS ---
app.use(cors({
    origin: [
        'https://signalqub.com', 
        'https://www.signalqub.com',
        'http://localhost:5173'
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true
}));

app.use(express.json());


// --- 3. CHECKOUT ROUTE ---
const DODO_PRODUCTS = {
    freelance: 'pdt_0Nm64vHyFBNMYQ8psOOvG',   // $43 / 25k credits
    business: 'pdt_0Nm65NK5dcgDghkgeaYD5'      // $448 / 500k credits
};

// ** NOTE: Make sure your `authMiddleware` function is defined below here in your file! **
app.post('/api/checkout', authMiddleware, async (req, res) => {
    try {
        const { tier } = req.body; 
        const productId = DODO_PRODUCTS[tier];

        if (!productId) {
            return res.status(400).json({ success: false, error: "Invalid pricing tier selected." });
        }

        const session = await dodo.checkoutSessions.create({
            product_cart: [{
                product_id: productId,
                quantity: 1
            }],
            metadata: {
                user_id: req.user.id,
                tier: tier
            },
            return_url: 'https://signalqub.com/dashboard?payment=success'
        });
        
        res.json({ success: true, url: session.checkout_url });
    } catch (error) {
        console.error("Checkout Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});


const mockRedisCache = {}; // Keeping your cache intact

// Helper function to format and trim post payloads (Unchanged)
function formatRedditPosts(rawPostsArray, trim = false) {
    if (!trim) return rawPostsArray;

    return rawPostsArray.map(post => ({
        id: post.id,
        name: post.name,
        subreddit: post.subreddit,
        author: post.author,
        author_fullname: post.author_fullname,
        title: post.title,
        selftext: post.selftext || "",
        score: post.score,
        ups: post.ups,
        upvote_ratio: post.upvote_ratio,
        num_comments: post.num_comments,
        created_utc: post.created_utc,
        url: post.url,
        permalink: post.permalink,
        is_self: post.is_self,
        is_video: post.is_video,
        thumbnail: (post.thumbnail === "self" || post.thumbnail === "default" || post.thumbnail === "") 
            ? null 
            : post.thumbnail
    }));
}

// 2. The NEW Supabase Authentication Middleware
async function authMiddleware(req, res, next) {
    // Support both "x-api-key: sq_live_..." and "Authorization: Bearer sq_live_..." headers
    let apiKey = req.headers['x-api-key'];
    if (!apiKey && req.headers['authorization']) {
        const authHeader = req.headers['authorization'];
        if (authHeader.startsWith('Bearer ')) {
            apiKey = authHeader.substring(7);
        }
    }

    if (!apiKey) {
        return res.status(403).json({ success: false, error: "403 Forbidden: Missing API Key header." });
    }

    try {
        // Fetch user from Supabase using the API key
        const { data: userProfile, error } = await supabase
            .from('profiles')
            .select('id, email, credits, api_key')
            .eq('api_key', apiKey)
            .single();

        if (error || !userProfile) {
            return res.status(403).json({ success: false, error: "403 Forbidden: Invalid API Key." });
        }

        if (userProfile.credits <= 0) {
            return res.status(403).json({ success: false, error: "403 Forbidden: Insufficient credits." });
        }

        // Create the user object for the request
        req.user = {
            id: userProfile.id,
            email: userProfile.email,
            api_key: userProfile.api_key
        };

        // --- THE MAGIC TRICK ---
        // This intercepts `req.user.credits -= 1` in your endpoints 
        // and automatically syncs the new balance to the database!
        // --- THE MAGIC TRICK (Upgraded for Graphs) ---
        let currentCredits = userProfile.credits;
        Object.defineProperty(req.user, 'credits', {
            get: function() { return currentCredits; },
            set: function(newVal) {
                const cost = currentCredits - newVal; // Calculate credits spent
                currentCredits = newVal;
                
                // 1. Deduct from balance
                supabase.from('profiles')
                    .update({ credits: newVal })
                    .eq('id', userProfile.id)
                    .then(({error}) => { if (error) console.error("DB Credit sync failed:", error); });
                
                // 2. Log it to the graph ledger! (Only if they actually spent credits)
                if (cost > 0) {
                    supabase.from('api_logs')
                        .insert([{ user_id: userProfile.id, cost: cost }])
                        .then(({error}) => { if (error) console.error("DB Log sync failed:", error); });
                }
            }
        });

        next();
    } catch (err) {
        console.error("Auth Middleware Error:", err);
        return res.status(500).json({ success: false, error: "Internal Server Error verifying API key." });
    }
}

// --- ENDPOINT 1: SUBREDDIT DETAILS (1 CREDIT) ---
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
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0,
                ...mockRedisCache[cacheKey]
            });
        }

        const data = await scrapeSubredditDetails(name);

        req.user.credits -= 1; 
        mockRedisCache[cacheKey] = data;

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: 1,
            ...data
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

// --- 2. UPDATED EXPRESS ROUTE ---
app.get('/v1/reddit/subreddit/posts', authMiddleware, async (req, res) => {
    const subreddit = req.query.subreddit || req.query.name;
    const sort = req.query.sort || 'hot';
    const timeframe = req.query.timeframe || 'all';
    
    // Support both 'cursor' and 'after' for backward compatibility
    const cursor = req.query.cursor || req.query.after || null; 
    
    // Parse limit, fallback to 100
    const limit = parseInt(req.query.limit, 10) || 100; 
    const trim = req.query.trim === 'true';

    if (!subreddit) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'subreddit'"
        });
    }

    if (req.user.credits < 2) {
        return res.status(403).json({
            success: false,
            error: "403 Forbidden: Insufficient credits (Requires 2 credits)"
        });
    }

    // Cache key now includes limit and cursor
    const cacheKey = `reddit_posts_${subreddit.toLowerCase()}_${sort}_${timeframe}_${cursor || 'start'}_${limit}_trim_${trim}`;

    try {
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0,
                ...mockRedisCache[cacheKey]
            });
        }

        const data = await scrapeSubredditPosts(subreddit, sort, timeframe, cursor, limit);
        const formattedPosts = formatRedditPosts(data.posts, trim);

        req.user.credits -= 2;

        const responsePayload = {
            posts: formattedPosts,
            next_cursor: data.next_cursor
        };

        mockRedisCache[cacheKey] = responsePayload;

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: 2,
            ...responsePayload
        });

    } catch (error) {
        const statusCode = error.statusCode || 500;
        const errorMessage = error.message || "Internal Server Error";

        if (statusCode >= 500 || statusCode === 403 || statusCode === 429) {
            notifyFailure({
                endpoint: '/v1/reddit/subreddit/posts',
                params: { subreddit, sort, timeframe, cursor, limit, trim },
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


app.get('/v1/reddit/subreddit/search', authMiddleware, async (req, res) => {
    const subreddit = req.query.subreddit || req.query.name;
    const query = req.query.q || req.query.query;
    const sort = req.query.sort || 'relevance';
    const timeframe = req.query.timeframe || 'all';
    
    // Support both 'cursor' and 'after' for backward compatibility
    const cursor = req.query.cursor || req.query.after || null;
    
    // Parse limit, fallback to 100
    const limit = parseInt(req.query.limit, 10) || 100;

    if (!subreddit || !query) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameters 'subreddit' and 'q'"
        });
    }

    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    // Cache key now includes limit and cursor
    const cacheKey = `reddit_search_${subreddit.toLowerCase()}_${Buffer.from(query).toString('base64')}_${sort}_${timeframe}_${cursor || 'start'}_${limit}`;

    try {
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0,
                ...mockRedisCache[cacheKey]
            });
        }

        // Pass limit into scraper
        const searchData = await scrapeSubredditSearch(subreddit, query, sort, timeframe, cursor, limit);

        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = searchData;

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...searchData
        });

    } catch (error) {
        const statusCode = error.statusCode || 500;
        const errorMessage = error.message || "Internal Server Error";

        // Ping Discord immediately on failure
        notifyFailure({
            endpoint: '/v1/reddit/subreddit/search',
            params: { subreddit, query, sort, timeframe, cursor, limit }, // Added limit to webhook payload
            statusCode,
            errorMsg: errorMessage
        });

        return res.status(statusCode).json({
            success: false,
            error: `${statusCode}: ${errorMessage}`
        });
    }
});

const { scrapePostComments } = require('./src/scrapers/reddit');

// --- ENDPOINT 4: POST COMMENTS (1 CREDIT) ---
// --- 3. UPDATED EXPRESS ROUTE ---
app.get('/v1/reddit/post/comments', authMiddleware, async (req, res) => {
    const postUrl = req.query.url || req.query.permalink;
    
    // Support both 'cursor' and 'after' for standard API inputs
    const cursor = req.query.cursor || req.query.after || null;
    const limit = parseInt(req.query.limit, 10) || 100;

    if (!postUrl) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'url'"
        });
    }

    // Basic validation to ensure it's a reddit URL
    if (!postUrl.includes('reddit.com/r/') || !postUrl.includes('/comments/')) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Invalid Reddit post URL"
        });
    }

    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    // Extract the post ID (e.g., "ablzuq") from the URL for a clean cache key
    const urlParts = postUrl.split('/comments/');
    const postId = urlParts.length > 1 ? urlParts[1].split('/')[0] : 'unknown';
    
    // Include limit and cursor in cache key to avoid collisions
    const cacheKey = `reddit_comments_${postId}_${cursor || 'start'}_${limit}`;

    try {
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0,
                ...mockRedisCache[cacheKey]
            });
        }

        // Pass limit and cursor to the scraper
        const data = await scrapePostComments(postUrl, limit, cursor);

        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = data;

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...data
        });

    } catch (error) {
        const statusCode = error.statusCode || 500;
        const errorMessage = error.message || "Internal Server Error";

        // Ping Discord immediately on failure
        notifyFailure({
            endpoint: '/v1/reddit/post/comments',
            params: { postUrl, cursor, limit },
            statusCode,
            errorMsg: errorMessage
        });

        return res.status(statusCode).json({
            success: false,
            error: `${statusCode}: ${errorMessage}`
        });
    }
});

const { scrapeGlobalSearch } = require('./src/scrapers/reddit');

// --- ENDPOINT 5: GLOBAL SEARCH (1 CREDIT) ---
// --- 2. UPDATED EXPRESS ROUTE ---
app.get('/v1/reddit/search', authMiddleware, async (req, res) => {
    const query = req.query.q || req.query.query;
    const sort = req.query.sort || 'relevance';
    const timeframe = req.query.timeframe || 'all';
    
    // Support both 'cursor' and 'after' for backward compatibility
    const cursor = req.query.cursor || req.query.after || null;
    
    // Parse limit, fallback to 100
    const limit = parseInt(req.query.limit, 10) || 100;

    if (!query) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'q'"
        });
    }

    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    // Cache key now includes limit and cursor
    const cacheKey = `reddit_global_search_${Buffer.from(query).toString('base64')}_${sort}_${timeframe}_${cursor || 'start'}_${limit}`;

    try {
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0,
                ...mockRedisCache[cacheKey]
            });
        }

        // Pass cursor and limit to the scraper
        const data = await scrapeGlobalSearch(query, sort, timeframe, cursor, limit);

        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = data;

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...data
        });

    } catch (error) {
        const statusCode = error.statusCode || 500;
        const errorMessage = error.message || "Internal Server Error";

        // Ping Discord immediately on failure
        notifyFailure({
            endpoint: '/v1/reddit/search',
            params: { query, sort, timeframe, cursor, limit }, // Added limit to payload
            statusCode,
            errorMsg: errorMessage
        });

        return res.status(statusCode).json({
            success: false,
            error: `${statusCode}: ${errorMessage}`
        });
    }
});

const { scrapeInstagramProfile } = require('./src/scrapers/instagram');

// --- ENDPOINT 6: INSTAGRAM PROFILE (1 CREDIT) ---
app.get('/v1/instagram/profile', authMiddleware, async (req, res) => {
    const username = req.query.username || req.query.user;

    if (!username) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'username'"
        });
    }

    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    // Clean username for cache key
    const cleanUsername = username.replace('@', '').split('?')[0].replace(/\/$/, '').toLowerCase();
    const cacheKey = `instagram_profile_${cleanUsername}`;

    try {
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0,
                ...mockRedisCache[cacheKey]
            });
        }

        const data = await scrapeInstagramProfile(cleanUsername);

        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = data;

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...data
        });

    } catch (error) {
        const statusCode = error.statusCode || 500;
        const errorMessage = error.message || "Internal Server Error";

        notifyFailure({
            endpoint: '/v1/instagram/profile',
            params: { username: cleanUsername },
            statusCode,
            errorMsg: errorMessage
        });

        return res.status(statusCode).json({
            success: false,
            error: `${statusCode}: ${errorMessage}`
        });
    }
});

// In your main router file (e.g., app.js or routes.js)
// --- EXPRESS ROUTE: INSTAGRAM USER FEED (ARBITRAGE) ---
// --- EXPRESS ROUTE: INSTAGRAM USER POSTS (v2 ARBITRAGE) ---
app.get('/v1/instagram/user/posts', authMiddleware, async (req, res) => {
    // Support both 'handle' and 'username' so you don't break existing consumers
    const handle = req.query.handle || req.query.username;
    const cursor = req.query.next_max_id || req.query.cursor || null;
    const trim = req.query.trim === 'true';

    if (!handle) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'handle'" 
        });
    }

    // Clean up the handle in case users paste full URLs or '@' symbols
    let cleanHandle = handle.split('?')[0].replace(/\/$/, '').replace('@', '');
    if (cleanHandle.includes('instagram.com/')) {
        cleanHandle = cleanHandle.split('instagram.com/')[1].split('/')[0];
    }

    const costPerRequest = 2; // DaaS markup

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    // Cache key incorporates the trim parameter to avoid serving trimmed data to a non-trim request
    const cacheKey = `ig_user_posts_v2_${cleanHandle}_${cursor || 'start'}_${trim}`;

    try {
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0,
                ...mockRedisCache[cacheKey]
            });
        }

        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v2/instagram/user/posts');
        targetUrl.searchParams.append('handle', cleanHandle);
        
        if (cursor) {
            targetUrl.searchParams.append('next_max_id', cursor);
        }
        if (trim) {
            targetUrl.searchParams.append('trim', 'true');
        }

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(15000)
        });

        const upstreamPayload = await response.json();

        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch user posts'}`);
        }

        // Standardize the output so your consumers get a consistent format
        // Note: As you mentioned, 'play_count' inside items will be IG-only views
        const responseData = {
            user: upstreamPayload.user || null,
            post_count: upstreamPayload.num_results || (upstreamPayload.items ? upstreamPayload.items.length : 0),
            has_more: upstreamPayload.more_available || false,
            next_cursor: upstreamPayload.next_max_id || null, 
            posts: upstreamPayload.items || [] 
        };

        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = responseData;

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : errorMessage;

        // Discord Failure Alert
        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/instagram/user/posts',
                params: { handle: cleanHandle, next_max_id: cursor, trim },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

// --- EXPRESS ROUTE: INSTAGRAM USER HIGHLIGHTS (ARBITRAGE) ---
app.get('/v1/instagram/user/highlights', authMiddleware, async (req, res) => {
    // API supports both, but prefers user_id for speed
    const userId = req.query.user_id;
    const handle = req.query.handle || req.query.username;

    if (!userId && !handle) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. Provide either 'user_id' or 'handle'." 
        });
    }

    // Clean up handle if it was provided
    let cleanHandle = handle ? handle.split('?')[0].replace(/\/$/, '').replace('@', '') : null;
    if (cleanHandle && cleanHandle.includes('instagram.com/')) {
        cleanHandle = cleanHandle.split('instagram.com/')[1].split('/')[0];
    }

    const costPerRequest = 2;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    // Create a unique cache key depending on which parameter they used
    const cacheKey = userId 
        ? `ig_highlights_id_${userId}` 
        : `ig_highlights_handle_${cleanHandle}`;

    try {
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0,
                ...mockRedisCache[cacheKey]
            });
        }

        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/instagram/user/highlights');
        
        if (userId) {
            targetUrl.searchParams.append('user_id', userId);
        } else if (cleanHandle) {
            targetUrl.searchParams.append('handle', cleanHandle);
        }

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(15000)
        });

        const upstreamPayload = await response.json();

        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch highlights'}`);
        }

        // Safely extract the highlights array
        const highlights = upstreamPayload.highlights || (upstreamPayload.data && upstreamPayload.data.highlights) || [];

        const responseData = {
            highlights_count: highlights.length,
            highlights: highlights
        };

        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = responseData;

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : errorMessage;

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/instagram/user/highlights',
                params: { user_id: userId, handle: cleanHandle },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

// In your main router file (e.g., app.js or routes.js)
const { transcribeVideoBuffer } = require('./src/services/transcription');
// Assume you build a scrapeSinglePost function using your existing Playwright architecture

const { scrapeSinglePost } = require('./src/scrapers/instagram');

app.get('/v1/instagram/post', authMiddleware, async (req, res) => {
    // 1. Extract parameters from the user's request
    const { shortcode, region, trim, download_media, cache_max_age } = req.query;

    if (!shortcode) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'shortcode'" 
        });
    }

    // 2. Determine maximum expected cost to protect user margins
    // Upstream charges up to 10 credits if media is successfully downloaded
    const isDownloadRequested = String(download_media).toLowerCase() === 'true';
    const maxExpectedCost = isDownloadRequested ? 10 : 1;

    if (req.user.credits < maxExpectedCost) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires up to ${maxExpectedCost} credits.`
        });
    }

    // 3. Safely construct the Upstream URL
    const upstreamUrl = new URL('https://api.scrapecreators.com/v1/instagram/post');
    
    // Auto-correct: If user passed a full URL instead of a shortcode, pass it directly.
    // Otherwise, convert the shortcode to an IG post URL.
    let targetUrl = shortcode;
    if (!shortcode.startsWith('http')) {
        targetUrl = `https://www.instagram.com/p/${shortcode}/`;
    }
    
    upstreamUrl.searchParams.append('url', targetUrl);
    
    // Append optional upstream parameters if the user provided them
    if (region) upstreamUrl.searchParams.append('region', region);
    if (trim) upstreamUrl.searchParams.append('trim', trim);
    if (download_media) upstreamUrl.searchParams.append('download_media', download_media);
    if (cache_max_age) upstreamUrl.searchParams.append('cache_max_age', cache_max_age);

    try {
        console.log(`[SignalQub] Calling ScrapeCreators for: ${targetUrl}`);

        // 4. Make the API call to ScrapeCreators
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': process.env.SCRAPE_CREATORS_API_KEY, // Ensure this is set in DigitalOcean!
                'Content-Type': 'application/json'
            }
        });

        const targetData = await response.json();
        
        // 🚨 DIAGNOSTIC LOG: Prints the EXACT response to DigitalOcean logs so you can debug failures
        console.log(`[Upstream Response] Status: ${response.status}`, JSON.stringify(targetData).substring(0, 250));

        // 5. Intercept and Sanitize Errors (White-labeling)
        if (!response.ok || !targetData.success) {
            const statusCode = response.status === 200 ? 500 : response.status;
            
            // Extract the real error message safely
            const rawError = targetData.detail || targetData.message || targetData.error || "Unknown extraction error occurred.";
            
            let cleanErrorMsg = "500 Internal Server Error: Extraction failed. The engineering team has been notified.";

            if (statusCode === 404) {
                cleanErrorMsg = "404 Not Found: The requested Instagram post does not exist, was deleted, or the account is private.";
            } else if (statusCode === 429) {
                cleanErrorMsg = "429 Too Many Requests: Extraction rate limit exceeded. Please back off and retry.";
            } else if (statusCode === 400 || statusCode === 422 || statusCode === 401 || statusCode === 403) {
                // Pass the specific error but sanitize upstream names to maintain the SignalQub brand
                cleanErrorMsg = `${statusCode} Error: ${rawError.replace(/scrapecreators|upstream|provider/ig, 'SignalQub')}`;
            } else if (statusCode >= 500) {
                cleanErrorMsg = "500 Internal Server Error: Instagram anti-bot protection triggered. Please try again in a few moments.";
            }

            return res.status(statusCode).json({
                success: false,
                error: cleanErrorMsg
            });
        }

        // 6. Deduct the EXACT credits charged by the provider
        const actualCreditsCharged = targetData.credits_charged || 1;
        req.user.credits -= actualCreditsCharged;

        // 7. Return the formatted success response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCreditsCharged,
            status: "success",
            data: targetData.data // The raw xdt_shortcode_media object
        });

    } catch (error) {
        console.error('[SignalQub] Extraction Error:', error);
        
        // Catch network timeouts or fetch crashes
        return res.status(504).json({ 
            success: false, 
            error: `504 Gateway Timeout: The extraction engine took too long to respond or failed. (${error.message})` 
        });
    }
});

app.get('/v1/instagram/transcript', authMiddleware, async (req, res) => {
    // 1. Extract parameters
    const { shortcode, cache_max_age } = req.query;

    if (!shortcode) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'shortcode'" 
        });
    }

    // 2. Set your internal pricing
    const costPerRequest = 2;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. Transcripts require ${costPerRequest} credits.`
        });
    }

    // 3. Construct the Upstream URL for ScrapeCreators V2
    const upstreamUrl = new URL('https://api.scrapecreators.com/v2/instagram/media/transcript');
    
    // Auto-correct: Ensure we pass a full URL to the upstream provider
    let targetUrl = shortcode;
    if (!shortcode.startsWith('http')) {
        targetUrl = `https://www.instagram.com/p/${shortcode}/`;
    }
    
    upstreamUrl.searchParams.append('url', targetUrl);
    if (cache_max_age) upstreamUrl.searchParams.append('cache_max_age', cache_max_age);

    try {
        console.log(`[SignalQub] Requesting AI Transcript for: ${targetUrl}`);

        // 4. Call the upstream AI transcription endpoint
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': process.env.SCRAPE_CREATORS_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        const targetData = await response.json();

        // 🚨 Diagnostic Log
        console.log(`[Upstream Transcript] Status: ${response.status}`, JSON.stringify(targetData).substring(0, 200));

        // 5. White-labeled Error Handling
        if (!response.ok || !targetData.success) {
            const statusCode = response.status === 200 ? 500 : response.status;
            const rawError = targetData.detail || targetData.message || targetData.error || "Failed to generate transcript.";
            
            let cleanErrorMsg = "500 Internal Server Error: AI Transcription failed. The engineering team has been notified.";

            if (statusCode === 404) {
                cleanErrorMsg = "404 Not Found: The requested video does not exist or the account is private.";
            } else if (statusCode === 429) {
                cleanErrorMsg = "429 Too Many Requests: Rate limit exceeded. Please back off and retry.";
            } else if (statusCode === 400 || statusCode === 422 || statusCode === 401 || statusCode === 403) {
                cleanErrorMsg = `${statusCode} Error: ${rawError.replace(/scrapecreators|upstream|provider/ig, 'SignalQub')}`;
            } else if (statusCode >= 500) {
                cleanErrorMsg = "500 Internal Server Error: Video extraction or transcription process failed. Please ensure the video is under 2 minutes.";
            }

            return res.status(statusCode).json({
                success: false,
                error: cleanErrorMsg
            });
        }

        // 6. Map the upstream data to match your existing SignalQub schema
        // The upstream returns "text", but your Apify Actor expects "transcript" and "type"
        const formattedTranscripts = (targetData.transcripts || []).map(t => ({
            id: t.id,
            type: 'video', 
            transcript: t.text || null // Map "text" to "transcript"
        }));

        // 7. Deduct the credits
        req.user.credits -= costPerRequest;

        // 8. Return the final payload
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            status: "success",
            data: {
                shortcode: shortcode,
                transcripts: formattedTranscripts
            }
        });

    } catch (error) {
        console.error('[SignalQub] Transcript Error:', error);
        
        // AI Transcriptions can take 10-30 seconds, making Gateway Timeouts more common here
        return res.status(504).json({ 
            success: false, 
            error: "504 Gateway Timeout: The AI transcription engine took too long to respond. The video may be too long or the queue is full." 
        });
    }
});

// --- 2. EXPRESS ROUTE ---
// --- EXPRESS ROUTE: INSTAGRAM ARBITRAGE SEARCH ---
// --- EXPRESS ROUTE: INSTAGRAM ARBITRAGE SEARCH ---
app.get('/v1/instagram/search', authMiddleware, async (req, res) => {
    const query = req.query.q || req.query.query;
    
    if (!query) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'query'"
        });
    }

    const costPerRequest = 2;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    const cacheKey = `ig_native_search_${Buffer.from(query).toString('base64')}`;

    try {
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                data: mockRedisCache[cacheKey]
            });
        }

        // 1. Fetch from Upstream API (ScrapeCreators)
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/instagram/search');
        targetUrl.searchParams.append('query', query);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(15000) 
        });

        // Rename variable to avoid shadowing
        const upstreamPayload = await response.json();

        // 2. Handle Upstream Errors
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Unknown Error'}`);
        }

        // THE FIX: If they nested it inside .data, extract it. Otherwise, pass the whole payload.
        const scrapedContent = upstreamPayload.data !== undefined ? upstreamPayload.data : upstreamPayload;

        // 3. Deduct Credits & Cache
        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = scrapedContent;

        // 4. Return to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            data: scrapedContent
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : errorMessage;

        // Fire Discord Webhook
        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/instagram/search',
                params: { query },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

// --- EXPRESS ROUTE: INSTAGRAM TAGGED POSTS ---
app.get('/v1/instagram/user/tagged-posts', authMiddleware, async (req, res) => {
    const userId = req.query.user_id;
    const cursor = req.query.cursor || null;

    if (!userId) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'user_id'"
        });
    }

    const costPerRequest = 2;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    const cacheKey = `ig_tagged_posts_${userId}_${cursor || 'start'}`;

    try {
        // 1. Cache Check
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, // Free if served from cache
                ...mockRedisCache[cacheKey]
            });
        }

        // 2. Fetch from ScrapeCreators
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/instagram/user/tagged-posts');
        targetUrl.searchParams.append('user_id', userId);
        if (cursor) {
            targetUrl.searchParams.append('cursor', cursor);
        }

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(15000)
        });

        const upstreamPayload = await response.json();

        // 3. Handle Upstream Errors
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch tagged posts'}`);
        }

        // Safely extract posts and pagination data
        const posts = upstreamPayload.posts || (upstreamPayload.data && upstreamPayload.data.posts) || [];
        const nextCursor = upstreamPayload.cursor || (upstreamPayload.data && upstreamPayload.data.cursor) || null;
        const hasMore = upstreamPayload.has_more ?? (upstreamPayload.data && upstreamPayload.data.has_more) ?? false;

        const responseData = {
            posts: posts,
            cursor: nextCursor,
            has_more: hasMore
        };

        // 4. Deduct Credits & Cache
        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = responseData;

        // 5. Return to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : errorMessage;

        // Discord Failure Alert
        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/instagram/user/tagged-posts',
                params: { user_id: userId, cursor },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});


// --- EXPRESS ROUTE: INSTAGRAM POST COMMENTS ---
app.get('/v1/instagram/post/comments', authMiddleware, async (req, res) => {
    const postUrl = req.query.url;
    const cursor = req.query.cursor || null;
    const includeReplies = req.query.include_replies === 'true'; // Boolean cast

    if (!postUrl) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'url'"
        });
    }

    // Dynamic Pricing Logic: Base is 2 credits, Replies are 30 credits (2x markup)
    const costPerRequest = includeReplies ? 30 : 2;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    // Cache key includes the include_replies flag to prevent serving base data to a replies request
    const cacheKey = `ig_comments_${Buffer.from(postUrl).toString('base64')}_${cursor || 'start'}_${includeReplies}`;

    try {
        // 1. Cache Check
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 2. Fetch from ScrapeCreators
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v2/instagram/post/comments');
        targetUrl.searchParams.append('url', postUrl);
        
        if (cursor) {
            targetUrl.searchParams.append('cursor', cursor);
        }
        if (includeReplies) {
            targetUrl.searchParams.append('include_replies', 'true');
        }

        // 35-second timeout because upstream can take up to 29 seconds when fetching replies
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(35000) 
        });

        const upstreamPayload = await response.json();

        // 3. Handle Upstream Errors (Expected ~10% of the time according to docs)
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch comments'}`);
        }

        // 4. Safely extract comments and pagination data
        const comments = upstreamPayload.comments || (upstreamPayload.data && upstreamPayload.data.comments) || [];
        const nextCursor = upstreamPayload.cursor || (upstreamPayload.data && upstreamPayload.data.cursor) || null;

        const responseData = {
            comments: comments,
            cursor: nextCursor
        };

        // 5. Deduct Credits & Cache
        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = responseData;

        // 6. Return to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond. This is common when include_replies=true." : errorMessage;

        // Discord Failure Alert - crucial for monitoring this specific 90%-success endpoint
        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/instagram/post/comments',
                params: { url: postUrl, cursor, include_replies: includeReplies },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // Only refund/don't charge the user if the request failed
        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

const {scrapeYouTubeChannelInfo,} = require('./src/scrapers/youtube');

// --- 2. EXPRESS ROUTE ---

// --- 2. EXPRESS ROUTE ---
app.get('/v1/youtube/channel', authMiddleware, async (req, res) => {
    const query = req.query.channelId || req.query.handle || req.query.url || req.query.q;

    if (!query) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter (channelId, handle, or url)"
        });
    }

    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    const cacheKey = `yt_channel_exact_${Buffer.from(query).toString('base64')}`;

    try {
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0,
                // Spread cached data directly at root
                ...mockRedisCache[cacheKey] 
            });
        }

        const channelData = await scrapeYouTubeChannelInfo(query);

        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = channelData;

        // Return flat JSON matching the requested schema exactly
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...channelData 
        });

    } catch (error) {
        const statusCode = error.statusCode || 500;
        const errorMessage = error.message || "Internal Server Error";
        
        const isTimeout = error.name === 'TimeoutError';
        const finalStatus = isTimeout ? 504 : statusCode;
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: YouTube took too long to respond." : errorMessage;

        // Discord Alert
        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/channel',
                params: { query },
                statusCode: finalStatus,
                errorMsg: finalErrorMsg
            });
        }

        return res.status(finalStatus).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

app.get('/v1/youtube/channel/videos', authMiddleware, async (req, res) => {
    const { 
        channelId, 
        handle, 
        sort, 
        continuationToken, 
        is_paid_promotions, 
        includeExtras 
    } = req.query;

    // 1. Validation: Must have at least one identifier
    if (!channelId && !handle) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'channelId' or 'handle'"
        });
    }

    // Dynamic Pricing Logic: Base is 1 credit as per spec. 
    // You can adjust this if includeExtras adds more cost later.
    const costPerRequest = 2;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    // Cache key includes all relevant parameters to prevent data bleed between different query states
    const identifier = channelId || handle;
    const cacheKey = `yt_vids_${Buffer.from(identifier).toString('base64')}_${continuationToken || 'start'}_${sort || 'latest'}_${is_paid_promotions || 'false'}_${includeExtras || 'false'}`;

    try {
        // 1. Cache Check
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 2. Fetch from ScrapeCreators
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/youtube/channel-videos');
        
        // Append dynamic params
        if (channelId) targetUrl.searchParams.append('channelId', channelId);
        if (handle) targetUrl.searchParams.append('handle', handle);
        if (sort) targetUrl.searchParams.append('sort', sort);
        if (continuationToken) targetUrl.searchParams.append('continuationToken', continuationToken);
        if (is_paid_promotions === 'true') targetUrl.searchParams.append('is_paid_promotions', 'true');
        if (includeExtras === 'true') targetUrl.searchParams.append('includeExtras', 'true');

        // 35-second timeout safeguard
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(35000) 
        });

        const upstreamPayload = await response.json();

        // 3. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch channel videos'}`);
        }

        // 4. Safely extract data
        const videos = upstreamPayload.videos || [];
        const nextToken = upstreamPayload.continuationToken || null;

        const responseData = {
            videos: videos,
            continuationToken: nextToken
        };

        // 5. Deduct Credits & Cache
        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = responseData;

        // 6. Return to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        
        // Custom timeout message, noting that includeExtras increases error rate per their docs
        let finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : errorMessage;
        if (isTimeout && includeExtras === 'true') {
            finalErrorMsg += " Note: The includeExtras flag is known to increase latency and error rates.";
        }

        // Discord Failure Alert - syncs perfectly with your existing monitoring setup
        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/channel/videos',
                params: { channelId, handle, sort, continuationToken, is_paid_promotions, includeExtras },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // Only refund/don't charge the user if the request failed
        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

app.get('/v1/youtube/channel/playlists', authMiddleware, async (req, res) => {
    const { 
        channelId, 
        handle, 
        continuationToken 
    } = req.query;

    // 1. Validation: Must have at least one identifier
    if (!channelId && !handle) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'channelId' or 'handle'"
        });
    }

    // Dynamic Pricing Logic: Base is 1 credit as per spec.
    const costPerRequest = 2;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    // Cache key includes the identifier and token
    const identifier = channelId || handle;
    const cacheKey = `yt_playlists_${Buffer.from(identifier).toString('base64')}_${continuationToken || 'start'}`;

    try {
        // 1. Cache Check
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 2. Fetch from ScrapeCreators
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/youtube/channel/playlists');
        
        // Append dynamic params
        if (channelId) targetUrl.searchParams.append('channelId', channelId);
        if (handle) targetUrl.searchParams.append('handle', handle);
        if (continuationToken) targetUrl.searchParams.append('continuationToken', continuationToken);

        // 35-second timeout safeguard
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(35000) 
        });

        const upstreamPayload = await response.json();

        // 3. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch channel playlists'}`);
        }

        // 4. Safely extract data
        const playlists = upstreamPayload.playlists || [];
        const nextToken = upstreamPayload.continuationToken || null;

        const responseData = {
            playlists: playlists,
            continuationToken: nextToken
        };

        // 5. Deduct Credits & Cache
        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = responseData;

        // 6. Return to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : errorMessage;

        // Discord Failure Alert
        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/channel/playlists',
                params: { channelId, handle, continuationToken },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // Only refund/don't charge the user if the request failed
        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

app.get('/v1/youtube/channel/lives', authMiddleware, async (req, res) => {
    const { 
        channelId, 
        handle, 
        continuationToken 
    } = req.query;

    // 1. Validation: Must have at least one identifier
    if (!channelId && !handle) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'channelId' or 'handle'"
        });
    }

    // Dynamic Pricing Logic: Base is 1 credit as per spec.
    const costPerRequest = 2;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    // Cache key includes the identifier and token to protect your profit margins
    const identifier = channelId || handle;
    const cacheKey = `yt_lives_${Buffer.from(identifier).toString('base64')}_${continuationToken || 'start'}`;

    try {
        // 1. Cache Check (This is where your markup becomes 100% profit)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, // Or charge them depending on your billing model for cached data
                ...mockRedisCache[cacheKey]
            });
        }

        // 2. Fetch from ScrapeCreators
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/youtube/channel/lives');
        
        // Append dynamic params
        if (channelId) targetUrl.searchParams.append('channelId', channelId);
        if (handle) targetUrl.searchParams.append('handle', handle);
        if (continuationToken) targetUrl.searchParams.append('continuationToken', continuationToken);

        // 35-second timeout safeguard
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(35000) 
        });

        const upstreamPayload = await response.json();

        // 3. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch channel lives'}`);
        }

        // 4. Safely extract data
        const lives = upstreamPayload.lives || [];
        const nextToken = upstreamPayload.continuationToken || null;

        const responseData = {
            lives: lives,
            continuationToken: nextToken
        };

        // 5. Deduct Credits & Cache
        req.user.credits -= costPerRequest;
        
        // Cache lives for a reasonable time (e.g., 5-15 mins) to maximize margin on popular channels
        mockRedisCache[cacheKey] = responseData;

        // 6. Return to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : errorMessage;

        // Discord Failure Alert
        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/channel/lives',
                params: { channelId, handle, continuationToken },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // Refund/don't charge the user if the request failed
        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

app.get('/v1/youtube/channel/community-posts', authMiddleware, async (req, res) => {
    const { 
        channelId, 
        handle, 
        continuationToken 
    } = req.query;

    // 1. Validation: Must have at least one identifier
    if (!channelId && !handle) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'channelId' or 'handle'"
        });
    }

    // Dynamic Pricing Logic: Base is 1 credit as per spec.
    const costPerRequest = 2;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    // Cache key explicitly flags community posts to prevent data bleed
    const identifier = channelId || handle;
    const cacheKey = `yt_community_${Buffer.from(identifier).toString('base64')}_${continuationToken || 'start'}`;

    try {
        // 1. Cache Check - Your profit margin protector
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 2. Fetch from ScrapeCreators
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/youtube/channel/community-posts');
        
        // Append dynamic params
        if (channelId) targetUrl.searchParams.append('channelId', channelId);
        if (handle) targetUrl.searchParams.append('handle', handle);
        if (continuationToken) targetUrl.searchParams.append('continuationToken', continuationToken);

        // 35-second timeout safeguard - Community posts can be payload-heavy with nested video/image objects
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(35000) 
        });

        const upstreamPayload = await response.json();

        // 3. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch community posts'}`);
        }

        // 4. Safely extract data
        const posts = upstreamPayload.posts || [];
        const nextToken = upstreamPayload.continuationToken || null;

        const responseData = {
            posts: posts,
            continuationToken: nextToken
        };

        // 5. Deduct Credits & Cache
        req.user.credits -= costPerRequest;
        
        // Cache community posts; they update less frequently than comments or live streams
        mockRedisCache[cacheKey] = responseData;

        // 6. Return to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : errorMessage;

        // Discord Failure Alert - essential for monitoring upstream reliability
        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/channel/community-posts',
                params: { channelId, handle, continuationToken },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // Only refund/don't charge the user if the request failed
        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

app.get('/v1/youtube/channel/shorts', authMiddleware, async (req, res) => {
    const { 
        channelId, 
        handle, 
        sort,
        continuationToken 
    } = req.query;

    // 1. Validation: Must have at least one identifier
    if (!channelId && !handle) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'channelId' or 'handle'"
        });
    }

    // Dynamic Pricing Logic: Base is 1 credit.
    const costPerRequest = 2;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    // Cache key explicitly flags shorts and sorting to prevent data bleed
    const identifier = channelId || handle;
    const cacheKey = `yt_shorts_${Buffer.from(identifier).toString('base64')}_${sort || 'newest'}_${continuationToken || 'start'}`;

    try {
        // 1. Cache Check - Your profit margin protector
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 2. Fetch from ScrapeCreators
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/youtube/channel/shorts');
        
        // Append dynamic params
        if (channelId) targetUrl.searchParams.append('channelId', channelId);
        if (handle) targetUrl.searchParams.append('handle', handle);
        if (sort) targetUrl.searchParams.append('sort', sort);
        if (continuationToken) targetUrl.searchParams.append('continuationToken', continuationToken);

        // 35-second timeout safeguard
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(35000) 
        });

        const upstreamPayload = await response.json();

        // 3. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch shorts'}`);
        }

        // 4. Safely extract data (the upstream provider returns multiple empty arrays, we only care about 'shorts')
        const shorts = upstreamPayload.shorts || [];
        const nextToken = upstreamPayload.continuationToken || null;

        const responseData = {
            shorts: shorts,
            continuationToken: nextToken
        };

        // 5. Deduct Credits & Cache
        req.user.credits -= costPerRequest;
        
        // Cache shorts; they are highly requested, maximizing margin on popular creators
        mockRedisCache[cacheKey] = responseData;

        // 6. Return to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : errorMessage;

        // Discord Failure Alert - essential for monitoring upstream reliability
        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/channel/shorts',
                params: { channelId, handle, sort, continuationToken },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // Only refund/don't charge the user if the request failed
        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

const { Innertube } = require('youtubei.js');

// Initialize globally so it boots once when your server starts
let ytClient;
(async () => {
    try {
        ytClient = await Innertube.create();
        console.log("YouTube scraper initialized for video endpoint");
    } catch (error) {
        console.error("Failed to initialize YouTube scraper", error);
    }
})();

// Helper to extract the 11-character video ID from any YouTube or Shorts URL
function extractVideoId(url) {
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|shorts\/)([^"&?\/\s]{11})/);
    return match ? match[1] : null;
}

app.get('/v1/youtube/video', authMiddleware, async (req, res) => {
    const { url, language, cache_max_age } = req.query;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'url'"
        });
    }

    // Your pricing logic - 100% profit now!
    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    try {
        // 1. Build the Upstream Request URL
        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/youtube/video');
        upstreamUrl.searchParams.append('url', url);
        
        if (language) {
            upstreamUrl.searchParams.append('language', language);
        }
        
        // Let ScrapeCreators handle the cache (defaults to 7 days to save your upstream credits)
        upstreamUrl.searchParams.append('cache_max_age', cache_max_age || '7d');

        // 2. Fetch from ScrapeCreators
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': process.env.SCRAPE_CREATORS_API_KEY,
                'Accept': 'application/json'
            }
        });

        const data = await response.json();

        // 3. Handle Upstream Errors (e.g. Age-Restricted 403s or Invalid URLs)
        if (!response.ok || !data.success) {
            const errorMessage = data.error || data.reason || "Upstream extraction failed.";
            const statusCode = response.status === 200 ? 500 : response.status; // Fallback to 500 if success is false but status was 200
            
            throw new Error(`${statusCode} API Error: ${errorMessage}`);
        }

        // 4. Deduct User Credits
        req.user.credits -= costPerRequest;
        // await req.user.save(); // Don't forget to save the user's new credit balance to your DB!

        // 5. Return the beautiful payload to the user
        return res.status(200).json({
            ...data, // Spread the rich ScrapeCreators data first
            success: true,
            // SECURITY OVERRIDE: Prevent leaking your master ScrapeCreators credit balance!
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest
        });

    } catch (error) {
        const errorMessage = error.message || "500 Internal Server Error";
        
        // Extract status code from the custom error string if it exists, default to 500
        const statusCodeMatch = errorMessage.match(/^(\d{3})/);
        const statusCode = statusCodeMatch ? parseInt(statusCodeMatch[1], 10) : 500;

        // Discord Failure Alert
        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/video',
                params: { url, language },
                statusCode: statusCode,
                errorMsg: errorMessage
            });
        }

        return res.status(statusCode).json({
            success: false,
            error: errorMessage
        });
    }
});

app.get('/v1/youtube/transcript', authMiddleware, async (req, res) => {
    const { 
        url, 
        language, 
        cache_max_age 
    } = req.query;

    // 1. Validation
    if (!url) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'url'"
        });
    }

    // Dynamic Pricing Logic: Premium endpoint, charging 2 credits for a 2x markup.
    const costPerRequest = 2;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. Transcripts require ${costPerRequest} credits.`
        });
    }

    // Cache key includes language so we don't serve an English transcript to a Spanish request
    const cacheKey = `yt_transcript_${Buffer.from(url).toString('base64')}_${language || 'default'}`;

    try {
        // 1. Local Cache Check - Serves instantly at 100% margin (0 cost to you)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 2. Fetch from ScrapeCreators
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/youtube/video/transcript');
        targetUrl.searchParams.append('url', url);
        
        if (language) targetUrl.searchParams.append('language', language);
        if (cache_max_age) targetUrl.searchParams.append('cache_max_age', cache_max_age);

        // 35-second timeout safeguard (transcripts can be heavy for 3-hour podcasts)
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(35000) 
        });

        const upstreamPayload = await response.json();

        // 3. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            // Check for the specific case where a video simply has no captions
            const errorMsg = upstreamPayload.error || response.statusText;
            const statusCode = response.status;
            
            if (statusCode === 404 || errorMsg.toLowerCase().includes('not available')) {
                 throw new Error("404 Not Found: No transcript or captions available for this video.");
            }

            throw new Error(`Upstream API Error: ${errorMsg || 'Failed to fetch transcript'}`);
        }

        // 4. Extract data and sanitize upstream billing fields
        const responseData = { ...upstreamPayload };
        delete responseData.success;
        delete responseData.credits_remaining;
        delete responseData.credits_charged;

        // 5. Deduct Credits & Cache locally
        req.user.credits -= costPerRequest;
        
        // Transcripts never change once published, so you can cache these for a very long time
        mockRedisCache[cacheKey] = responseData;

        // 6. Return to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = errorMessage.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : errorMessage;

        // Discord Failure Alert
        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/transcript',
                params: { url, language, cache_max_age },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

app.get('/v1/youtube/search', authMiddleware, async (req, res) => {
    const { 
        query, 
        uploadDate, 
        sortBy, 
        type, 
        duration, 
        region,
        continuationToken,
        includeExtras
    } = req.query;

    // 1. Validation
    if (!query) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'query'"
        });
    }

    // Dynamic Pricing Logic: Base is 1 credit.
    const costPerRequest = 2;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    // Cache key explicitly incorporates all filters to prevent data bleed between different query states
    const cacheKeyParts = [
        'yt_search',
        Buffer.from(query).toString('base64'),
        uploadDate || 'any',
        sortBy || 'relevance',
        type || 'all',
        duration || 'any',
        region || 'global',
        includeExtras || 'false',
        continuationToken || 'start'
    ];
    const cacheKey = cacheKeyParts.join('_');

    try {
        // 1. Cache Check - Secures 100% margin on trending/duplicate searches
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 2. Fetch from ScrapeCreators
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/youtube/search');
        targetUrl.searchParams.append('query', query);
        
        // Append optional dynamic params safely
        if (uploadDate) targetUrl.searchParams.append('uploadDate', uploadDate);
        if (sortBy) targetUrl.searchParams.append('sortBy', sortBy);
        if (type) targetUrl.searchParams.append('type', type);
        if (duration) targetUrl.searchParams.append('duration', duration);
        if (region) targetUrl.searchParams.append('region', region);
        if (continuationToken) targetUrl.searchParams.append('continuationToken', continuationToken);
        if (includeExtras === 'true') targetUrl.searchParams.append('includeExtras', 'true');

        // 35-second timeout safeguard (includeExtras significantly slows down upstream resolution)
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(35000) 
        });

        const upstreamPayload = await response.json();

        // 3. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch search results'}`);
        }

        // 4. Safely extract all possible media types returned by the payload
        const responseData = {
            videos: upstreamPayload.videos || [],
            channels: upstreamPayload.channels || [],
            playlists: upstreamPayload.playlists || [],
            shorts: upstreamPayload.shorts || [],
            shelves: upstreamPayload.shelves || [],
            lives: upstreamPayload.lives || [],
            continuationToken: upstreamPayload.continuationToken || null
        };

        // 5. Deduct Credits & Cache
        req.user.credits -= costPerRequest;
        
        // Cache lifetime can be tuned based on query velocity. Trending searches cache well.
        mockRedisCache[cacheKey] = responseData;

        // 6. Return to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        let finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : errorMessage;

        if (isTimeout && includeExtras === 'true') {
            finalErrorMsg += " Note: The 'includeExtras' flag requires additional scraping and increases latency.";
        }

        // Discord Failure Alert - essential for monitoring upstream reliability and timeout frequency
        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/search',
                params: { query, uploadDate, sortBy, type, duration, region, includeExtras, continuationToken },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // Only refund/don't charge the user if the request failed
        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

app.get('/v1/youtube/video/comments', authMiddleware, async (req, res) => {
    const { 
        url, 
        continuationToken, 
        order 
    } = req.query;

    // 1. Validation
    if (!url) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'url'"
        });
    }

    // Dynamic Pricing Logic: Base is 1 credit.
    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    // Cache key explicitly flags URL, sorting order, and pagination token to prevent data bleed
    const cacheKey = `yt_comments_${Buffer.from(url).toString('base64')}_${order || 'top'}_${continuationToken || 'start'}`;

    try {
        // 1. Cache Check - Your profit margin protector on trending videos
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 2. Fetch from ScrapeCreators
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/youtube/video/comments');
        targetUrl.searchParams.append('url', url);
        
        // Append dynamic pagination and sorting params
        if (continuationToken) targetUrl.searchParams.append('continuationToken', continuationToken);
        if (order) targetUrl.searchParams.append('order', order);

        // 35-second timeout safeguard - comment parsing can be heavy
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(35000) 
        });

        const upstreamPayload = await response.json();

        // 3. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            // Watch out for 403s on videos where the creator has disabled comments entirely
            if (response.status === 403 || (upstreamPayload.error && upstreamPayload.error.toLowerCase().includes('disabled'))) {
                throw new Error("403 Forbidden: Comments are disabled for this video.");
            }
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch comments'}`);
        }

        // 4. Safely extract comments and the next pagination token
        const responseData = {
            comments: upstreamPayload.comments || [],
            continuationToken: upstreamPayload.continuationToken || null
        };

        // 5. Deduct Credits & Cache
        req.user.credits -= costPerRequest;
        
        // Cache lifetime should be short (e.g. 5-10 mins) since comments update rapidly
        mockRedisCache[cacheKey] = responseData;

        // 6. Return to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        
        const isTimeout = error.name === 'TimeoutError';
        
        // Ensure 403s for disabled comments bubble up cleanly to the user
        const statusCode = errorMessage.includes('403') ? 403 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : errorMessage;

        // Discord Failure Alert - crucial for monitoring this endpoint
        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/video/comments',
                params: { url, order, continuationToken },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // Only refund/don't charge the user if the request failed
        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

app.get('/v1/google/search', authMiddleware, async (req, res) => {
    const { 
        query, 
        region, 
        date_posted, 
        page 
    } = req.query;

    // 1. Validation
    if (!query) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'query'"
        });
    }

    // Intercept invalid page requests before they hit the upstream provider
    const pageNum = parseInt(page || 1, 10);
    if (pageNum < 1 || pageNum > 11) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Page number must be between 1 and 11."
        });
    }

    // Dynamic Pricing Logic: Base is 1 credit.
    const costPerRequest = 2;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    // Cache key explicitly incorporates all filters
    const cacheKey = `google_search_${Buffer.from(query).toString('base64')}_${region || 'global'}_${date_posted || 'any'}_${pageNum}`;

    try {
        // 1. Cache Check - Google results cache extremely well for high-volume keywords
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 2. Fetch from ScrapeCreators
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/google/search');
        targetUrl.searchParams.append('query', query);
        
        // Append optional dynamic params
        if (region) targetUrl.searchParams.append('region', region);
        if (date_posted) targetUrl.searchParams.append('date_posted', date_posted);
        if (page) targetUrl.searchParams.append('page', page);

        // 25-second timeout safeguard (Google search via APIs is typically faster than social media)
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const upstreamPayload = await response.json();

        // 3. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch search results'}`);
        }

        // 4. Safely extract results and sanitize upstream billing data
        const responseData = {
            results: upstreamPayload.results || []
        };

        // 5. Deduct Credits & Cache
        req.user.credits -= costPerRequest;
        
        // Cache lifetime can be longer for generic searches, protecting your margin
        mockRedisCache[cacheKey] = responseData;

        // 6. Return to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : errorMessage;

        // Discord Failure Alert - monitors Google API health
        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/google/search',
                params: { query, region, date_posted, page },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // Only refund/don't charge the user if the request failed
        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});


app.get('/v1/tiktok/search/keyword', authMiddleware, async (req, res) => {
    const { query, date_posted, sort_by, region, cursor, trim } = req.query;

    // 1. Validation
    if (!query || query.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'query'." 
        });
    }

    // 2. Pre-flight Credit Check (Flat 1 Credit)
    const costPerRequest = 1;
    if (req.user.credits < costPerRequest) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credit.` 
        });
    }

    // 3. Cache Key Construction
    const identifier = encodeURIComponent(query.toLowerCase().trim());
    const safeCursor = cursor || '0';
    const safeDate = date_posted || 'all';
    const safeSort = sort_by || 'relevance';
    const cacheKey = `tiktok_search_keyword_${identifier}_${safeDate}_${safeSort}_${safeCursor}`;

    try {
        // 4. Cache Check - Return identical paginated searches for free
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/search/keyword');
        targetUrl.searchParams.append('query', query.trim());
        
        if (date_posted) targetUrl.searchParams.append('date_posted', date_posted);
        if (sort_by) targetUrl.searchParams.append('sort_by', sort_by);
        if (region) targetUrl.searchParams.append('region', region);
        if (cursor) targetUrl.searchParams.append('cursor', cursor);
        if (trim) targetUrl.searchParams.append('trim', trim);

        // 6. Execute Request
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const upstreamPayload = await response.json();

        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to search keyword'}`);
        }

        // 7. Data Trimming & Extraction
        // Strip out the massive TikTok internal JSON payload and keep only the essentials.
        const rawVideoList = Array.isArray(upstreamPayload.search_item_list) ? upstreamPayload.search_item_list : [];
        
        const trimmedVideos = rawVideoList.map(item => {
            const video = item.aweme_info || {};
            const stats = video.statistics || {};
            const author = video.author || {};
            const vidDetails = video.video || {};

            return {
                id: video.id_str || video.id || "",
                desc: video.desc || "",
                create_time: video.create_time || 0,
                url: `https://www.tiktok.com/@${author.unique_id}/video/${video.id_str}`,
                author: {
                    uid: author.uid || "",
                    handle: author.unique_id || "",
                    nickname: author.nickname || "",
                    avatar_url: author.avatar_medium?.url_list?.[0] || author.avatar_thumb?.url_list?.[0] || ""
                },
                stats: {
                    views: stats.play_count || 0,
                    likes: stats.digg_count || 0,
                    comments: stats.comment_count || 0,
                    shares: stats.share_count || 0,
                    saves: stats.collect_count || 0
                },
                video_data: {
                    duration: vidDetails.duration || 0,
                    cover_url: vidDetails.cover?.url_list?.[0] || "",
                    play_url: vidDetails.download_addr?.url_list?.[0] || vidDetails.play_addr?.url_list?.[0] || ""
                }
            };
        });

        const responseData = {
            cursor: upstreamPayload.cursor ?? null,
            has_more: !!upstreamPayload.has_more,
            videos: trimmedVideos
        };

        // 8. Strict Flat-Rate Billing & Caching
        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = responseData;

        // 9. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : error.message;
        
        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/search/keyword', 
                params: { query, cursor }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/tiktok/search/users', authMiddleware, async (req, res) => {
    const { query, cursor, trim } = req.query;

    // 1. Validation
    if (!query || query.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'query'." 
        });
    }

    // 2. Pre-flight Credit Check (Strictly 1 Credit)
    const costPerRequest = 1;
    if (req.user.credits < costPerRequest) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credit.` 
        });
    }

    // 3. Cache Key Construction
    const identifier = encodeURIComponent(query.toLowerCase().trim());
    const safeCursor = cursor || '0';
    const safeTrim = trim === 'true' ? 'true' : 'false';
    const cacheKey = `tiktok_search_users_${identifier}_${safeCursor}_${safeTrim}`;

    try {
        // 4. Cache Check
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/search/users');
        targetUrl.searchParams.append('query', query.trim());
        
        if (cursor) targetUrl.searchParams.append('cursor', cursor);
        if (trim) targetUrl.searchParams.append('trim', trim);

        // 6. Execute Request
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const upstreamPayload = await response.json();

        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to search users'}`);
        }

        // 7. Data Trimming & Extraction
        // Strip out the 500 lines of TikTok internal junk and keep only the gold.
        const rawUserList = Array.isArray(upstreamPayload.user_list) ? upstreamPayload.user_list : [];
        
        const trimmedUsers = rawUserList.map(item => {
            const u = item.user_info || {};
            return {
                uid: u.uid || "",
                sec_uid: u.sec_uid || "",
                handle: u.unique_id || "",
                nickname: u.nickname || "",
                bio: u.signature || "",
                follower_count: u.follower_count || 0,
                following_count: u.following_count || 0,
                video_count: u.aweme_count || 0,
                total_likes: u.total_favorited || 0,
                is_verified: !!u.custom_verify || !!u.enterprise_verify_reason,
                is_private: !!u.is_private_account,
                avatar_url: u.avatar_medium?.url_list?.[0] || u.avatar_thumb?.url_list?.[0] || ""
            };
        });

        const responseData = {
            cursor: upstreamPayload.cursor ?? null,
            has_more: !!upstreamPayload.has_more,
            users: trimmedUsers
        };

        // 8. Strict Flat-Rate Billing & Caching
        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = responseData;

        // 9. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : error.message;
        
        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/search/users', 
                params: { query, cursor }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/tiktok/user/followers', authMiddleware, async (req, res) => {
    const { handle, user_id, min_time, trim } = req.query;

    // 1. Validation
    if (!handle && !user_id) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'handle' or 'user_id'." 
        });
    }

    // 2. Pre-flight Credit Check
    // We expect the upstream cost to be 1, so we require the user to have at least 2 credits.
    const minimumRequiredCredits = 2;
    if (req.user.credits < minimumRequiredCredits) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${minimumRequiredCredits} credits.` 
        });
    }

    // 3. Cache Key Construction
    const identifier = handle ? handle.replace('@', '').toLowerCase().trim() : `uid_${user_id}`;
    const safeMinTime = min_time || '0';
    const safeTrim = trim === 'true' ? 'true' : 'false';
    const cacheKey = `tiktok_followers_${identifier}_${safeMinTime}_${safeTrim}`;

    try {
        // 4. Cache Check - 100% margin on repeat paginated queries (0 cost to you, 0 cost to them)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/user/followers');
        
        if (handle) targetUrl.searchParams.append('handle', identifier);
        if (user_id) targetUrl.searchParams.append('user_id', user_id);
        if (min_time) targetUrl.searchParams.append('min_time', min_time);
        if (trim) targetUrl.searchParams.append('trim', trim);

        // 6. Execute Request
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch follower list'}`);
        }

        // 8. Sanitize Payload Structure
        const responseData = {
            has_more: upstreamPayload.has_more || false,
            min_time: upstreamPayload.min_time || 0,
            max_time: upstreamPayload.max_time || 0,
            total: upstreamPayload.total || 0,
            next_page_token: upstreamPayload.next_page_token || null,
            followers: upstreamPayload.followers || []
        };

        // 9. Margin Logic: Charge exactly double the upstream cost
        const upstreamCost = upstreamPayload.credits_charged || 1;
        const finalCostToUser = upstreamCost * 2;

        req.user.credits -= finalCostToUser;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: finalCostToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message === 'TimeoutError';
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : error.message;
        
        // Background Alerting
        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/user/followers', 
                params: { handle: identifier, user_id, min_time }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/tiktok/user/following', authMiddleware, async (req, res) => {
    const { handle, min_time, trim } = req.query;

    // 1. Validation
    if (!handle) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'handle'." 
        });
    }

    // 2. Pre-flight Credit Check
    // We expect the upstream cost to be 1, so we require the user to have at least 2 credits.
    const minimumRequiredCredits = 2;
    if (req.user.credits < minimumRequiredCredits) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${minimumRequiredCredits} credits.` 
        });
    }

    // 3. Cache Key Construction
    const identifier = handle.replace('@', '').toLowerCase().trim();
    const safeMinTime = min_time || '0';
    const safeTrim = trim === 'true' ? 'true' : 'false';
    const cacheKey = `tiktok_following_${identifier}_${safeMinTime}_${safeTrim}`;

    try {
        // 4. Cache Check - 100% margin on repeat paginated queries (0 cost to you, 0 cost to them)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/user/following');
        targetUrl.searchParams.append('handle', identifier);
        
        if (min_time) targetUrl.searchParams.append('min_time', min_time);
        if (trim) targetUrl.searchParams.append('trim', trim);

        // 6. Execute Request
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch following list'}`);
        }

        // 8. Sanitize Payload Structure
        const responseData = {
            has_more: upstreamPayload.has_more || false,
            min_time: upstreamPayload.min_time || 0,
            max_time: upstreamPayload.max_time || 0,
            total: upstreamPayload.total || 0,
            next_page_token: upstreamPayload.next_page_token || null,
            followings: upstreamPayload.followings || []
        };

        // 9. Margin Logic: Charge exactly double the upstream cost
        const upstreamCost = upstreamPayload.credits_charged || 1;
        const finalCostToUser = upstreamCost * 2;

        req.user.credits -= finalCostToUser;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: finalCostToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message === 'TimeoutError';
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : error.message;
        
        // Background Alerting
        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/user/following', 
                params: { handle: identifier, min_time }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/tiktok/video/comments', authMiddleware, async (req, res) => {
    const { url, cursor, trim } = req.query;

    // 1. Validation
    if (!url) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    // 2. Pre-flight Credit Check (1 credit)
    const costPerRequest = 2;
    if (req.user.credits < costPerRequest) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credit.` 
        });
    }

    // 3. Cache Key Construction
    // The cursor is critical here so we don't serve Page 1 data to a Page 2 request.
    const safeCursor = cursor || '0';
    const safeTrim = trim === 'true' ? 'true' : 'false';
    const cacheKey = `tiktok_comments_${Buffer.from(url).toString('base64')}_${safeCursor}_${safeTrim}`;

    try {
        // 4. Cache Check - 100% margin on repeat paginated queries
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/video/comments');
        targetUrl.searchParams.append('url', url);
        
        if (cursor) targetUrl.searchParams.append('cursor', cursor);
        if (trim) targetUrl.searchParams.append('trim', trim);

        // 6. Execute Request
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch comments'}`);
        }

        // 8. Sanitize Payload Structure
        // Extracting only the necessary pagination logic and comments array
        const responseData = {
            has_more: upstreamPayload.has_more,
            cursor: upstreamPayload.cursor,
            total: upstreamPayload.total || 0,
            comments: upstreamPayload.comments || []
        };

        // 9. Deduct Credits & Cache locally
        const actualCost = costPerRequest;
        req.user.credits -= actualCost;
        
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message === 'TimeoutError';
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : error.message;
        
        // Background Alerting
        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/video/comments', 
                params: { url, cursor }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/tiktok/user/live', authMiddleware, async (req, res) => {
    const { handle } = req.query;

    // 1. Validation
    if (!handle) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'handle'." 
        });
    }

    // 2. Pre-flight Credit Check (1 credit)
    const costPerRequest = 1;
    if (req.user.credits < costPerRequest) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credit.` 
        });
    }

    // 3. Cache Key Construction
    const identifier = handle.replace('@', '').toLowerCase().trim();
    const cacheKey = `tiktok_live_${identifier}`;

    try {
        // 4. Cache Check - Free (0 credits charged) on repeat hits
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0,
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/user/live');
        targetUrl.searchParams.append('handle', identifier);

        // 6. Execute Request with a 20-second timeout
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000)
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch live stream details'}`);
        }

        // 8. Sanitize Payload Structure
        const responseData = {
            liveRoomUserInfo: upstreamPayload.liveRoomUserInfo || null,
            liveRoom: upstreamPayload.liveRoom || null
        };

        // 9. Deduct Credits & Cache locally
        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message === 'TimeoutError';
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/user/live', 
                params: { handle: identifier }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/tiktok/video/transcript', authMiddleware, async (req, res) => {
    const { url, language, use_ai_as_fallback } = req.query;

    // 1. Validation
    if (!url) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    // 2. Pre-flight Credit Check
    const maxPotentialCost = use_ai_as_fallback === 'true' ? 15 : 2;
    if (req.user.credits < maxPotentialCost) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires up to ${maxPotentialCost} credits.` 
        });
    }

    // 3. Cache Key Construction
    const safeLang = language || 'default';
    const safeAiFallback = use_ai_as_fallback === 'true' ? 'true' : 'false';
    const cacheKey = `tiktok_transcript_${Buffer.from(url).toString('base64')}_${safeLang}_${safeAiFallback}`;

    try {
        // 4. Cache Check - Return instantly for 0 credits on cache hit
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0,
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/video/transcript');
        targetUrl.searchParams.append('url', url);
        if (language) targetUrl.searchParams.append('language', language);
        if (use_ai_as_fallback) targetUrl.searchParams.append('use_ai_as_fallback', use_ai_as_fallback);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000)
        });

        const upstreamPayload = await response.json();

        // 6. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch transcript'}`);
        }

        // 7. Sanitize & Structure Payload
        const responseData = {
            id: upstreamPayload.id || null,
            url: upstreamPayload.url || url,
            transcript: upstreamPayload.transcript || ""
        };

        // 8. Dynamic Credit Deduction & Local Caching
        // FIX: We now use the actual credits charged by the upstream payload, or fallback to your maxPotentialCost
        const actualCost = upstreamPayload.credits_charged || maxPotentialCost; 
        req.user.credits -= actualCost;

        mockRedisCache[cacheKey] = responseData;

        // 9. Return Response to Client
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message === 'TimeoutError';
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/video/transcript', 
                params: { url, language }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/tiktok/video', authMiddleware, async (req, res) => {
    const { url, get_transcript, region, trim, download_media, cache_max_age } = req.query;

    // 1. Validation
    if (!url) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    // 2. Pre-flight Credit Check
    // download_media costs 10 credits upstream if successful, otherwise standard requests are 1 credit.
    const maxPotentialCost = download_media === 'true' ? 10 : 1;
    if (req.user.credits < maxPotentialCost) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires up to ${maxPotentialCost} credits.` 
        });
    }

    // 3. Cache Key Construction
    const safeTrim = trim === 'true' ? 'true' : 'false';
    const safeTranscript = get_transcript === 'true' ? 'true' : 'false';
    const safeDownload = download_media === 'true' ? 'true' : 'false';
    const cacheKey = `tiktok_vid_${Buffer.from(url).toString('base64')}_${safeTrim}_${safeTranscript}_${safeDownload}`;

    try {
        // 4. Cache Check (100% margin on repeat requests)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v2/tiktok/video');
        targetUrl.searchParams.append('url', url);
        
        if (get_transcript) targetUrl.searchParams.append('get_transcript', get_transcript);
        if (region) targetUrl.searchParams.append('region', region);
        if (trim) targetUrl.searchParams.append('trim', trim);
        if (download_media) targetUrl.searchParams.append('download_media', download_media);
        if (cache_max_age) targetUrl.searchParams.append('cache_max_age', cache_max_age);

        // Fast timeout since the upstream API handles single videos quickly
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const upstreamPayload = await response.json();

        // 6. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch video data'}`);
        }

        // 7. Extract data and sanitize
        const responseData = {
            status_code: upstreamPayload.status_code,
            status_msg: upstreamPayload.status_msg,
            aweme_detail: upstreamPayload.aweme_detail || null,
            transcript: upstreamPayload.transcript || null,
            cached: upstreamPayload.cached || false,
            cached_at: upstreamPayload.cached_at || null
        };

        // 8. Dynamic Credit Deduction
        // We pass the exact cost (1 or 10) from the upstream provider down to the user
        const actualCost = upstreamPayload.credits_charged || 1;
        req.user.credits -= actualCost;
        
        mockRedisCache[cacheKey] = responseData;

        // 9. Return to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message === 'TimeoutError';
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long." : error.message;
        
        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/video', 
                params: { url }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/tiktok/profile/videos', authMiddleware, async (req, res) => {
    const { handle, user_id, sort_by, max_cursor, region, trim } = req.query;

    // 1. Validation
    if (!handle && !user_id) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'handle' or 'user_id'." 
        });
    }

    // Dynamic Pricing Logic: 1 credit
    const costPerRequest = 2;
    if (req.user.credits < costPerRequest) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.` 
        });
    }

    // 2. Cache Key Construction
    const identifier = handle ? handle.replace('@', '').toLowerCase() : user_id;
    const safeCursor = max_cursor || '0';
    const safeSort = sort_by || 'latest';
    const safeTrim = trim === 'true' ? 'true' : 'false';
    const cacheKey = `tiktok_videos_${identifier}_${safeSort}_${safeCursor}_${safeTrim}`;

    try {
        // 3. Cache Check - You still capture 100% margin on repeat trending requests
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 4. Delegate entirely to ScrapeCreators v3
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v3/tiktok/profile/videos');
        
        if (handle) targetUrl.searchParams.append('handle', identifier);
        if (user_id) targetUrl.searchParams.append('user_id', user_id);
        if (sort_by) targetUrl.searchParams.append('sort_by', sort_by);
        if (max_cursor) targetUrl.searchParams.append('max_cursor', max_cursor);
        if (region) targetUrl.searchParams.append('region', region);
        if (trim) targetUrl.searchParams.append('trim', trim);

        // Keep the timeout snappy for a great user experience
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const upstreamPayload = await response.json();

        // 5. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch profile videos'}`);
        }

        // 6. Extract data safely to prevent exposing upstream metadata
        const responseData = {
            has_more: upstreamPayload.has_more,
            max_cursor: upstreamPayload.max_cursor,
            min_cursor: upstreamPayload.min_cursor,
            status_code: upstreamPayload.status_code,
            status_msg: upstreamPayload.status_msg,
            aweme_list: upstreamPayload.aweme_list || []
        };

        // 7. Deduct Credits & Cache locally
        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = responseData;

        // 8. Return to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message === 'TimeoutError';
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : error.message;
        
        // Background Alerting
        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/profile/videos', 
                params: { identifier, max_cursor }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/tiktok/profile/region', authMiddleware, async (req, res) => {
    const { handle } = req.query;

    // 1. Validation
    if (!handle) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'handle'."
        });
    }

    // Dynamic Pricing Logic: 1 credit
    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    const cleanHandle = handle.startsWith('@') ? handle.substring(1) : handle;
    const cacheKey = `tiktok_region_${cleanHandle.toLowerCase()}`;

    try {
        // 1. Cache Check - Region rarely changes, so you still capture 100% margin on repeat requests
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 2. Delegate to ScrapeCreators
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/profile/region');
        targetUrl.searchParams.append('handle', cleanHandle);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const upstreamPayload = await response.json();

        // 3. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch region'}`);
        }

        // 4. Extract data and sanitize
        const responseData = {
            handle: upstreamPayload.handle,
            profile_url: upstreamPayload.profile_url,
            region: upstreamPayload.region
        };

        // 5. Deduct Credits & Cache locally
        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = responseData;

        // 6. Return to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : errorMessage;

        // Discord Failure Alert
        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/tiktok/profile/region',
                params: { handle },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

app.get('/v1/tiktok/profile', authMiddleware, async (req, res) => {
    const { 
        handle, 
        user_id, 
        cache_max_age 
    } = req.query;

    // 1. Validation - Allow EITHER handle OR user_id based on ScrapeCreators specs
    if (!handle && !user_id) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter. You must provide either 'handle' or 'user_id'."
        });
    }

    // 2. Billing Check
    const costPerRequest = 1;
    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    // 3. Construct Upstream URL & Parameters
    const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/profile');
    
    if (handle) {
        // Strip '@' if the user accidentally included it
        const cleanHandle = handle.startsWith('@') ? handle.substring(1) : handle;
        targetUrl.searchParams.append('handle', cleanHandle);
    }
    
    if (user_id) {
        targetUrl.searchParams.append('user_id', user_id);
    }

    // Allow cache options like '1d', '3d', '7d' as specified by ScrapeCreators
    if (cache_max_age) {
        targetUrl.searchParams.append('cache_max_age', cache_max_age);
    }

    // Best Practice: Setup an AbortController so hanging upstream requests don't lock up your server
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // 20-second hard timeout

    try {
        // 4. Call ScrapeCreators API
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': process.env.SCRAPE_CREATORS_API_KEY, // Store in your .env file
                'Content-Type': 'application/json'
            },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        let data;
        try {
            data = await response.json();
        } catch (parseError) {
            throw new Error(`Upstream returned invalid JSON. Status: ${response.status}`);
        }

        // Handle upstream API failures (e.g., 404 Not Found, 403 Invalid API Key)
        if (!response.ok || !data.success) {
            const upStreamError = data.error || data.message || `Upstream error: ${response.statusText}`;
            throw new Error(`[${response.status}] ${upStreamError}`);
        }

        // 5. Deduct Credits
        // Note: You can also choose to read `data.credits_charged` from ScrapeCreators
        // if you want to mirror their 0-credit cached response logic to your users.
        req.user.credits -= costPerRequest;
        
        // Save the updated user credits to your database here if applicable
        // await req.user.save();

        // 6. Return Payload to Your User
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            user: data.user,
            stats: data.stats,
            cached: data.cached || false,
            cached_at: data.cached_at || null
        });

    } catch (error) {
        clearTimeout(timeoutId);
        
        const isTimeout = error.name === 'AbortError';
        const isNotFound = error.message.includes('[404]');
        
        const statusCode = isNotFound ? 404 : (isTimeout ? 504 : 500);
        let finalErrorMsg = error.message || "Internal Server Error";

        if (isTimeout) {
            finalErrorMsg = "504 Gateway Timeout: Upstream scraping service took too long to respond.";
        } else if (isNotFound) {
            finalErrorMsg = "404 Not Found: The requested TikTok profile does not exist or is banned.";
        }

        // 7. Discord Failure Alert (Tracks upstream health/outages)
        if (typeof notifyFailure === 'function' && !isNotFound) { // Ignore 404s to reduce spam
            notifyFailure({
                endpoint: '/v1/tiktok/profile',
                params: { handle, user_id },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

app.get('/v1/tiktok/collection/videos', authMiddleware, async (req, res) => {
    const { url, cursor } = req.query;

    // 1. Validation
    if (!url) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'url'."
        });
    }

    // Dynamic Pricing Logic: Base is 1 credit.
    const costPerRequest = 2;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    // Cache key explicitly flags URL and the pagination cursor to prevent data bleed
    const cacheKey = `tiktok_collection_${Buffer.from(url).toString('base64')}_${cursor || 'start'}`;

    try {
        // 1. Cache Check - Secures 100% margin on trending/duplicate requests
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 2. Fetch from ScrapeCreators
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/collection/videos');
        targetUrl.searchParams.append('url', url);
        if (cursor) targetUrl.searchParams.append('cursor', cursor);

        // 35-second timeout safeguard - grabbing deeply paginated video arrays can be heavy
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(35000) 
        });

        const upstreamPayload = await response.json();

        // 3. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch collection videos'}`);
        }

        // 4. Safely extract results and sanitize upstream billing data
        const responseData = {
            collection_id: upstreamPayload.collection_id,
            has_more: upstreamPayload.has_more,
            max_cursor: upstreamPayload.max_cursor,
            status_code: upstreamPayload.status_code,
            status_msg: upstreamPayload.status_msg,
            videos: upstreamPayload.videos || []
        };

        // 5. Deduct Credits & Cache locally
        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = responseData;

        // 6. Return to Consumer
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: Upstream provider took too long to respond." : errorMessage;

        // Discord Failure Alert - essential for monitoring upstream pagination health
        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/tiktok/collection/videos',
                params: { url, cursor },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // Only refund/don't charge the user if the request failed
        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

app.get('/v1/linkedin/profile', authMiddleware, async (req, res) => {
    const { url, handle } = req.query;

    // 1. Handle & URL Normalization
    let targetLinkedInUrl = url || handle;

    if (!targetLinkedInUrl || typeof targetLinkedInUrl !== 'string' || targetLinkedInUrl.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url' or 'handle'." 
        });
    }

    targetLinkedInUrl = targetLinkedInUrl.trim();

    // Auto-convert standalone handles or "in/username" formats to full URLs
    if (!targetLinkedInUrl.startsWith('http://') && !targetLinkedInUrl.startsWith('https://')) {
        const cleanHandle = targetLinkedInUrl.replace(/^@/, '').replace(/^in\//, '').replace(/\/$/, '');
        targetLinkedInUrl = `https://www.linkedin.com/in/${cleanHandle}`;
    }

    // Clean trailing slashes for consistent caching
    try {
        const parsedUrl = new URL(targetLinkedInUrl);
        targetLinkedInUrl = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/$/, '')}`;
    } catch (e) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Invalid LinkedIn URL or handle provided." 
        });
    }

    // 2. Pre-flight Credit Check (Charges 2 Credits to double upstream cost)
    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    // 3. Cache Key Construction
    const cacheKey = `linkedin_profile_${Buffer.from(targetLinkedInUrl).toString('base64')}`;

    try {
        // 4. Cache Check (100% margin on repeat requests)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/linkedin/profile');
        targetUrl.searchParams.append('url', targetLinkedInUrl);

        // 6. Execute Request (25s timeout for LinkedIn page loads)
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch LinkedIn profile'}`);
        }

        // 8. Trim & Sanitize Payload
        // Strips out obscured text, redacted experience descriptions, and useless metadata
        const trimmedProfile = {
            name: upstreamPayload.name || null,
            image: upstreamPayload.image || null,
            location: upstreamPayload.location || null,
            followers: upstreamPayload.followers || 0,
            connections: upstreamPayload.connections || null,
            about: upstreamPayload.about || null,
            url: targetLinkedInUrl,
            recentPosts: Array.isArray(upstreamPayload.recentPosts) 
                ? upstreamPayload.recentPosts.map(post => ({
                    title: post.title || "",
                    activityType: post.activityType || "",
                    link: post.link || "",
                    image: post.image || null
                })) 
                : [],
            experience: Array.isArray(upstreamPayload.experience)
                ? upstreamPayload.experience.map(exp => ({
                    company: exp.name || null,
                    url: exp.url || null,
                    location: exp.location || null
                }))
                : [],
            education: Array.isArray(upstreamPayload.education)
                ? upstreamPayload.education.map(edu => ({
                    school: edu.name || null,
                    url: edu.url || null,
                    startYear: edu.member?.startDate || null,
                    endYear: edu.member?.endDate || null
                }))
                : [],
            articles: Array.isArray(upstreamPayload.articles)
                ? upstreamPayload.articles.map(art => ({
                    headline: art.headline || "",
                    datePublished: art.datePublished || null,
                    image: art.image || null,
                    body: art.articleBody || ""
                }))
                : [],
            recommendations: Array.isArray(upstreamPayload.recommendations)
                ? upstreamPayload.recommendations.map(rec => ({
                    name: rec.name || "",
                    link: rec.link || "",
                    text: rec.text || ""
                }))
                : [],
            similarProfiles: Array.isArray(upstreamPayload.similarProfiles)
                ? upstreamPayload.similarProfiles.map(sim => ({
                    name: sim.name || "",
                    link: sim.link || "",
                    image: sim.image || null
                }))
                : []
        };

        // 9. Billing Deduction & Local Caching
        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = trimmedProfile;

        // 10. Return Sanitized Payload
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...trimmedProfile
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        
        // If LinkedIn throws a 404, it usually means the profile doesn't exist or is completely private
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch the profile." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/linkedin/profile', 
                params: { targetLinkedInUrl }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/linkedin/company', authMiddleware, async (req, res) => {
    const { url, handle } = req.query;

    // 1. Handle & URL Normalization
    let targetCompanyUrl = url || handle;

    if (!targetCompanyUrl || typeof targetCompanyUrl !== 'string' || targetCompanyUrl.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url' or 'handle'." 
        });
    }

    targetCompanyUrl = targetCompanyUrl.trim();

    // Auto-convert standalone handles or "company/name" formats to full URLs
    if (!targetCompanyUrl.startsWith('http://') && !targetCompanyUrl.startsWith('https://')) {
        const cleanHandle = targetCompanyUrl.replace(/^@/, '').replace(/^company\//, '').replace(/\/$/, '');
        targetCompanyUrl = `https://www.linkedin.com/company/${cleanHandle}`;
    }

    // Clean trailing slashes for consistent caching
    try {
        const parsedUrl = new URL(targetCompanyUrl);
        targetCompanyUrl = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/$/, '')}`;
    } catch (e) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Invalid LinkedIn company URL or handle provided." 
        });
    }

    // 2. Pre-flight Credit Check (Charges 2 Credits)
    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    // 3. Cache Key Construction
    const cacheKey = `linkedin_company_${Buffer.from(targetCompanyUrl).toString('base64')}`;

    try {
        // 4. Cache Check (Free on repeat requests)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/linkedin/company');
        targetUrl.searchParams.append('url', targetCompanyUrl);

        // 6. Execute Request (25s timeout for LinkedIn page loads)
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch LinkedIn company page'}`);
        }

        // 8. Trim & Sanitize Payload
        const trimmedCompany = {
            id: upstreamPayload.id || null,
            name: upstreamPayload.name || "",
            slogan: upstreamPayload.slogan || null,
            description: upstreamPayload.description || "",
            website: upstreamPayload.website || null,
            logo: upstreamPayload.logo || null,
            cover_image: upstreamPayload.coverImage || null,
            industry: upstreamPayload.industry || null,
            size: upstreamPayload.size || null,
            employee_count: upstreamPayload.employeeCount || 0,
            founded: upstreamPayload.founded || null,
            headquarters: upstreamPayload.headquarters || null,
            type: upstreamPayload.type || null,
            location: upstreamPayload.location ? {
                city: upstreamPayload.location.city || "",
                state: upstreamPayload.location.state || "",
                country: upstreamPayload.location.country || ""
            } : null,
            specialties: Array.isArray(upstreamPayload.specialties) ? upstreamPayload.specialties : [],
            funding: upstreamPayload.funding ? {
                number_of_rounds: upstreamPayload.funding.numberOfRounds || 0,
                last_round: upstreamPayload.funding.lastRound ? {
                    type: upstreamPayload.funding.lastRound.type || "",
                    date: upstreamPayload.funding.lastRound.date || null,
                    amount: upstreamPayload.funding.lastRound.amount || ""
                } : null,
                investors: Array.isArray(upstreamPayload.funding.investors)
                    ? upstreamPayload.funding.investors.map(inv => ({
                        name: inv.name || "",
                        crunchbase_url: inv.crunchbaseUrl || "",
                        image: inv.image || null
                    }))
                    : []
            } : null,
            employees: Array.isArray(upstreamPayload.employees)
                ? upstreamPayload.employees.map(emp => ({
                    name: emp.name || "",
                    title: emp.title || "",
                    link: emp.link || "",
                    image: emp.image || null
                }))
                : [],
            posts: Array.isArray(upstreamPayload.posts)
                ? upstreamPayload.posts.map(post => ({
                    url: post.url || "",
                    date_published: post.datePublished || null,
                    text: post.text || ""
                }))
                : [],
            similar_pages: Array.isArray(upstreamPayload.similarPages)
                ? upstreamPayload.similarPages.map(page => ({
                    name: page.name || "",
                    link: page.link || "",
                    image: page.image || null
                }))
                : []
        };

        // 9. Billing Deduction & Local Caching
        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = trimmedCompany;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...trimmedCompany
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch company details." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/linkedin/company', 
                params: { targetCompanyUrl }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/linkedin/company/posts', authMiddleware, async (req, res) => {
    const { url, handle, page } = req.query;

    // 1. Handle & URL Normalization
    let targetCompanyUrl = url || handle;

    if (!targetCompanyUrl || typeof targetCompanyUrl !== 'string' || targetCompanyUrl.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url' or 'handle'." 
        });
    }

    targetCompanyUrl = targetCompanyUrl.trim();

    // Auto-convert standalone handles to full URLs
    if (!targetCompanyUrl.startsWith('http://') && !targetCompanyUrl.startsWith('https://')) {
        const cleanHandle = targetCompanyUrl.replace(/^@/, '').replace(/^company\//, '').replace(/\/$/, '');
        targetCompanyUrl = `https://www.linkedin.com/company/${cleanHandle}`;
    }

    // Clean trailing slashes for consistent caching
    try {
        const parsedUrl = new URL(targetCompanyUrl);
        targetCompanyUrl = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/$/, '')}`;
    } catch (e) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Invalid LinkedIn company URL or handle provided." 
        });
    }

    // Validate Page Pagination (LinkedIn max is 7)
    const pageNum = parseInt(page, 10) || 1;
    if (pageNum < 1 || pageNum > 7) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: 'page' parameter must be between 1 and 7 due to LinkedIn's public pagination limits."
        });
    }

    // 2. Pre-flight Credit Check (Charges 3 Credits as requested)
    const costToUser = 3;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    // 3. Cache Key Construction
    const cacheKey = `linkedin_company_posts_${Buffer.from(targetCompanyUrl).toString('base64')}_${pageNum}`;

    try {
        // 4. Cache Check (Free 100% margin on repeat paginated queries)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment configuration");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/linkedin/company/posts');
        targetUrl.searchParams.append('url', targetCompanyUrl);
        if (page) targetUrl.searchParams.append('page', pageNum.toString());

        // 6. Execute Request (25s timeout for LinkedIn's heavy scroll rendering)
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch LinkedIn company posts'}`);
        }

        // 8. Trim & Sanitize Payload
        const trimmedPosts = Array.isArray(upstreamPayload.posts) 
            ? upstreamPayload.posts.map(post => ({
                id: post.id || "",
                url: post.url || "",
                date_published: post.datePublished || null,
                text: post.text || ""
            }))
            : [];

        const responseData = {
            page: pageNum,
            total_posts_returned: trimmedPosts.length,
            posts: trimmedPosts
        };

        // 9. Billing Deduction & Local Caching
        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        
        // 404 usually means the page doesn't exist or is completely private
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch company posts." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/linkedin/company/posts', 
                params: { targetCompanyUrl, page: pageNum }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/linkedin/search/posts', authMiddleware, async (req, res) => {
    const { query, date_posted, cursor, trim } = req.query;

    // 1. Parameter Validation
    if (!query || typeof query !== 'string' || query.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'query'." 
        });
    }

    // Preemptively block cursors >= 12 to save upstream API calls and bandwidth
    if (cursor && parseInt(cursor, 10) >= 12) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Maximum pagination limit reached. LinkedIn only allows up to cursor 11 for public search."
        });
    }

    // 2. Pre-flight Credit Check (Charges 3 Credits for a 3x Markup)
    const costToUser = 3;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    // 3. Cache Key Construction
    const identifier = encodeURIComponent(query.toLowerCase().trim());
    const safeDate = date_posted || 'all-time';
    const safeCursor = cursor || '0';
    const safeTrim = trim === 'true' ? 'true' : 'false';
    const cacheKey = `linkedin_search_posts_${identifier}_${safeDate}_${safeCursor}_${safeTrim}`;

    try {
        // 4. Cache Check (Free 100% margin on repeat requests)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/linkedin/search/posts');
        targetUrl.searchParams.append('query', query.trim());
        
        if (date_posted) targetUrl.searchParams.append('date_posted', date_posted);
        if (cursor) targetUrl.searchParams.append('cursor', cursor);
        if (trim) targetUrl.searchParams.append('trim', trim);

        // 6. Execute Request (25s timeout for Google index + LinkedIn scrape)
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to search LinkedIn posts'}`
            );
        }

        // 8. Trim & Sanitize Payload
        // Enforce a strict, clean schema so users only get useful data
        const trimmedPosts = Array.isArray(upstreamPayload.posts) 
            ? upstreamPayload.posts.map(post => ({
                url: post.url || "",
                date_published: post.datePublished || null,
                text: post.description || post.text || "", 
                media_url: post.image || post.media || null,
                images: Array.isArray(post.images) ? post.images : [],
                author: post.author ? {
                    name: post.author.name || "",
                    url: post.author.url || "",
                    image: post.author.image || null,
                    followers: post.author.followers || 0
                } : null,
                stats: {
                    likes: post.likeCount || 0,
                    comments: post.commentCount || 0
                },
                sample_comments: Array.isArray(post.comments) ? post.comments.map(c => ({
                    author: c.author || "",
                    text: c.text || "",
                    linkedin_url: c.linkedinUrl || ""
                })) : []
            }))
            : [];

        const responseData = {
            query: upstreamPayload.query || query,
            cursor: upstreamPayload.cursor ?? null,
            has_more: !!upstreamPayload.cursor && parseInt(upstreamPayload.cursor, 10) < 11,
            posts: trimmedPosts
        };

        // 9. Billing Deduction & Local Caching
        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch search results." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/linkedin/search/posts', 
                params: { query, cursor }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/linkedin/post', authMiddleware, async (req, res) => {
    const { url } = req.query;

    // 1. Parameter Validation
    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    // 2. URL Normalization
    let targetPostUrl = url.trim();
    try {
        // Strip tracking parameters (e.g., ?utm_source=...) so cache hits are perfectly accurate
        const parsedUrl = new URL(targetPostUrl);
        targetPostUrl = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/$/, '')}`;
    } catch (e) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Invalid LinkedIn URL provided." 
        });
    }

    // 3. Pre-flight Credit Check (Strictly 1 Credit)
    const costPerRequest = 1;
    if (req.user.credits < costPerRequest) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credit.` 
        });
    }

    // 4. Cache Key Construction
    const cacheKey = `linkedin_post_${Buffer.from(targetPostUrl).toString('base64')}`;

    try {
        // 5. Cache Check (Free on repeat lookups)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 6. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment configuration");

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/linkedin/post');
        upstreamUrl.searchParams.append('url', targetPostUrl);

        // 7. Execute Request (20s timeout)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const upstreamPayload = await response.json();

        // 8. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch LinkedIn post'}`
            );
        }

        // 9. Trim & Sanitize Payload
        // Standardizes the schema so your developers always get clean, predictable keys
        const trimmedPost = {
            url: upstreamPayload.url || targetPostUrl,
            title: upstreamPayload.name || "",
            headline: upstreamPayload.headline || "",
            text: upstreamPayload.description || "",
            date_published: upstreamPayload.datePublished || null,
            author: upstreamPayload.author ? {
                name: upstreamPayload.author.name || "",
                url: upstreamPayload.author.url || "",
                followers: upstreamPayload.author.followers || 0
            } : null,
            stats: {
                likes: upstreamPayload.likeCount || 0,
                comments: upstreamPayload.commentCount || 0
            },
            comments: Array.isArray(upstreamPayload.comments) 
                ? upstreamPayload.comments.map(c => ({
                    author: c.author || "",
                    text: c.text || "",
                    url: c.linkedinUrl || ""
                })) 
                : [],
            more_articles: Array.isArray(upstreamPayload.moreArticles) 
                ? upstreamPayload.moreArticles.map(a => ({
                    title: a.title || "",
                    url: a.link || "",
                    date_published: a.datePublished || "",
                    description: a.description || "",
                    stats: {
                        likes: a.reactionCount || 0,
                        comments: a.commentCount || 0
                    }
                })) 
                : []
        };

        // 10. Strict Flat-Rate Billing & Caching
        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = trimmedPost;

        // 11. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...trimmedPost
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch post." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/linkedin/post', 
                params: { url: targetPostUrl }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

const { scrapeFacebookProfileNative,scrapeFacebookPostNative } = require('./src/scrapers/facebook.js');

app.get('/v1/facebook/group', authMiddleware, async (req, res) => {
    const { url, group_id } = req.query;

    // 1. Input Validation
    if (!url && !group_id) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. Provide either 'url' or 'group_id'." 
        });
    }

    // 2. Pre-flight Credit Check (Charges 1 credit / $1 as requested)
    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    // 3. Request Normalization & Cache Key Construction
    const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/group');
    let cacheIdentifier = '';

    if (group_id) {
        upstreamUrl.searchParams.append('group_id', group_id.trim());
        cacheIdentifier = `id_${group_id.trim()}`;
    } else {
        const cleanUrl = url.trim().split('?')[0]; // Strip tracking params
        upstreamUrl.searchParams.append('url', cleanUrl);
        cacheIdentifier = `url_${Buffer.from(cleanUrl).toString('base64')}`;
    }

    const cacheKey = `fb_group_${cacheIdentifier}`;

    try {
        // 4. Local Cache Check 
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        // 6. Execute Request (25s timeout)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch Facebook group details'}`
            );
        }

        // 8. Trim & Sanitize Payload
        // Normalizing the object structure to ensure a safe, predictable schema
        const responseData = {
            id: upstreamPayload.id || null,
            url: upstreamPayload.url || url || null,
            name: upstreamPayload.name || "",
            description: upstreamPayload.description || "",
            privacy: upstreamPayload.privacy ? {
                label: upstreamPayload.privacy.label || "",
                description: upstreamPayload.privacy.description || ""
            } : null,
            visibility: upstreamPayload.visibility ? {
                label: upstreamPayload.visibility.label || "",
                description: upstreamPayload.visibility.description || ""
            } : null,
            categories: Array.isArray(upstreamPayload.categories) 
                ? upstreamPayload.categories.map(c => ({ id: c.id, name: c.name })) 
                : [],
            created_at: upstreamPayload.created_at || null,
            history_summary: upstreamPayload.history_summary || "",
            stats: {
                member_count: upstreamPayload.member_count || 0,
                member_count_text: upstreamPayload.member_count_text || "",
                administrator_count: upstreamPayload.administrator_count || 0,
                moderator_count: upstreamPayload.moderator_count || 0
            },
            activity: upstreamPayload.activity ? {
                posts_last_day: upstreamPayload.activity.posts_last_day || 0,
                posts_last_month: upstreamPayload.activity.posts_last_month || 0,
                new_members_text: upstreamPayload.activity.new_members_text || ""
            } : null,
            staff: {
                administrators: Array.isArray(upstreamPayload.administrators) ? upstreamPayload.administrators.map(admin => ({
                    id: admin.id || "",
                    name: admin.name || "",
                    url: admin.url || "",
                    profile_picture_url: admin.profile_picture_url || null
                })) : [],
                moderators: Array.isArray(upstreamPayload.moderators) ? upstreamPayload.moderators.map(mod => ({
                    id: mod.id || "",
                    name: mod.name || "",
                    url: mod.url || "",
                    profile_picture_url: mod.profile_picture_url || null
                })) : []
            },
            rules: Array.isArray(upstreamPayload.rules) ? upstreamPayload.rules.map(rule => ({
                id: rule.id || "",
                title: rule.title || "",
                description: rule.description || ""
            })) : [],
            about_info: Array.isArray(upstreamPayload.about_info) ? upstreamPayload.about_info.map(info => ({
                type: info.type || "",
                label: info.label || "",
                description: info.description || ""
            })) : []
        };

        // 9. Billing Deduction & Local Caching
        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch group info." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/group', 
                params: { group_id, url }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/facebook/group/posts', authMiddleware, async (req, res) => {
    const { url, group_id, sort_by, cursor } = req.query;

    // 1. Input Validation
    if (!url && !group_id) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. Provide either 'url' or 'group_id'." 
        });
    }

    // 2. Pre-flight Credit Check (Charges 2 Credits for 50% margin)
    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    // 3. Request Normalization & Cache Key Construction
    const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/group/posts');
    let cacheIdentifier = '';

    if (group_id) {
        upstreamUrl.searchParams.append('group_id', group_id.trim());
        cacheIdentifier = `id_${group_id.trim()}`;
    } else {
        const cleanUrl = url.trim().split('?')[0]; // Strip tracking params
        upstreamUrl.searchParams.append('url', cleanUrl);
        cacheIdentifier = `url_${Buffer.from(cleanUrl).toString('base64')}`;
    }

    const safeSortBy = sort_by ? sort_by.trim().toUpperCase() : 'CHRONOLOGICAL';
    if (sort_by) upstreamUrl.searchParams.append('sort_by', safeSortBy);
    
    if (cursor) upstreamUrl.searchParams.append('cursor', cursor);

    const safeCursor = cursor ? Buffer.from(cursor).toString('base64').substring(0, 15) : '0';
    const cacheKey = `fb_group_posts_${cacheIdentifier}_${safeSortBy}_${safeCursor}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat paginated queries)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        // 6. Execute Request (30s timeout for heavy group post fetching)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(30000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch Facebook group posts'}`
            );
        }

        // 8. Trim & Sanitize Payload
        // Standardizes the post schema and removes internal __typename fields
        const trimmedPosts = Array.isArray(upstreamPayload.posts) 
            ? upstreamPayload.posts.map(post => ({
                id: post.id || "",
                text: post.text || null,
                url: post.url || "",
                permalink: post.permalink || "",
                publish_time: post.publishTime || null,
                stats: {
                    reactions: post.reactionCount || 0,
                    comments: post.commentCount || 0,
                    video_views: post.videoViewCount || null
                },
                author: post.author ? {
                    id: post.author.id || "",
                    name: post.author.name || post.author.short_name || ""
                } : null,
                video_details: post.videoDetails ? {
                    sd_url: post.videoDetails.sdUrl || null,
                    hd_url: post.videoDetails.hdUrl || null,
                    thumbnail_url: post.videoDetails.thumbnailUrl || null
                } : null,
                top_comments: Array.isArray(post.topComments) ? post.topComments.map(c => ({
                    id: c.id || "",
                    text: c.text || "",
                    publish_time: c.publishTime || null,
                    author: c.author ? {
                        id: c.author.id || "",
                        name: c.author.name || "",
                        gender: c.author.gender || "UNKNOWN",
                        url: c.author.url || null
                    } : null
                })) : []
            }))
            : [];

        const responseData = {
            target: group_id ? { group_id: group_id.trim() } : { url: upstreamUrl.searchParams.get('url') },
            sort_by: safeSortBy,
            cursor: upstreamPayload.cursor || null,
            has_more: !!upstreamPayload.cursor,
            total_returned: trimmedPosts.length,
            posts: trimmedPosts
        };

        // 9. Billing Deduction & Local Caching
        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch group posts." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/group/posts', 
                params: { group_id, url, sort_by, cursor }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/facebook/post/comments', authMiddleware, async (req, res) => {
    const { url, feedback_id, cursor } = req.query;

    // 1. Input Validation
    if (!url && !feedback_id) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. You must provide either 'url' or 'feedback_id'." 
        });
    }

    // 2. Pre-flight Credit Check (Charges 2 Credits to maintain 50% margin)
    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    // 3. Request Normalization & Cache Key Construction
    const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/post/comments');
    let cacheIdentifier = '';

    if (feedback_id) {
        upstreamUrl.searchParams.append('feedback_id', feedback_id.trim());
        cacheIdentifier = `fbid_${feedback_id.trim()}`;
    } else {
        let cleanUrl = url.trim().split('?')[0]; // Strip tracking params
        upstreamUrl.searchParams.append('url', cleanUrl);
        cacheIdentifier = `url_${Buffer.from(cleanUrl).toString('base64')}`;
    }

    if (cursor) upstreamUrl.searchParams.append('cursor', cursor);
    
    const safeCursor = cursor ? Buffer.from(cursor).toString('base64').substring(0, 15) : '0';
    const cacheKey = `fb_comments_${cacheIdentifier}_${safeCursor}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat paginated queries)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        // 6. Execute Request (25s timeout)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch Facebook comments'}`
            );
        }

        // 8. Trim & Sanitize Payload
        // Ensures your users get a predictable, clean schema
        const trimmedComments = Array.isArray(upstreamPayload.comments) 
            ? upstreamPayload.comments.map(comment => ({
                id: comment.id || "",
                text: comment.text || "",
                created_at: comment.created_at || null,
                stats: {
                    replies: comment.reply_count || 0,
                    total_reactions: comment.reaction_count || 0,
                    reactions_breakdown: comment.reactions || {
                        like: 0, love: 0, haha: 0, wow: 0, sad: 0, anger: 0
                    }
                },
                author: comment.author ? {
                    id: comment.author.id || "",
                    name: comment.author.name || "",
                    short_name: comment.author.short_name || "",
                    gender: comment.author.gender || "UNKNOWN"
                } : null
            }))
            : [];

        const responseData = {
            target: feedback_id ? { feedback_id: feedback_id.trim() } : { url: upstreamUrl.searchParams.get('url') },
            cursor: upstreamPayload.cursor || null,
            has_more: !!upstreamPayload.has_next_page,
            total_returned: trimmedComments.length,
            comments: trimmedComments
        };

        // 9. Billing Deduction & Local Caching
        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch comments." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/post/comments', 
                params: { url, feedback_id, cursor }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/facebook/post', authMiddleware, async (req, res) => {
    const { url, cache_max_age } = req.query;

    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    const cleanUrl = url.trim().split('?')[0];

    // Charge 2 credits to maintain a 50% profit margin
    const baseCostToUser = 1;
    if (req.user.credits < baseCostToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires up to ${baseCostToUser} credits.` 
        });
    }

    const safeMaxAge = cache_max_age || '0';
    const cacheKey = `fb_post_sc_${Buffer.from(cleanUrl).toString('base64')}_${safeMaxAge}`;

    try {
        // Local Cache Check
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/post');
        upstreamUrl.searchParams.append('url', cleanUrl);
        if (cache_max_age) upstreamUrl.searchParams.append('cache_max_age', cache_max_age);

        // Execute Request (25s timeout)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const upstreamPayload = await response.json();

        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch Facebook post'}`
            );
        }

        // Sanitize Payload
        const responseData = {
            post_id: upstreamPayload.post_id || null,
            url: upstreamPayload.url || cleanUrl,
            description: upstreamPayload.description || "",
            creation_time: upstreamPayload.creation_time || null,
            stats: {
                likes: upstreamPayload.like_count || 0,
                comments: upstreamPayload.comment_count || 0,
                shares: upstreamPayload.share_count || 0,
                views: upstreamPayload.view_count || 0
            },
            author: upstreamPayload.author ? {
                id: upstreamPayload.author.id || "",
                name: upstreamPayload.author.name || "",
                url: upstreamPayload.author.url || "",
                image: upstreamPayload.author.image || null,
                is_verified: !!upstreamPayload.author.is_verified
            } : null,
            media: {
                image_url: upstreamPayload.image_url || null,
                video: upstreamPayload.video ? {
                    id: upstreamPayload.video.id || "",
                    sd_url: upstreamPayload.video.sd_url || null,
                    hd_url: upstreamPayload.video.hd_url || null,
                    thumbnail: upstreamPayload.video.thumbnail || null,
                    duration_sec: upstreamPayload.video.length_in_second || 0
                } : null
            },
            music: upstreamPayload.music ? {
                id: upstreamPayload.music.id || "",
                title: upstreamPayload.music.track_title || ""
            } : null,
            cached: upstreamPayload.cached || false,
            cached_at: upstreamPayload.cached_at || null
        };

        // Dynamic Billing Deduction
        const actualCost = upstreamPayload.credits_charged === 0 ? 0 : baseCostToUser;
        req.user.credits -= actualCost;
        
        mockRedisCache[cacheKey] = responseData;

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch post." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/post', 
                params: { url: cleanUrl }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/facebook/profile/reels', authMiddleware, async (req, res) => {
    const { url, handle, next_page_id, cursor } = req.query;

    // 1. Parameter Normalization
    const input = handle || url;
    if (!input || typeof input !== 'string' || input.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url' or 'handle'." 
        });
    }

    let cleanInput = input.trim().replace(/^@/, '');
    let targetPageUrl;

    if (cleanInput.includes('facebook.com/')) {
        const pathPart = cleanInput.split('facebook.com/')[1].split('/')[0].split('?')[0];
        targetPageUrl = `https://www.facebook.com/${pathPart}`;
    } else if (cleanInput.startsWith('http://') || cleanInput.startsWith('https://')) {
        targetPageUrl = cleanInput;
    } else {
        targetPageUrl = `https://www.facebook.com/${cleanInput.replace(/\/$/, '')}`;
    }

    // Clean trailing slashes for consistent caching
    try {
        const parsedUrl = new URL(targetPageUrl);
        targetPageUrl = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/$/, '')}`;
    } catch (e) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Invalid Facebook URL or handle provided." 
        });
    }

    // 2. Pre-flight Credit Check (Charges 2 Credits to double upstream cost)
    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    // 3. Cache Key Construction
    const safeCursor = cursor ? Buffer.from(cursor).toString('base64').substring(0, 15) : '0';
    const safePageId = next_page_id ? Buffer.from(next_page_id).toString('base64').substring(0, 15) : '0';
    const cacheKey = `fb_reels_sc_${Buffer.from(targetPageUrl).toString('base64')}_${safeCursor}_${safePageId}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat requests)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/profile/reels');
        upstreamUrl.searchParams.append('url', targetPageUrl);
        
        if (next_page_id) upstreamUrl.searchParams.append('next_page_id', next_page_id);
        if (cursor) upstreamUrl.searchParams.append('cursor', cursor);

        // 6. Execute Request (25s timeout for video feed loads)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch Facebook reels'}`
            );
        }

        // 8. Trim & Sanitize Payload
        const trimmedReels = Array.isArray(upstreamPayload.reels) 
            ? upstreamPayload.reels.map(reel => ({
                id: reel.id || "",
                post_id: reel.post_id || "",
                video_id: reel.video_id || "",
                url: reel.url || "",
                description: reel.description || "",
                creation_time: reel.creation_time || null,
                stats: {
                    views: reel.view_count || 0,
                    duration_ms: reel.play_time_in_ms || 0
                },
                media: {
                    thumbnail: reel.thumbnail || null,
                    video_url: reel.video_url || null
                },
                feedback_id: reel.feedback_id || null,
                music: reel.music ? {
                    id: reel.music.id || "",
                    track_title: reel.music.track_title || ""
                } : null,
                author: reel.author ? {
                    id: reel.author.id || "",
                    name: reel.author.name || "",
                    url: reel.author.url || "",
                    image: reel.author.image || null,
                    is_verified: !!reel.author.is_verified
                } : null
            }))
            : [];

        const responseData = {
            url: targetPageUrl,
            cursor: upstreamPayload.cursor || null,
            next_page_id: upstreamPayload.next_page_id || null,
            has_more: !!(upstreamPayload.cursor && upstreamPayload.next_page_id),
            total_returned: trimmedReels.length,
            reels: trimmedReels
        };

        // 9. Billing Deduction & Local Caching
        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Sanitized Payload
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch reels." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/profile/reels', 
                params: { targetPageUrl, cursor, next_page_id }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/facebook/profile/photos', authMiddleware, async (req, res) => {
    const { url, handle, next_page_id, cursor } = req.query;

    // 1. Parameter Normalization (Accept either url or handle)
    const input = handle || url;
    if (!input || typeof input !== 'string' || input.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url' or 'handle'." 
        });
    }

    let cleanInput = input.trim().replace(/^@/, '');
    let targetPageUrl;

    if (cleanInput.includes('facebook.com/')) {
        const pathPart = cleanInput.split('facebook.com/')[1].split('/')[0].split('?')[0];
        targetPageUrl = `https://www.facebook.com/${pathPart}`;
    } else if (cleanInput.startsWith('http://') || cleanInput.startsWith('https://')) {
        targetPageUrl = cleanInput;
    } else {
        targetPageUrl = `https://www.facebook.com/${cleanInput.replace(/\/$/, '')}`;
    }

    // Clean trailing slashes for consistent caching keys
    try {
        const parsedUrl = new URL(targetPageUrl);
        targetPageUrl = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/$/, '')}`;
    } catch (e) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Invalid Facebook URL or handle provided." 
        });
    }

    // 2. Pre-flight Credit Check (Charges 2 Credits to maintain 50% margin)
    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    // 3. Cache Key Construction
    const safeCursor = cursor ? Buffer.from(cursor).toString('base64').substring(0, 15) : '0';
    const safePageId = next_page_id ? Buffer.from(next_page_id).toString('base64').substring(0, 15) : '0';
    const cacheKey = `fb_photos_${Buffer.from(targetPageUrl).toString('base64')}_${safeCursor}_${safePageId}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat paginated queries)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/profile/photos');
        upstreamUrl.searchParams.append('url', targetPageUrl);
        
        if (next_page_id) upstreamUrl.searchParams.append('next_page_id', next_page_id);
        if (cursor) upstreamUrl.searchParams.append('cursor', cursor);

        // 6. Execute Request (25s timeout for heavy image catalog fetching)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch Facebook page photos'}`
            );
        }

        // 8. Trim & Sanitize Payload
        // Strips out empty encodings, null CIX screens, and reorganizes image structures
        const trimmedPhotos = Array.isArray(upstreamPayload.photos) 
            ? upstreamPayload.photos.map(photo => ({
                id: photo.photo_id || photo.id || "",
                url: photo.url || "",
                caption: photo.accessibility_caption || null,
                thumbnail: photo.thumbnail || null,
                high_res_image: photo.viewer_image?.uri || null,
                dimensions: photo.viewer_image ? {
                    width: photo.viewer_image.width || null,
                    height: photo.viewer_image.height || null
                } : null
            }))
            : [];

        const responseData = {
            url: targetPageUrl,
            cursor: upstreamPayload.cursor || null,
            next_page_id: upstreamPayload.next_page_id || null,
            has_more: !!(upstreamPayload.cursor && upstreamPayload.next_page_id),
            total_returned: trimmedPhotos.length,
            photos: trimmedPhotos
        };

        // 9. Billing Deduction & Local Caching
        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch photos." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/profile/photos', 
                params: { targetPageUrl, cursor, next_page_id }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/facebook/profile/posts', authMiddleware, async (req, res) => {
    const { url, handle, pageId, cursor } = req.query;

    // 1. Input Validation
    if (!url && !handle && !pageId) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. Provide either 'url', 'handle', or 'pageId'." 
        });
    }

    // 2. Pre-flight Credit Check (Charges 2 Credits to maintain 50% margin)
    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    // 3. Request Normalization & Cache Key Construction
    const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/profile/posts');
    let cacheIdentifier = '';

    if (pageId) {
        upstreamUrl.searchParams.append('pageId', pageId.trim());
        cacheIdentifier = `id_${pageId.trim()}`;
    } else {
        const input = handle || url;
        let cleanInput = input.trim().replace(/^@/, '');
        let targetPageUrl;

        if (cleanInput.includes('facebook.com/')) {
            const pathPart = cleanInput.split('facebook.com/')[1].split('/')[0].split('?')[0];
            targetPageUrl = `https://www.facebook.com/${pathPart}`;
        } else if (cleanInput.startsWith('http://') || cleanInput.startsWith('https://')) {
            targetPageUrl = cleanInput;
        } else {
            targetPageUrl = `https://www.facebook.com/${cleanInput.replace(/\/$/, '')}`;
        }

        // Clean trailing slashes
        try {
            const parsedUrl = new URL(targetPageUrl);
            targetPageUrl = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/$/, '')}`;
        } catch (e) {
            return res.status(400).json({ 
                success: false, 
                error: "400 Bad Request: Invalid Facebook URL or handle provided." 
            });
        }
        
        upstreamUrl.searchParams.append('url', targetPageUrl);
        cacheIdentifier = `url_${Buffer.from(targetPageUrl).toString('base64')}`;
    }

    if (cursor) upstreamUrl.searchParams.append('cursor', cursor);
    const safeCursor = cursor ? Buffer.from(cursor).toString('base64').substring(0, 15) : '0';
    const cacheKey = `fb_posts_${cacheIdentifier}_${safeCursor}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat paginated queries)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        // 6. Execute Request (30s timeout for heavy video/post fetching)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(30000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch Facebook posts'}`
            );
        }

        // 8. Trim & Sanitize Payload
        // Ensures consistent schema and removes null/internal tags
        const trimmedPosts = Array.isArray(upstreamPayload.posts) 
            ? upstreamPayload.posts.map(post => ({
                id: post.id || "",
                text: post.text || "",
                url: post.url || "",
                permalink: post.permalink || "",
                publish_time: post.publishTime || null,
                stats: {
                    reactions: post.reactionCount || 0,
                    comments: post.commentCount || 0,
                    video_views: post.videoViewCount || 0
                },
                author: post.author ? {
                    id: post.author.id || "",
                    name: post.author.name || post.author.short_name || ""
                } : null,
                video_details: post.videoDetails ? {
                    sd_url: post.videoDetails.sdUrl || null,
                    hd_url: post.videoDetails.hdUrl || null,
                    thumbnail_url: post.videoDetails.thumbnailUrl || null
                } : null,
                top_comments: Array.isArray(post.topComments) ? post.topComments.map(c => ({
                    id: c.id || "",
                    text: c.text || "",
                    publish_time: c.publishTime || null,
                    author: c.author ? {
                        id: c.author.id || "",
                        name: c.author.name || "",
                        url: c.author.url || null
                    } : null
                })) : []
            }))
            : [];

        const responseData = {
            target: pageId ? { page_id: pageId } : { url: upstreamUrl.searchParams.get('url') },
            cursor: upstreamPayload.cursor || null,
            has_more: !!upstreamPayload.cursor,
            total_returned: trimmedPosts.length,
            posts: trimmedPosts
        };

        // 9. Billing Deduction & Local Caching
        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch posts." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/profile/posts', 
                params: { pageId, url, handle, cursor }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/facebook/profile/events', authMiddleware, async (req, res) => {
    const { url, handle, cursor } = req.query;

    // 1. Parameter Normalization
    const input = handle || url;
    if (!input || typeof input !== 'string' || input.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url' or 'handle'." 
        });
    }

    let cleanInput = input.trim().replace(/^@/, '');
    let targetPageUrl;

    if (cleanInput.includes('facebook.com/')) {
        const pathPart = cleanInput.split('facebook.com/')[1].split('/')[0].split('?')[0];
        targetPageUrl = `https://www.facebook.com/${pathPart}`;
    } else if (cleanInput.startsWith('http://') || cleanInput.startsWith('https://')) {
        targetPageUrl = cleanInput;
    } else {
        targetPageUrl = `https://www.facebook.com/${cleanInput.replace(/\/$/, '')}`;
    }

    // Clean trailing slashes for consistent caching
    try {
        const parsedUrl = new URL(targetPageUrl);
        targetPageUrl = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/$/, '')}`;
    } catch (e) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Invalid Facebook URL or handle provided." 
        });
    }

    // 2. Pre-flight Credit Check (Charges 2 Credits to double upstream cost)
    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    // 3. Cache Key Construction
    const safeCursor = cursor ? Buffer.from(cursor).toString('base64').substring(0, 15) : '0';
    const cacheKey = `fb_events_${Buffer.from(targetPageUrl).toString('base64')}_${safeCursor}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat requests)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/profile/events');
        upstreamUrl.searchParams.append('url', targetPageUrl);
        
        if (cursor) upstreamUrl.searchParams.append('cursor', cursor);

        // 6. Execute Request (25s timeout)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch Facebook page events'}`
            );
        }

        // 8. Trim & Sanitize Payload
        // Removes GraphQL metadata (`__typename`, `__isEntity`) for a clean developer experience
        const trimmedEvents = Array.isArray(upstreamPayload.events) 
            ? upstreamPayload.events.map(event => ({
                id: event.id || "",
                name: event.name || "",
                url: event.url || "",
                timing: {
                    day_time_sentence: event.day_time_sentence || "",
                    start_timestamp: event.start_timestamp || null,
                    is_past: !!event.is_past,
                    is_happening_now: !!event.is_happening_now
                },
                status: {
                    is_canceled: !!event.is_canceled,
                    is_online: !!event.is_online_or_detected_online,
                    event_kind: event.event_kind || "UNKNOWN"
                },
                creator: event.event_creator ? {
                    id: event.event_creator.id || "",
                    name: event.event_creator.name || "",
                    url: event.event_creator.url || ""
                } : null,
                place: event.event_place ? {
                    id: event.event_place.id || "",
                    name: event.event_place.contextual_name || "",
                    city: event.event_place.location?.reverse_geocode?.city || null
                } : null,
                media: {
                    cover_photo: event.gif_cover_photo || null,
                    cover_video: event.cover_video || null
                }
            }))
            : [];

        const responseData = {
            url: targetPageUrl,
            cursor: upstreamPayload.cursor || null,
            has_next_page: !!upstreamPayload.has_next_page,
            total_count: upstreamPayload.total_count || 0,
            events_returned: trimmedEvents.length,
            events: trimmedEvents
        };

        // 9. Billing Deduction & Local Caching
        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch events." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/profile/events', 
                params: { targetPageUrl, cursor }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/facebook/post/transcript', authMiddleware, async (req, res) => {
    const { url, cache_max_age } = req.query;

    // 1. Parameter Validation
    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    const targetUrl = url.trim();

    // 2. Pre-flight Credit Check (Base cost is 2 credits for live scrapes)
    const baseCostToUser = 2;
    if (req.user.credits < baseCostToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires up to ${baseCostToUser} credits.` 
        });
    }

    // 3. Cache Key Construction
    const safeMaxAge = cache_max_age || '0';
    const cacheKey = `fb_transcript_${Buffer.from(targetUrl).toString('base64')}_${safeMaxAge}`;

    try {
        // 4. Local Cache Check (100% margin on repeat requests)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/post/transcript');
        upstreamUrl.searchParams.append('url', targetUrl);
        
        if (cache_max_age) upstreamUrl.searchParams.append('cache_max_age', cache_max_age);

        // 6. Execute Request (25s timeout for video transcription rendering)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            // Note: ScrapeCreators returns a specific error if the video is > 2 minutes
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch transcript. Video may be over 2 minutes long.'}`
            );
        }

        // 8. Sanitize Payload
        const responseData = {
            url: targetUrl,
            transcript: upstreamPayload.transcript || null,
            cached: upstreamPayload.cached || false,
            cached_at: upstreamPayload.cached_at || null
        };

        // 9. Dynamic Billing Deduction
        // If upstream utilized their cache, they charged 0. We mirror that 0. 
        // Otherwise, we charge the 2-credit base cost.
        const actualCost = upstreamPayload.credits_charged === 0 ? 0 : baseCostToUser;
        
        req.user.credits -= actualCost;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to generate the transcript." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/post/transcript', 
                params: { targetUrl, cache_max_age }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/facebook/profile', authMiddleware, async (req, res) => {
    const { handle, url } = req.query;

    const input = handle || url;
    if (!input || typeof input !== 'string' || input.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'handle' or 'url'." 
        });
    }

    const costPerRequest = 1;
    if (req.user.credits < costPerRequest) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credit.` 
        });
    }

    const cleanInput = input.trim().replace(/^@/, '');
    const cacheKey = `fb_native_${Buffer.from(cleanInput).toString('base64')}`;

    try {
        // Cache Check
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // Execute Native Scraper
        const scraperResult = await scrapeFacebookProfileNative(cleanInput);

        // Deduct 1 credit & Cache
        req.user.credits -= costPerRequest;
        mockRedisCache[cacheKey] = scraperResult.data;

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...scraperResult.data
        });

    } catch (error) {
        const statusCode = error.message.includes('Timeout') ? 504 : 500;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/profile', 
                params: { input }, 
                statusCode: statusCode, 
                errorMsg: error.message 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.get('/v1/twitter/tweet/transcript', authMiddleware, async (req, res) => {
    const { url, cache_max_age } = req.query;

    // 1. Parameter Validation
    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    const cleanUrl = url.trim().split('?')[0]; // Strip tracking parameters

    // 2. Pre-flight Credit Check (Charge 2 credits to maintain 50% margin)
    const baseCostToUser = 2;
    if (req.user.credits < baseCostToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires up to ${baseCostToUser} credits.` 
        });
    }

    // 3. Cache Key Construction
    const safeMaxAge = cache_max_age || '0';
    const cacheKey = `tw_transcript_sc_${Buffer.from(cleanUrl).toString('base64')}_${safeMaxAge}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat queries)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/twitter/tweet/transcript');
        upstreamUrl.searchParams.append('url', cleanUrl);
        if (cache_max_age) upstreamUrl.searchParams.append('cache_max_age', cache_max_age);

        // 6. Execute Request (60s timeout - extended because AI transcription is slow)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(60000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to generate tweet transcript'}`
            );
        }

        // 8. Payload Construction
        const responseData = {
            url: cleanUrl,
            transcript: upstreamPayload.transcript || null,
            cached: upstreamPayload.cached || false,
            cached_at: upstreamPayload.cached_at || null
        };

        // 9. Dynamic Billing Deduction
        // If upstream served from cache, they charged 0. We pass that savings to the user (and charge 0). 
        // Otherwise, we charge our base cost of 2 credits.
        const actualCost = upstreamPayload.credits_charged === 0 ? 0 : baseCostToUser;
        
        req.user.credits -= actualCost;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream AI took too long to generate the transcript." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/twitter/tweet/transcript', 
                params: { url: cleanUrl, cache_max_age }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/twitter/community', authMiddleware, async (req, res) => {
    const { url } = req.query;

    // 1. Parameter Validation
    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    const cleanUrl = url.trim().split('?')[0]; // Strip tracking parameters

    // 2. Pre-flight Credit Check (Charging exactly 1 credit as requested)
    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    // 3. Cache Key Construction
    const cacheKey = `tw_community_sc_${Buffer.from(cleanUrl).toString('base64')}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat queries)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/twitter/community');
        upstreamUrl.searchParams.append('url', cleanUrl);

        // 6. Execute Request (20s timeout)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch Twitter community details'}`
            );
        }

        // 8. Payload Construction
        // We separate the billing metadata from upstream and pass through the raw GraphQL JSON.
        const { success, credits_remaining, credits_charged, ...communityData } = upstreamPayload;
        
        const responseData = {
            ...communityData
        };

        // 9. Billing Deduction & Local Caching
        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch the community." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/twitter/community', 
                params: { url: cleanUrl }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/twitter/community/tweets', authMiddleware, async (req, res) => {
    const { url } = req.query;

    // 1. Parameter Validation
    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    const cleanUrl = url.trim().split('?')[0]; // Strip tracking parameters

    // 2. Pre-flight Credit Check
    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    // 3. Cache Key Construction
    const cacheKey = `tw_community_tweets_trimmed_${Buffer.from(cleanUrl).toString('base64')}`;

    try {
        // 4. Local Cache Check
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/twitter/community/tweets');
        upstreamUrl.searchParams.append('url', cleanUrl);

        // 6. Execute Request (25s timeout for feed fetching)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch Twitter community tweets'}`
            );
        }

        // 8. Trim & Sanitize Payload
        // Strips out all the heavy GraphQL metadata and returns a clean, developer-friendly schema
        const trimmedTweets = Array.isArray(upstreamPayload.tweets) 
            ? upstreamPayload.tweets.map(tweet => ({
                id: tweet.id_str || tweet.id || "",
                text: tweet.full_text || "",
                created_at: tweet.created_at || null,
                url: `https://x.com/i/web/status/${tweet.id_str || tweet.id}`,
                lang: tweet.lang || "en",
                stats: {
                    views: parseInt(tweet.view_count || 0, 10),
                    likes: tweet.favorite_count || 0,
                    retweets: tweet.retweet_count || 0,
                    replies: tweet.reply_count || 0,
                    quotes: tweet.quote_count || 0,
                    bookmarks: tweet.bookmark_count || 0
                },
                author: tweet.user ? {
                    id: tweet.user.rest_id || "",
                    name: tweet.user.core?.name || "",
                    handle: tweet.user.core?.screen_name || "",
                    avatar: tweet.user.avatar?.image_url || null,
                    is_verified: !!tweet.user.is_blue_verified
                } : null
            }))
            : [];

        const responseData = {
            url: cleanUrl,
            total_returned: trimmedTweets.length,
            tweets: trimmedTweets
        };

        // 9. Billing Deduction & Local Caching
        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch the community tweets." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/twitter/community/tweets', 
                params: { url: cleanUrl }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});
app.get('/v1/twitter/tweet', authMiddleware, async (req, res) => {
    const { url, trim, cache_max_age } = req.query;

    // 1. Parameter Validation
    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    const cleanUrl = url.trim().split('?')[0]; // Strip tracking parameters

    // 2. Pre-flight Credit Check (Charge 2 credits to maintain 50% margin)
    const baseCostToUser = 1;
    if (req.user.credits < baseCostToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires up to ${baseCostToUser} credits.` 
        });
    }

    // 3. Cache Key Construction
    const safeTrim = trim === 'true' ? 'true' : 'false';
    const safeMaxAge = cache_max_age || '0';
    const cacheKey = `tw_tweet_sc_${Buffer.from(cleanUrl).toString('base64')}_${safeTrim}_${safeMaxAge}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat queries)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/twitter/tweet');
        upstreamUrl.searchParams.append('url', cleanUrl);
        if (trim) upstreamUrl.searchParams.append('trim', trim);
        if (cache_max_age) upstreamUrl.searchParams.append('cache_max_age', cache_max_age);

        // 6. Execute Request (20s timeout)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch tweet details'}`
            );
        }

        // 8. Payload Construction
        // We separate the billing/cache metadata and pass through the raw tweet JSON (or trimmed version)
        const { success, credits_remaining, credits_charged, cached, cached_at, ...tweetData } = upstreamPayload;
        
        const responseData = {
            cached: cached || false,
            cached_at: cached_at || null,
            ...tweetData
        };

        // 9. Dynamic Billing Deduction
        // If upstream served from cache, they charged 0. We pass that savings to the user (and charge 0). 
        // Otherwise, we charge our base cost of 2 credits.
        const actualCost = credits_charged === 0 ? 0 : baseCostToUser;
        
        req.user.credits -= actualCost;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch the tweet." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/twitter/tweet', 
                params: { url: cleanUrl, trim, cache_max_age }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/twitter/profile/tweets', authMiddleware, async (req, res) => {
    const { handle, trim } = req.query;

    // 1. Parameter Validation
    if (!handle || typeof handle !== 'string' || handle.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'handle'." 
        });
    }

    const cleanHandle = handle.trim().replace(/^@/, '').split('?')[0];

    // 2. Pre-flight Credit Check (Charge 2 credits to maintain 50% margin)
    const baseCostToUser = 2;
    if (req.user.credits < baseCostToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${baseCostToUser} credits.` 
        });
    }

    // 3. Cache Key Construction
    const safeTrim = trim === 'true' ? 'true' : 'false';
    const cacheKey = `tw_tweets_sc_${Buffer.from(cleanHandle).toString('base64')}_${safeTrim}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat queries)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/twitter/user-tweets');
        upstreamUrl.searchParams.append('handle', cleanHandle);
        if (trim) upstreamUrl.searchParams.append('trim', trim);

        // 6. Execute Request (20s timeout)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch Twitter user tweets'}`
            );
        }

        // 8. Payload Construction
        // We extract the tweets array and structure the final payload cleanly
        const responseData = {
            handle: cleanHandle,
            total_returned: Array.isArray(upstreamPayload.tweets) ? upstreamPayload.tweets.length : 0,
            tweets: upstreamPayload.tweets || []
        };

        // 9. Billing Deduction & Local Caching
        req.user.credits -= baseCostToUser;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: baseCostToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch the tweets." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/twitter/user-tweets', 
                params: { handle: cleanHandle, trim }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/twitter/profile', authMiddleware, async (req, res) => {
    const { handle, cache_max_age } = req.query;

    // 1. Parameter Validation
    if (!handle || typeof handle !== 'string' || handle.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'handle'." 
        });
    }

    const cleanHandle = handle.trim().replace(/^@/, '').split('?')[0];

    // 2. Pre-flight Credit Check (Charge 2 credits to maintain 50% margin)
    const baseCostToUser = 1;
    if (req.user.credits < baseCostToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires up to ${baseCostToUser} credits.` 
        });
    }

    // 3. Cache Key Construction
    const safeMaxAge = cache_max_age || '0';
    const cacheKey = `tw_profile_sc_${Buffer.from(cleanHandle).toString('base64')}_${safeMaxAge}`;

    try {
        // 4. Local Cache Check (100% margin on repeat requests)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/twitter/profile');
        upstreamUrl.searchParams.append('handle', cleanHandle);
        if (cache_max_age) upstreamUrl.searchParams.append('cache_max_age', cache_max_age);

        // 6. Execute Request (20s timeout)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch Twitter profile'}`
            );
        }

        // 8. Payload Construction
        // ScrapeCreators returns the raw GraphQL JSON object from X.
        // We extract the base meta fields and spread the rest of the raw GraphQL data.
        const { success, credits_remaining, credits_charged, cached, cached_at, ...twitterData } = upstreamPayload;
        
        const responseData = {
            cached: cached || false,
            cached_at: cached_at || null,
            ...twitterData // Spreads the raw __typename, legacy, verification_info, etc.
        };

        // 9. Dynamic Billing Deduction
        // If upstream utilized their cache, they charged 0. We pass that savings (and charge 0). 
        // Otherwise, we charge the 2-credit base cost.
        const actualCost = credits_charged === 0 ? 0 : baseCostToUser;
        
        req.user.credits -= actualCost;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch the profile." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/twitter/profile', 
                params: { handle: cleanHandle, cache_max_age }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/tiktok/product', authMiddleware, async (req, res) => {
    const { url, region } = req.query;

    // 1. Parameter Validation
    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    const cleanUrl = url.trim().split('?')[0]; // Strip tracking parameters
    const safeRegion = region ? region.trim().toUpperCase() : 'US';

    // 2. Pre-flight Credit Check (Charge 2 credits for 50% profit margin)
    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    // 3. Cache Key Construction
    const cacheKey = `tk_product_sc_fixed_${Buffer.from(cleanUrl).toString('base64')}_${safeRegion}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat requests)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/tiktok/product');
        upstreamUrl.searchParams.append('url', cleanUrl);
        upstreamUrl.searchParams.append('region', safeRegion);

        // 6. Execute Upstream Request (25s timeout)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch TikTok product details'}`
            );
        }

        // 8. Payload Construction & Safe Mapping
        // We safely navigate the object without aggressive destructuring so it doesn't return null
        const responseData = {
            url: cleanUrl,
            region: safeRegion,
            categories: Array.isArray(upstreamPayload.categories) 
                ? upstreamPayload.categories.map(c => c.category_name) 
                : [],
            product: upstreamPayload.product_info ? {
                id: upstreamPayload.product_info.product_id || "",
                title: upstreamPayload.product_info.product_base?.title || "",
                status: upstreamPayload.product_info.status || 1,
                sold_count: upstreamPayload.product_info.product_base?.sold_count || 0,
                price: {
                    original: upstreamPayload.product_info.product_base?.price?.original_price || null,
                    discounted: upstreamPayload.product_info.product_base?.price?.real_price || null,
                    currency: upstreamPayload.product_info.product_base?.price?.currency || "USD",
                    discount_text: upstreamPayload.product_info.product_base?.price?.discount || null
                },
                images: upstreamPayload.product_info.product_base?.images?.map(img => img.url_list?.[0]).filter(Boolean) || [],
                video_url: upstreamPayload.product_info.product_base?.desc_video?.video_infos?.[0]?.main_url || null,
                rating: {
                    score: upstreamPayload.product_info.product_detail_review?.product_rating || 0,
                    review_count: upstreamPayload.product_info.product_detail_review?.review_count || 0
                },
                skus: Array.isArray(upstreamPayload.product_info.skus) ? upstreamPayload.product_info.skus.map(sku => ({
                    id: sku.sku_id,
                    stock: sku.stock || 0,
                    price: sku.price?.real_price?.price_str || null,
                    properties: Array.isArray(sku.sku_sale_props) ? sku.sku_sale_props.map(prop => ({
                        name: prop.prop_name,
                        value: prop.prop_value
                    })) : []
                })) : []
            } : null,
            shop: upstreamPayload.shop_info ? {
                id: upstreamPayload.shop_info.seller_id || "",
                name: upstreamPayload.shop_info.shop_name || "",
                rating: upstreamPayload.shop_info.shop_rating || "",
                sold_count: upstreamPayload.shop_info.sold_count || 0,
                followers_count: upstreamPayload.shop_info.followers_count || "0",
                url: upstreamPayload.shop_info.shop_link || ""
            } : null,
            related_videos: Array.isArray(upstreamPayload.related_videos) ? upstreamPayload.related_videos.map(video => ({
                id: video.item_id,
                title: video.title,
                url: video.url,
                play_count: video.play_count,
                like_count: video.like_count,
                author_name: video.author_name
            })) : []
        };

        // 9. Billing Deduction & Caching
        const actualCost = upstreamPayload.credits_charged === 0 ? 0 : costToUser;
        req.user.credits -= actualCost;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch product details." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/product', 
                params: { url: cleanUrl, region: safeRegion }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/tiktok/shop/product/reviews', authMiddleware, async (req, res) => {
    const { url, product_id, region, page } = req.query;

    // 1. Parameter Validation
    if (!url && !product_id) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. Provide either 'url' or 'product_id'." 
        });
    }

    const cleanUrl = url ? url.trim().split('?')[0] : null; // Strip tracking parameters
    const safeProductId = product_id ? product_id.trim() : null;
    const safeRegion = region ? region.trim().toUpperCase() : 'US';
    const safePage = page ? parseInt(page, 10) : 1;

    // 2. Pre-flight Credit Check (Charge exactly 1 credit)
    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    // 3. Cache Key Construction
    const identifier = safeProductId ? `id_${safeProductId}` : `url_${Buffer.from(cleanUrl).toString('base64')}`;
    const cacheKey = `tk_reviews_sc_trimmed_${identifier}_${safeRegion}_${safePage}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat paginated queries)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/tiktok/shop/product/reviews');
        if (cleanUrl) upstreamUrl.searchParams.append('url', cleanUrl);
        if (safeProductId) upstreamUrl.searchParams.append('product_id', safeProductId);
        upstreamUrl.searchParams.append('region', safeRegion);
        upstreamUrl.searchParams.append('page', safePage);

        // 6. Execute Upstream Request (20s timeout)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch TikTok product reviews'}`
            );
        }

        // 8. Payload Construction & Strict Mapping (Trim to relevant info only)
        const responseData = {
            has_more: !!upstreamPayload.has_more,
            total_reviews: parseInt(upstreamPayload.total_reviews || "0", 10),
            summary: upstreamPayload.review_ratings ? {
                average_score: upstreamPayload.review_ratings.overall_score || 0,
                rating_distribution: upstreamPayload.review_ratings.rating_result || {}
            } : null,
            reviews: Array.isArray(upstreamPayload.product_reviews) ? upstreamPayload.product_reviews.map(r => ({
                id: r.review_id || "",
                rating: r.review_rating || 0,
                timestamp: r.review_time ? parseInt(r.review_time, 10) : null,
                text: r.review_text || "",
                images: Array.isArray(r.review_images) ? r.review_images : [],
                author: r.reviewer_name || "Anonymous",
                is_verified_purchase: !!r.is_verified_purchase,
                sku: r.sku_specification || ""
            })) : []
        };

        // 9. Billing Deduction & Caching
        const actualCost = upstreamPayload.credits_charged === 0 ? 0 : costToUser;
        req.user.credits -= actualCost;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch product reviews." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/shop/product/reviews', 
                params: { url: cleanUrl, product_id: safeProductId, region: safeRegion, page: safePage }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/tiktok/shop/products', authMiddleware, async (req, res) => {
    const { url, cursor, sort_by, region } = req.query;

    // 1. Parameter Validation
    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    const cleanUrl = url.trim().split('?')[0]; // Strip tracking query params
    const safeSortBy = sort_by && ['top', 'new_releases'].includes(sort_by.toLowerCase()) ? sort_by.toLowerCase() : 'top';
    const safeRegion = region ? region.trim().toUpperCase() : 'US';

    // 2. Pre-flight Credit Check (Charge 2 credits to maintain 50% profit margin)
    const baseCostToUser = 2;
    if (req.user.credits < baseCostToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${baseCostToUser} credits.` 
        });
    }

    // 3. Cache Key Construction
    const safeCursor = cursor ? Buffer.from(cursor).toString('base64').substring(0, 15) : '0';
    const cacheKey = `tk_shop_products_sc_${Buffer.from(cleanUrl).toString('base64')}_${safeSortBy}_${safeRegion}_${safeCursor}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat/paginated queries)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/tiktok/shop/products');
        upstreamUrl.searchParams.append('url', cleanUrl);
        upstreamUrl.searchParams.append('sort_by', safeSortBy);
        upstreamUrl.searchParams.append('region', safeRegion);
        if (cursor) upstreamUrl.searchParams.append('cursor', cursor);

        // 6. Execute Request (30s timeout for heavy catalog fetching)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(30000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch TikTok shop products'}`
            );
        }

        // 8. Payload Sanitization & Formatting
        const responseData = {
            url: cleanUrl,
            sort_by: safeSortBy,
            region: safeRegion,
            shopInfo: upstreamPayload.shopInfo ? {
                seller_id: upstreamPayload.shopInfo.seller_id || "",
                shop_name: upstreamPayload.shopInfo.shop_name || "",
                shop_logo: upstreamPayload.shopInfo.shop_logo || null,
                shop_rating: upstreamPayload.shopInfo.shop_rating || null,
                sold_count: upstreamPayload.shopInfo.sold_count || 0,
                format_sold_count: upstreamPayload.shopInfo.format_sold_count || "0",
                on_sell_product_count: upstreamPayload.shopInfo.on_sell_product_count || 0,
                followers_count: upstreamPayload.shopInfo.followers_count || "0",
                review_count: upstreamPayload.shopInfo.review_count || 0,
                shop_slogan: upstreamPayload.shopInfo.shop_slogan || "",
                shop_link: upstreamPayload.shopInfo.shop_link || cleanUrl
            } : null,
            products: Array.isArray(upstreamPayload.products) ? upstreamPayload.products.map(product => ({
                product_id: product.product_id || "",
                title: product.title || "",
                image: product.image || null,
                price_info: product.product_price_info ? {
                    currency_symbol: product.product_price_info.currency_symbol || "$",
                    sale_price: product.product_price_info.sale_price_format || product.product_price_info.sale_price_decimal || "0.00",
                    origin_price: product.product_price_info.origin_price_format || product.product_price_info.origin_price_decimal || null,
                    discount: product.product_price_info.discount_format || null
                } : null,
                rating: product.rate_info ? {
                    score: product.rate_info.score || 0,
                    review_count: product.rate_info.review_count || "0"
                } : null,
                sold: product.sold_info ? {
                    count: product.sold_info.sold_count || 0
                } : null,
                seller: product.seller_info ? {
                    seller_id: product.seller_info.seller_id || "",
                    shop_name: product.seller_info.shop_name || ""
                } : null,
                seo_url: product.seo_url?.canonical_url || null
            })) : [],
            has_more: !!upstreamPayload.has_more,
            cursor: upstreamPayload.cursor || null
        };

        // 9. Dynamic Billing Deduction
        // If upstream utilized internal cache (charged 0 credits), pass 0-cost savings to user
        const actualCost = upstreamPayload.credits_charged === 0 ? 0 : baseCostToUser;
        
        req.user.credits -= actualCost;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch the shop products." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/shop/products', 
                params: { url: cleanUrl, cursor, sort_by: safeSortBy, region: safeRegion }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/tiktok/shop/search', authMiddleware, async (req, res) => {
    const { query, page, region } = req.query;

    // 1. Parameter Validation
    if (!query || typeof query !== 'string' || query.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'query'." 
        });
    }

    const cleanQuery = query.trim();
    const safeRegion = region ? region.trim().toUpperCase() : 'US';
    const safePage = page ? parseInt(page, 10) : 1;

    // 2. Pre-flight Credit Check (Charge 2 credits to maintain 50% margin)
    const baseCostToUser = 1;
    if (req.user.credits < baseCostToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires up to ${baseCostToUser} credits.` 
        });
    }

    // 3. Cache Key Construction
    const cacheKey = `tk_shop_search_sc_${Buffer.from(cleanQuery).toString('base64')}_${safeRegion}_${safePage}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat queries)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/tiktok/shop/search');
        upstreamUrl.searchParams.append('query', cleanQuery);
        if (page) upstreamUrl.searchParams.append('page', safePage);
        if (region) upstreamUrl.searchParams.append('region', safeRegion);

        // 6. Execute Request (25s timeout)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch TikTok shop products'}`
            );
        }

        // 8. Payload Construction
        // We separate the billing metadata from upstream and pass through the products.
        const { success, credits_remaining, credits_charged, ...shopData } = upstreamPayload;
        
        const responseData = {
            ...shopData
        };

        // 9. Dynamic Billing Deduction
        const actualCost = credits_charged === 0 ? 0 : baseCostToUser;
        
        req.user.credits -= actualCost;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch the shop data." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/shop/search', 
                params: { query: cleanQuery, region: safeRegion, page: safePage }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/linkedin/ads/search', authMiddleware, async (req, res) => {
    const { company, keyword, companyId, countries, startDate, endDate, paginationToken } = req.query;

    // 1. Parameter Validation
    if (!company && !keyword && !companyId) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Provide at least one core search parameter ('company', 'keyword', or 'companyId')." 
        });
    }

    // 2. Pre-flight Credit Check (Charge 2 credits as requested)
    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    // 3. Cache Key Construction
    const safePagination = paginationToken ? Buffer.from(paginationToken.trim()).toString('base64').substring(0, 15) : '0';
    const cacheParams = [company, keyword, companyId, countries, startDate, endDate]
        .filter(Boolean)
        .map(param => Buffer.from(param.trim()).toString('base64').substring(0, 10))
        .join('_');
    const cacheKey = `li_ads_search_sc_trimmed_${cacheParams}_${safePagination}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat requests)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/linkedin/ads/search');
        if (company) upstreamUrl.searchParams.append('company', company.trim());
        if (keyword) upstreamUrl.searchParams.append('keyword', keyword.trim());
        if (companyId) upstreamUrl.searchParams.append('companyId', companyId.trim());
        if (countries) upstreamUrl.searchParams.append('countries', countries.trim().toUpperCase());
        if (startDate) upstreamUrl.searchParams.append('startDate', startDate.trim());
        if (endDate) upstreamUrl.searchParams.append('endDate', endDate.trim());
        if (paginationToken) upstreamUrl.searchParams.append('paginationToken', paginationToken.trim());

        // 6. Execute Upstream Request (25s timeout for search indexing)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to search LinkedIn Ads Library'}`
            );
        }

        // 8. Payload Construction & Strict Mapping (Trim to relevant info only)
        const responseData = {
            total_ads: upstreamPayload.totalAds || 0,
            has_more: !upstreamPayload.isLastPage,
            pagination_token: upstreamPayload.paginationToken || null,
            ads: Array.isArray(upstreamPayload.ads) ? upstreamPayload.ads.map(ad => ({
                id: ad.id || "",
                advertiser: {
                    name: ad.advertiser || ad.poster || "",
                    linkedin_page: ad.advertiserLinkedinPage || null,
                    promoted_by: ad.promotedBy || null
                },
                content: {
                    ad_type: ad.adType || "Unknown",
                    headline: ad.headline || null,
                    description: ad.description || null,
                    image_url: ad.image || null,
                    video_url: ad.video || null,
                    carousel_images: Array.isArray(ad.carouselImages) ? ad.carouselImages : [],
                    cta_text: ad.cta || null,
                    destination_url: ad.destinationUrl ? ad.destinationUrl.split('?')[0] : null // Stripped tracking
                },
                performance: {
                    total_impressions: ad.totalImpressions || null,
                    impressions_by_country: Array.isArray(ad.impressionsByCountry) ? ad.impressionsByCountry : []
                },
                duration: {
                    start_date: ad.startDate || null,
                    end_date: ad.endDate || null,
                    duration_text: ad.adDuration || null
                },
                targeting: ad.targeting ? {
                    language: ad.targeting.language || null,
                    location: ad.targeting.location || null,
                    company_exclusion: ad.targeting.company || null
                } : null
            })) : []
        };

        // 9. Billing Deduction & Caching
        const actualCost = upstreamPayload.credits_charged === 0 ? 0 : costToUser;
        req.user.credits -= actualCost;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch LinkedIn ads." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/linkedin/ads/search', 
                params: { company, keyword, companyId, countries, startDate, endDate, paginationToken }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/facebook/adLibrary/ad', authMiddleware, async (req, res) => {
    const { id, url, trim, cache_max_age } = req.query;

    // 1. Parameter Validation
    if (!id && !url) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. Provide either 'id' or 'url'." 
        });
    }

    const safeId = id ? id.trim() : null;
    const cleanUrl = url ? url.trim().split('?')[0] : null; // Strip tracking parameters
    const safeTrim = trim === 'true' ? 'true' : 'false';
    const safeMaxAge = cache_max_age || '0';

    // 2. Pre-flight Credit Check (Charge exactly 1 credit)
    const baseCostToUser = 2;
    if (req.user.credits < baseCostToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${baseCostToUser} credit.` 
        });
    }

    // 3. Cache Key Construction
    const identifier = safeId ? `id_${safeId}` : `url_${Buffer.from(cleanUrl).toString('base64')}`;
    const cacheKey = `fb_ad_sc_trimmed_${identifier}_${safeTrim}_${safeMaxAge}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat requests)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/adLibrary/ad');
        if (safeId) upstreamUrl.searchParams.append('id', safeId);
        if (cleanUrl) upstreamUrl.searchParams.append('url', cleanUrl);
        if (trim) upstreamUrl.searchParams.append('trim', safeTrim);
        if (cache_max_age) upstreamUrl.searchParams.append('cache_max_age', safeMaxAge);

        // 6. Execute Upstream Request (20s timeout)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch Facebook Ad details'}`
            );
        }

        // 8. Payload Construction & Strict Mapping
        const snap = upstreamPayload.snapshot || {};
        
        // Handle Multi-Version/Carousel Ads securely
        let adTitle = typeof snap.title === 'string' ? snap.title : "";
        let adImages = Array.isArray(snap.images) ? snap.images.map(img => img.resized_image_url || img.original_image_url).filter(Boolean) : [];
        let adLink = typeof snap.link_url === 'string' ? snap.link_url : "";

        if (Array.isArray(snap.cards) && snap.cards.length > 0) {
            // If it's a carousel, map titles and images from the cards array safely
            const cardTitles = snap.cards.map(c => typeof c.title === 'string' ? c.title : "").filter(Boolean);
            if (cardTitles.length > 0) adTitle = cardTitles.join(" | ");
            
            const cardImages = snap.cards.map(c => c.resized_image_url || c.original_image_url).filter(Boolean);
            if (cardImages.length > 0) adImages = cardImages;
            
            if (!adLink) adLink = typeof snap.cards[0]?.link_url === 'string' ? snap.cards[0].link_url : "";
        }

        // Safely parse body text replacing HTML breaks if it's a string
        let safeBodyText = "";
        if (typeof snap.body === 'string') {
            safeBodyText = snap.body.replace(/<br\s*\/?>/gi, '\n');
        } else if (snap.body && typeof snap.body.markup === 'string') {
            // Sometimes Facebook buries the text in a markup object
            safeBodyText = snap.body.markup.replace(/<br\s*\/?>/gi, '\n');
        }

        const responseData = {
            ad_id: upstreamPayload.adArchiveID || safeId,
            is_active: !!upstreamPayload.isActive,
            duration: {
                start: upstreamPayload.startDateString || null,
                end: upstreamPayload.endDateString || null
            },
            advertiser: {
                id: upstreamPayload.pageID || snap.page_id || "",
                name: upstreamPayload.pageName || snap.page_name || "",
                profile_url: snap.page_profile_uri || null,
                profile_picture: snap.page_profile_picture_url || null,
                instagram_handle: snap.instagram_actor_name || null
            },
            creative: {
                body_text: safeBodyText,
                title: adTitle,
                caption: typeof snap.caption === 'string' ? snap.caption : null,
                cta_text: typeof snap.cta_text === 'string' ? snap.cta_text : (typeof snap.cta_type === 'string' ? snap.cta_type : null),
                destination_url: adLink,
                images: adImages,
                videos: Array.isArray(snap.videos) ? snap.videos.map(v => ({
                    hd_url: v.video_hd_url || null,
                    sd_url: v.video_sd_url || null,
                    preview_image: v.video_preview_image_url || null
                })) : []
            },
            platforms: Array.isArray(upstreamPayload.publisherPlatform) ? upstreamPayload.publisherPlatform : [],
            audience_reach: upstreamPayload.aaa_info ? {
                total_reach: upstreamPayload.aaa_info.eu_total_reach || null,
                age_targeting: upstreamPayload.aaa_info.age_audience || null,
                gender_targeting: upstreamPayload.aaa_info.gender_audience || null,
                locations: upstreamPayload.aaa_info.location_audience || []
            } : null
        };

        // 9. Billing Deduction & Caching
        const actualCost = upstreamPayload.credits_charged === 0 ? 0 : baseCostToUser;
        req.user.credits -= actualCost;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch Ad Library details." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/adLibrary/ad', 
                params: { id: safeId, url: cleanUrl, trim: safeTrim, cache_max_age: safeMaxAge }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/facebook/adLibrary/ad/transcript', authMiddleware, async (req, res) => {
    const { id, url, cache_max_age } = req.query;

    // 1. Parameter Validation
    if (!id && !url) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. Provide either 'id' or 'url'." 
        });
    }

    const safeId = id ? id.trim() : null;
    const cleanUrl = url ? url.trim().split('?')[0] : null; // Strip tracking parameters
    const safeMaxAge = cache_max_age || '0';

    // 2. Pre-flight Credit Check
    // We check for 5 credits here assuming the upstream will charge a max of 1 credit.
    const expectedMaxCost = 5;
    if (req.user.credits < expectedMaxCost) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires up to ${expectedMaxCost} credits.` 
        });
    }

    // 3. Cache Key Construction
    const identifier = safeId ? `id_${safeId}` : `url_${Buffer.from(cleanUrl).toString('base64')}`;
    const cacheKey = `fb_ad_transcript_sc_root_${identifier}_${safeMaxAge}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat requests)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/adLibrary/ad/transcript');
        if (safeId) upstreamUrl.searchParams.append('id', safeId);
        if (cleanUrl) upstreamUrl.searchParams.append('url', cleanUrl);
        if (cache_max_age) upstreamUrl.searchParams.append('cache_max_age', safeMaxAge);

        // 6. Execute Upstream Request (30s timeout for video parsing/transcription)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(30000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch Facebook Ad transcript'}`
            );
        }

        // 8. Payload Construction & Strict Mapping
        // Fixed: Read directly from the root of the payload, not inside a nested "data" object
        const responseData = {
            ad_id: upstreamPayload.ad_id || safeId || "",
            url: upstreamPayload.url || cleanUrl || "",
            transcript_available: !!upstreamPayload.transcript_available,
            transcript: upstreamPayload.transcript || null
        };

        // 9. Dynamic Billing Deduction & Caching
        // Multiply the exact upstream charge by 5. 
        const actualCost = (upstreamPayload.credits_charged || 0) * 5;
        
        req.user.credits -= actualCost;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch the transcript." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/adLibrary/ad/transcript', 
                params: { id: safeId, url: cleanUrl, cache_max_age: safeMaxAge }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.all('/v1/facebook/adLibrary/search/ads', authMiddleware, async (req, res) => {
    // Support both GET (query strings) and POST (JSON body) for heavy pagination cursors
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ success: false, error: "405 Method Not Allowed. Use GET or POST." });
    }

    const params = { ...req.query, ...req.body };
    const { 
        query, sort_by, search_type, ad_type, country, 
        status, media_type, start_date, end_date, cursor, trim 
    } = params;

    // 1. Parameter Validation
    if (!query || typeof query !== 'string' || query.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'query'." 
        });
    }

    const cleanQuery = query.trim();
    const safeCursor = cursor ? cursor.trim() : null;

    // 2. Pre-flight Credit Check (Charge exactly 2 credits)
    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    // 3. Cache Key Construction
    const cacheCursor = safeCursor ? Buffer.from(safeCursor).toString('base64').substring(0, 15) : '0';
    const cacheParams = [
        cleanQuery, sort_by, search_type, ad_type, country, 
        status, media_type, start_date, end_date
    ].filter(Boolean).map(p => Buffer.from(p.trim()).toString('base64').substring(0, 8)).join('_');
    
    const cacheKey = `fb_ads_search_sc_trimmed_${cacheParams}_${cacheCursor}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat paginated queries)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/adLibrary/search/ads');
        
        const requestOptions = {
            method: req.method,
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(30000) // 30s timeout for heavy searches
        };

        // Format parameters based on request method
        if (req.method === 'GET') {
            Object.keys(params).forEach(key => {
                if (params[key]) upstreamUrl.searchParams.append(key, params[key]);
            });
        } else {
            requestOptions.body = JSON.stringify(params);
        }

        // 6. Execute Upstream Request
        const response = await fetch(upstreamUrl.toString(), requestOptions);
        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to search Facebook Ad Library'}`
            );
        }

        // 8. Payload Construction & Strict Mapping
        const responseData = {
            total_results: upstreamPayload.searchResultsCount || 0,
            has_more: !!upstreamPayload.cursor,
            cursor: upstreamPayload.cursor || null,
            ads: Array.isArray(upstreamPayload.searchResults) ? upstreamPayload.searchResults.map(ad => {
                const snap = ad.snapshot || {};

                // Safely parse body text across different Facebook object structures
                let bodyText = "";
                if (typeof snap.body === 'string') {
                    bodyText = snap.body.replace(/<br\s*\/?>/gi, '\n');
                } else if (snap.body && typeof snap.body.text === 'string') {
                    bodyText = snap.body.text.replace(/<br\s*\/?>/gi, '\n');
                } else if (snap.body && typeof snap.body.markup === 'string') {
                    bodyText = snap.body.markup.replace(/<br\s*\/?>/gi, '\n');
                }

                // Map standard images
                const adImages = Array.isArray(snap.images) 
                    ? snap.images.map(img => img.resized_image_url || img.original_image_url).filter(Boolean) 
                    : [];
                
                // Map carousel cards if present
                const carousel = Array.isArray(snap.cards) ? snap.cards.map(c => ({
                    title: typeof c.title === 'string' ? c.title : null,
                    image: c.resized_image_url || c.original_image_url || null,
                    link_url: typeof c.link_url === 'string' ? c.link_url : null
                })) : [];

                return {
                    id: ad.ad_archive_id || "",
                    is_active: !!ad.is_active,
                    start_date: ad.start_date || null,
                    end_date: ad.end_date || null,
                    platforms: Array.isArray(ad.publisher_platform) ? ad.publisher_platform : [],
                    advertiser: {
                        id: ad.page_id || snap.page_id || "",
                        name: ad.page_name || snap.page_name || "",
                        profile_url: snap.page_profile_uri || null,
                        profile_picture: snap.page_profile_picture_url || null
                    },
                    creative: {
                        format: snap.display_format || "UNKNOWN",
                        body_text: bodyText,
                        cta_text: typeof snap.cta_text === 'string' ? snap.cta_text : (typeof snap.cta_type === 'string' ? snap.cta_type : null),
                        destination_url: typeof snap.link_url === 'string' ? snap.link_url : null,
                        images: adImages,
                        carousel: carousel,
                        videos: Array.isArray(snap.videos) ? snap.videos.map(v => ({
                            hd_url: v.video_hd_url || null,
                            sd_url: v.video_sd_url || null,
                            preview_image: v.video_preview_image_url || null
                        })) : []
                    }
                };
            }) : []
        };

        // 9. Billing Deduction & Caching
        const actualCost = upstreamPayload.credits_charged === 0 ? 0 : costToUser;
        req.user.credits -= actualCost;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch ad library data." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/adLibrary/search/ads', 
                params: params, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.all('/v1/facebook/adLibrary/company/ads', authMiddleware, async (req, res) => {
    // Support both GET (query strings) and POST (JSON body) for heavy pagination cursors
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ success: false, error: "405 Method Not Allowed. Use GET or POST." });
    }

    const params = { ...req.query, ...req.body };
    const { 
        pageId, companyName, country, status, media_type, 
        language, sort_by, start_date, end_date, cursor, trim 
    } = params;

    // 1. Parameter Validation
    if (!pageId && !companyName) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. Provide either 'pageId' or 'companyName'." 
        });
    }

    const safePageId = pageId ? pageId.trim() : null;
    const safeCompanyName = companyName ? companyName.trim() : null;
    const safeCursor = cursor ? cursor.trim() : null;

    // 2. Pre-flight Credit Check (Charge 1 credit)
    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    // 3. Cache Key Construction
    const cacheCursor = safeCursor ? Buffer.from(safeCursor).toString('base64').substring(0, 15) : '0';
    const cacheParams = [
        safePageId, safeCompanyName, country, status, media_type, 
        language, sort_by, start_date, end_date
    ].filter(Boolean).map(p => Buffer.from(p.trim()).toString('base64').substring(0, 8)).join('_');
    
    const cacheKey = `fb_company_ads_sc_trimmed_${cacheParams}_${cacheCursor}`;

    try {
        // 4. Local Cache Check (Free margin on repeat paginated queries)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/adLibrary/company/ads');
        
        const requestOptions = {
            method: req.method,
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(30000) // 30s timeout for heavy pagination indexing
        };

        // Format parameters based on request method
        if (req.method === 'GET') {
            Object.keys(params).forEach(key => {
                if (params[key]) upstreamUrl.searchParams.append(key, params[key]);
            });
        } else {
            requestOptions.body = JSON.stringify(params);
        }

        // 6. Execute Upstream Request
        const response = await fetch(upstreamUrl.toString(), requestOptions);
        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch company ads'}`
            );
        }

        // 8. Payload Construction & Strict Mapping
        const responseData = {
            has_more: !!upstreamPayload.cursor,
            cursor: upstreamPayload.cursor || null,
            ads: Array.isArray(upstreamPayload.results) ? upstreamPayload.results.map(ad => {
                const snap = ad.snapshot || {};

                // Safely parse body text across different Facebook object structures
                let bodyText = "";
                if (typeof snap.body === 'string') {
                    bodyText = snap.body.replace(/<br\s*\/?>/gi, '\n');
                } else if (snap.body && typeof snap.body.text === 'string') {
                    bodyText = snap.body.text.replace(/<br\s*\/?>/gi, '\n');
                } else if (snap.body && typeof snap.body.markup === 'string') {
                    bodyText = snap.body.markup.replace(/<br\s*\/?>/gi, '\n');
                }

                // Map standard images
                const adImages = Array.isArray(snap.images) 
                    ? snap.images.map(img => img.resized_image_url || img.original_image_url).filter(Boolean) 
                    : [];
                
                // Map carousel cards if present
                const carousel = Array.isArray(snap.cards) ? snap.cards.map(c => ({
                    title: typeof c.title === 'string' ? c.title : null,
                    image: c.resized_image_url || c.original_image_url || null,
                    link_url: typeof c.link_url === 'string' ? c.link_url : null
                })) : [];

                return {
                    id: ad.ad_archive_id || "",
                    is_active: !!ad.is_active,
                    start_date: ad.start_date || null,
                    end_date: ad.end_date || null,
                    platforms: Array.isArray(ad.publisher_platform) ? ad.publisher_platform : [],
                    advertiser: {
                        id: ad.page_id || snap.page_id || "",
                        name: ad.page_name || snap.page_name || "",
                        profile_url: snap.page_profile_uri || null,
                        profile_picture: snap.page_profile_picture_url || null
                    },
                    creative: {
                        format: snap.display_format || "UNKNOWN",
                        body_text: bodyText,
                        cta_text: typeof snap.cta_text === 'string' ? snap.cta_text : (typeof snap.cta_type === 'string' ? snap.cta_type : null),
                        destination_url: typeof snap.link_url === 'string' ? snap.link_url : null,
                        images: adImages,
                        carousel: carousel,
                        videos: Array.isArray(snap.videos) ? snap.videos.map(v => ({
                            hd_url: v.video_hd_url || null,
                            sd_url: v.video_sd_url || null,
                            preview_image: v.video_preview_image_url || null
                        })) : []
                    }
                };
            }) : []
        };

        // 9. Billing Deduction & Caching
        const actualCost = upstreamPayload.credits_charged *2 === 0 ? 0 : costToUser * 2;
        req.user.credits -= actualCost;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch company ads." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/adLibrary/company/ads', 
                params: params, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/facebook/marketplace/location/search', authMiddleware, async (req, res) => {
    const { query } = req.query;

    // 1. Parameter Validation
    if (!query || typeof query !== 'string' || query.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'query'." 
        });
    }

    const cleanQuery = query.trim();

    // 2. Pre-flight Credit Check (Charge exactly 1 credit)
    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    // 3. Cache Key Construction
    const cacheKey = `fb_mkt_loc_search_sc_trimmed_${Buffer.from(cleanQuery).toString('base64')}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat queries)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/marketplace/location/search');
        upstreamUrl.searchParams.append('query', cleanQuery);

        // 6. Execute Upstream Request (15s timeout is sufficient for location search)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(15000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to search Facebook Marketplace locations'}`
            );
        }

        // 8. Payload Construction & Strict Mapping
        const responseData = {
            query: cleanQuery,
            locations: Array.isArray(upstreamPayload.locations) ? upstreamPayload.locations.map(loc => ({
                name: loc.name || "",
                subtitle: loc.subtitle || "",
                page_id: loc.page_id || "",
                latitude: typeof loc.latitude === 'number' ? loc.latitude : null,
                longitude: typeof loc.longitude === 'number' ? loc.longitude : null,
                city: loc.city || "",
                postal_code: loc.postal_code || "",
                multi_line_address: Array.isArray(loc.multi_line_address) ? loc.multi_line_address : []
            })) : []
        };

        // 9. Billing Deduction & Caching
        const actualCost = upstreamPayload.credits_charged === 0 ? 0 : costToUser;
        req.user.credits -= actualCost;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch location data." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/marketplace/location/search', 
                params: { query: cleanQuery }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/facebook/marketplace/search', authMiddleware, async (req, res) => {
    const { 
        query, lat, lng, radius_km, min_price, max_price, count, 
        sort_by, delivery_method, condition, date_listed, availability, cursor 
    } = req.query;

    // 1. Parameter Validation
    if (!query || !lat || !lng) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameters. 'query', 'lat', and 'lng' are required." 
        });
    }

    const cleanQuery = query.trim();
    const safeLat = lat.trim();
    const safeLng = lng.trim();

    // 2. Pre-flight Credit Check (Charge exactly 1 credit)
    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    // 3. Cache Key Construction
    const cacheParams = [
        cleanQuery, safeLat, safeLng, radius_km, min_price, max_price, count,
        sort_by, delivery_method, condition, date_listed, availability
    ].filter(Boolean).map(p => Buffer.from(String(p).trim()).toString('base64').substring(0, 6)).join('_');
    
    const safeCursor = cursor ? Buffer.from(cursor.trim()).toString('base64').substring(0, 15) : '0';
    const cacheKey = `fb_mkt_search_sc_trimmed_${cacheParams}_${safeCursor}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat paginated queries)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/marketplace/search');
        upstreamUrl.searchParams.append('query', cleanQuery);
        upstreamUrl.searchParams.append('lat', safeLat);
        upstreamUrl.searchParams.append('lng', safeLng);
        
        if (radius_km) upstreamUrl.searchParams.append('radius_km', radius_km.trim());
        if (min_price) upstreamUrl.searchParams.append('min_price', min_price.trim());
        if (max_price) upstreamUrl.searchParams.append('max_price', max_price.trim());
        if (count) upstreamUrl.searchParams.append('count', count.trim());
        if (sort_by) upstreamUrl.searchParams.append('sort_by', sort_by.trim());
        if (delivery_method) upstreamUrl.searchParams.append('delivery_method', delivery_method.trim());
        if (condition) upstreamUrl.searchParams.append('condition', condition.trim());
        if (date_listed) upstreamUrl.searchParams.append('date_listed', date_listed.trim());
        if (availability) upstreamUrl.searchParams.append('availability', availability.trim());
        if (cursor) upstreamUrl.searchParams.append('cursor', cursor.trim());

        // 6. Execute Upstream Request (20s timeout)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to search Facebook Marketplace'}`
            );
        }

        // 8. Payload Construction & Strict Mapping
        const responseData = {
            query: cleanQuery,
            has_next_page: !!upstreamPayload.has_next_page,
            cursor: upstreamPayload.cursor || null,
            listings: Array.isArray(upstreamPayload.listings) ? upstreamPayload.listings.map(item => ({
                id: item.id || "",
                url: item.url || "",
                title: item.title || "",
                price: item.price ? {
                    formatted: item.price.formatted_amount || "",
                    amount: item.price.amount || 0
                } : null,
                location: item.location ? {
                    city: item.location.city || "",
                    state: item.location.state || "",
                    display_name: item.location.display_name || ""
                } : null,
                primary_photo: item.primary_photo?.url || null,
                delivery_types: Array.isArray(item.delivery_types) ? item.delivery_types : [],
                is_pending: !!item.is_pending,
                is_sold: !!item.is_sold
            })) : []
        };

        // 9. Billing Deduction & Caching
        const actualCost = upstreamPayload.credits_charged === 0 ? 0 : costToUser;
        req.user.credits -= actualCost;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch marketplace listings." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/marketplace/search', 
                params: { query: cleanQuery, lat: safeLat, lng: safeLng, cursor: safeCursor }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/facebook/marketplace/item', authMiddleware, async (req, res) => {
    const { id, url } = req.query;

    // 1. Parameter Validation
    if (!id && !url) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. Provide either 'id' or 'url'." 
        });
    }

    const safeId = id ? id.trim() : null;
    const cleanUrl = url ? url.trim().split('?')[0] : null; // Strip tracking parameters

    // 2. Pre-flight Credit Check (Charge exactly 1 credit)
    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    // 3. Cache Key Construction
    const identifier = safeId ? `id_${safeId}` : `url_${Buffer.from(cleanUrl).toString('base64')}`;
    const cacheKey = `fb_mkt_item_sc_trimmed_${identifier}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat requests)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Build Upstream Request
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) {
            throw new Error("Missing SCRAPE_CREATORS_API_KEY in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/marketplace/item');
        if (safeId) upstreamUrl.searchParams.append('id', safeId);
        if (cleanUrl) upstreamUrl.searchParams.append('url', cleanUrl);

        // 6. Execute Upstream Request (20s timeout)
        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': upstreamApiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const upstreamPayload = await response.json();

        // 7. Handle Upstream Errors 
        if (!response.ok || !upstreamPayload.success) {
            throw new Error(
                `Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to fetch Marketplace item details'}`
            );
        }

        // 8. Payload Construction & Strict Mapping
        const responseData = {
            id: upstreamPayload.id || safeId || "",
            url: upstreamPayload.url || cleanUrl || "",
            title: upstreamPayload.title || "",
            description: upstreamPayload.description || "",
            creation_time: upstreamPayload.creation_time || null,
            listing_date_text: upstreamPayload.listing_date_text || null,
            availability_text: upstreamPayload.availability_text || null,
            location: {
                text: upstreamPayload.location_text || "",
                latitude: upstreamPayload.location?.latitude || null,
                longitude: upstreamPayload.location?.longitude || null
            },
            price: upstreamPayload.price ? {
                formatted: upstreamPayload.price.formatted_amount_zeros_stripped || "",
                amount: upstreamPayload.price.amount || 0,
                currency: upstreamPayload.price.currency || "USD"
            } : null,
            category_id: upstreamPayload.category_id || "",
            attributes: Array.isArray(upstreamPayload.attributes) ? upstreamPayload.attributes.map(attr => ({
                name: attr.attribute_name || "",
                value: attr.value || "",
                label: attr.label || ""
            })) : [],
            photos: Array.isArray(upstreamPayload.photos) ? upstreamPayload.photos.map(photo => ({
                id: photo.id || "",
                url: photo.url || "",
                width: photo.width || 0,
                height: photo.height || 0
            })) : [],
            status: {
                is_live: !!upstreamPayload.is_live,
                is_sold: !!upstreamPayload.is_sold,
                is_pending: !!upstreamPayload.is_pending,
                is_hidden: !!upstreamPayload.is_hidden,
                is_shipping_offered: !!upstreamPayload.is_shipping_offered
            },
            delivery_types: Array.isArray(upstreamPayload.delivery_types) ? upstreamPayload.delivery_types : [],
            seller: upstreamPayload.seller ? {
                id: upstreamPayload.seller.id || "",
                name: upstreamPayload.seller.name || "",
                profile_url: upstreamPayload.seller.profile_url || ""
            } : null
        };

        // 9. Billing Deduction & Caching
        const actualCost = upstreamPayload.credits_charged === 0 ? 0 : costToUser;
        req.user.credits -= actualCost;
        mockRedisCache[cacheKey] = responseData;

        // 10. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Upstream provider took too long to fetch marketplace item data." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/marketplace/item', 
                params: { id: safeId, url: cleanUrl }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

const { scrapeTrustpilotSearch,scrapeTrustpilotReviews } = require('./src/scrapers/trustpilot');
app.get('/v1/trustpilot/reviews', authMiddleware, async (req, res) => {
    const { domain, page, sort, stars } = req.query;

    // 1. Parameter Validation
    if (!domain || typeof domain !== 'string' || domain.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'domain'." 
        });
    }

    const cleanDomain = domain.trim().toLowerCase();
    const safePage = page ? parseInt(page, 10) : 1;
    const safeSort = sort ? sort.trim() : 'recency';
    const safeStars = stars ? stars.trim() : '';

    // 2. Pre-flight Credit Check (Charge exactly 1 credit)
    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    // 3. Cache Key Construction
    const cacheKey = `tp_reviews_native_${Buffer.from(cleanDomain).toString('base64')}_${safePage}_${safeSort}_${safeStars}`;

    try {
        // 4. Local Cache Check (Free 100% margin on repeat requests)
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Execute the Native Scraper
        const data = await scrapeTrustpilotReviews(cleanDomain, safePage, safeSort, safeStars);

        const responseData = {
            query: {
                domain: cleanDomain,
                page: safePage,
                sort: safeSort,
                stars: safeStars
            },
            ...data
        };

        // 6. Deduct Credit & Store in Cache
        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = responseData;

        // 7. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = isTimeout ? 504 : 500;
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The scraper took too long to fetch Trustpilot reviews." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/trustpilot/reviews', 
                params: { domain: cleanDomain, page: safePage, sort: safeSort, stars: safeStars }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/trustpilot/search', authMiddleware, async (req, res) => {
    const { query } = req.query;

    // 1. Parameter Validation
    if (!query || typeof query !== 'string' || query.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'query'." 
        });
    }

    const cleanQuery = query.trim();

    // 2. Pre-flight Credit Check (Charge exactly 1 credit)
    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    // 3. Cache Key Construction
    const cacheKey = `tp_search_native_${Buffer.from(cleanQuery).toString('base64')}`;

    try {
        // 4. Local Cache Check
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Execute the Native Scraper
        const businesses = await scrapeTrustpilotSearch(cleanQuery);

        const responseData = {
            query: cleanQuery,
            total_results: businesses.length,
            businesses: businesses
        };

        // 6. Deduct Credit & Store in Cache
        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = responseData;

        // 7. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.message.includes('Timeout');
        const statusCode = isTimeout ? 504 : 500;
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The scraper took too long to fetch Trustpilot results." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/trustpilot/search', 
                params: { query: cleanQuery }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

const { scrapeYellowpagesAPI } = require('./src/scrapers/yellowpages');

app.get('/v1/yellowpages/search', authMiddleware, async (req, res) => {
    const { term, location, page } = req.query;

    // 1. Parameter Validation
    if (!term || !location) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameters. Both 'term' and 'location' are required." 
        });
    }

    const cleanTerm = term.trim();
    const cleanLocation = location.trim();
    const safePage = page ? parseInt(page, 10) : 1;

    // 2. Pre-flight Credit Check
    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    // 3. Cache Key Construction
    const cacheKey = `yp_search_api_${Buffer.from(cleanTerm).toString('base64')}_${Buffer.from(cleanLocation).toString('base64')}_${safePage}`;

    try {
        // 4. Local Cache Check
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Execute ScraperAPI Module
        const businesses = await scrapeYellowpagesAPI(cleanTerm, cleanLocation, safePage);

        const responseData = {
            query: {
                term: cleanTerm,
                location: cleanLocation,
                page: safePage
            },
            total_results_on_page: businesses.length,
            businesses: businesses
        };

        // 6. Deduct Credit & Store in Cache (Only non-empty responses)
        req.user.credits -= costToUser;
        if (businesses.length > 0) {
            mockRedisCache[cacheKey] = responseData;
        }

        // 7. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.message.includes('Timeout') || error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The Scraping API took too long to fetch Yellowpages results." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/yellowpages/search', 
                params: { term: cleanTerm, location: cleanLocation, page: safePage }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

const { scrapeZillowSearchAPI, scrapeZillowDetailAPI } = require('./src/scrapers/zillow');

// --- Zillow Search Endpoint ---
app.get('/v1/zillow/search', authMiddleware, async (req, res) => {
    const { location, page } = req.query;

    if (!location || typeof location !== 'string' || location.trim() === '') {
        return res.status(400).json({ success: false, error: "400 Bad Request: Missing 'location'." });
    }

    const cleanLocation = location.trim();
    const safePage = page ? parseInt(page, 10) : 1;
    const costToUser = 1;

    if (req.user.credits < costToUser) {
        return res.status(403).json({ success: false, error: `403 Forbidden: Insufficient credits.` });
    }

    const cacheKey = `zillow_search_api_${Buffer.from(cleanLocation).toString('base64')}_${safePage}`;

    try {
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true, credits_remaining: req.user.credits, credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        const listings = await scrapeZillowSearchAPI(cleanLocation, safePage);

        const responseData = {
            query: { location: cleanLocation, page: safePage },
            total_results_on_page: listings.length,
            listings: listings
        };

        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = responseData;

        return res.status(200).json({
            success: true, credits_remaining: req.user.credits, credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});


// --- Zillow Item Endpoint ---
app.get('/v1/zillow/item', authMiddleware, async (req, res) => {
    const { zpid, url } = req.query;

    if (!zpid && !url) {
        return res.status(400).json({ success: false, error: "400 Bad Request: Missing 'zpid' or 'url'." });
    }

    const safeZpid = zpid ? zpid.trim() : null;
    const cleanUrl = url ? url.trim().split('?')[0] : null;
    const costToUser = 1;

    if (req.user.credits < costToUser) {
        return res.status(403).json({ success: false, error: `403 Forbidden: Insufficient credits.` });
    }

    const identifier = safeZpid ? `zpid_${safeZpid}` : `url_${Buffer.from(cleanUrl).toString('base64').substring(0, 20)}`;
    const cacheKey = `zillow_detail_api_${identifier}`;

    try {
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true, credits_remaining: req.user.credits, credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        const propertyData = await scrapeZillowDetailAPI(safeZpid, cleanUrl);

        if (!propertyData) {
            throw new Error("Successfully fetched the page, but failed to locate the property data block.");
        }

        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = propertyData;

        return res.status(200).json({
            success: true, credits_remaining: req.user.credits, credits_charged: costToUser,
            ...propertyData
        });

    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

const { scrapeGoogleMapsSearch,scrapeGoogleMapsReviews } = require('./src/scrapers/gmaps');

app.get('/v1/gmaps/reviews', authMiddleware, async (req, res) => {
    const { url, limit = 50, sort = 'newest' } = req.query;

    // 1. Validation
    if (!url || typeof url !== 'string' || !url.includes('google.com/maps')) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing or invalid parameter 'url'. Must be a valid Google Maps URL." 
        });
    }

    const cleanUrl = url.trim();
    const sortParam = sort.toLowerCase().trim();
    const parsedLimit = parseInt(limit, 10);

    // 2. Credit Check
    const costToUser = 2; 
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    // 3. Collision-Proof Cache Key
    const queryHash = crypto.createHash('md5').update(`${cleanUrl}_${parsedLimit}_${sortParam}`).digest('hex');
    const cacheKey = `gmaps_reviews_apify_${queryHash}`;

    try {
        // 4. Cache Check
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0,
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Execute Apify Scraper
        const reviews = await scrapeGoogleMapsReviews(cleanUrl, parsedLimit, sortParam);

        const responseData = {
            place_url: cleanUrl,
            sort: sortParam,
            total_reviews_extracted: reviews.length,
            reviews: reviews
        };

        // 6. Deduct Credit & Store in Cache (Only if we got data!)
        req.user.credits -= costToUser;
        if (reviews.length > 0) {
            mockRedisCache[cacheKey] = responseData;
        }

        // 7. Success Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/google/maps/reviews', 
                params: { url: cleanUrl, sort: sortParam, limit: parsedLimit }, 
                statusCode: 500, 
                errorMsg: error.message 
            });
        }

        return res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.get('/v1/gmaps/search', authMiddleware, async (req, res) => {
    const { query } = req.query;

    if (!query || typeof query !== 'string' || query.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'query'." 
        });
    }

    const cleanQuery = query.trim();
    const costToUser = 1;

    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    // Cache key no longer needs a cursor/page identifier
    const cacheKey = `gmaps_search_native_all_${Buffer.from(cleanQuery).toString('base64')}`;

    try {
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        const listings = await scrapeGoogleMapsSearch(cleanQuery);

        const responseData = {
            query: cleanQuery,
            total_results: listings.length,
            listings: listings
        };

        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = responseData;

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.message.includes('Timeout') || error.name === 'TimeoutError';
        const isProxyError = error.message.includes('ERR_TUNNEL_CONNECTION_FAILED');
        const statusCode = isTimeout || isProxyError ? 504 : 500;
        
        let finalErrorMsg = error.message;
        if (isTimeout) finalErrorMsg = "504 Gateway Timeout: The scraper took too long to fetch Google Maps results.";
        if (isProxyError) finalErrorMsg = "504 Gateway Timeout: The proxy provider dropped the connection mid-scrape. Please retry.";

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/gmaps/search', 
                params: { query: cleanQuery }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

const { scrapeAmazonStorefront,scrapeAmazonSearchAPI,MARKETPLACE_MAP,scrapeAmazonProductAPI } = require('./src/scrapers/amazon');

const crypto = require('crypto');



app.get('/v1/amazon/product', authMiddleware, async (req, res) => {
    const { asin, marketplace = 'us' } = req.query;

    // 1. Parameter Validation
    if (!asin || typeof asin !== 'string' || !/^[a-zA-Z0-9]{10}$/.test(asin.trim())) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing or invalid parameter 'asin'. Must be a standard 10-character Amazon ID." 
        });
    }

    const marketCode = marketplace.toString().toLowerCase().trim();
    const cleanAsin = asin.toUpperCase().trim();

    // 2. Pre-flight Credit Check
    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits.` 
        });
    }

    // 3. Collision-Proof Cache Key
    const cacheKey = `amazon_product_${marketCode}_${cleanAsin}`;

    try {
        // 4. Cache Check
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0,
                data: mockRedisCache[cacheKey]
            });
        }

        // 5. Execute Scraper
        const product = await scrapeAmazonProductAPI(cleanAsin, marketCode);

        // 6. Deduct Credit & Store in Cache
        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = product;

        // 7. Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            data: product
        });

    } catch (error) {
        const isTimeout = error.message.includes('timeout') || error.name === 'TimeoutError';
        const isNotFound = error.message.includes('Product not found');
        
        let statusCode = 500;
        if (isTimeout) statusCode = 504;
        if (isNotFound) statusCode = 404;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/amazon/product', 
                params: { asin: cleanAsin, marketplace: marketCode }, 
                statusCode, 
                errorMsg: error.message 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.get('/v1/amazon/search', authMiddleware, async (req, res) => {
    const { keyword, marketplace = 'us', page = 1 } = req.query;

    // 1. Parameter Validation
    if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing or invalid parameter 'keyword'." 
        });
    }

    const marketCode = marketplace.toString().toLowerCase().trim();
    if (!MARKETPLACE_MAP[marketCode]) {
        return res.status(400).json({
            success: false,
            error: `400 Bad Request: Unsupported marketplace '${marketplace}'. Supported options: ${Object.keys(MARKETPLACE_MAP).join(', ')}`
        });
    }

    const cleanKeyword = keyword.trim();
    const pageNum = Math.max(1, parseInt(page, 10) || 1);

    // 2. Pre-flight Credit Check (1 credit)
    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    // 3. Collision-Proof Cache Key
    const queryHash = crypto.createHash('md5').update(`${marketCode}:${pageNum}:${cleanKeyword.toLowerCase()}`).digest('hex');
    const cacheKey = `amazon_search_${queryHash}`;

    try {
        // 4. Cache Check
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0,
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Execute Scraper
        const products = await scrapeAmazonSearchAPI(cleanKeyword, marketCode, pageNum);

        const responseData = {
            keyword: cleanKeyword,
            marketplace: marketCode,
            page: pageNum,
            total_products_extracted: products.length,
            products: products
        };

        // 6. Deduct Credit & Cache Non-Empty Responses
        req.user.credits -= costToUser;
        if (products.length > 0) {
            mockRedisCache[cacheKey] = responseData;
        }

        // 7. Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.message.includes('timeout') || error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        let finalErrorMsg = error.message;

        if (isTimeout) {
            finalErrorMsg = "504 Gateway Timeout: The Scraping API took too long to fetch Amazon search results.";
        }

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/amazon/search', 
                params: { keyword: cleanKeyword, marketplace: marketCode, page: pageNum }, 
                statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

app.get('/v1/amazon/storefront', authMiddleware, async (req, res) => {
    const { url } = req.query;

    // 1. Parameter Validation
    if (!url || typeof url !== 'string' || !url.includes('amazon.com')) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing or invalid parameter 'url'. Must be a valid Amazon storefront URL." 
        });
    }

    const cleanUrl = url.trim();

    // 2. Pre-flight Credit Check (Charge exactly 1 credit)
    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    // 3. Cache Key Construction

    const crypto = require('crypto'); // Add this at the very top of your file

// ... inside the route ...

// Create a unique hash of the ENTIRE URL to prevent collisions
const urlHash = crypto.createHash('md5').update(cleanUrl).digest('hex');
const cacheKey = `amazon_storefront_${urlHash}`;
    try {
        // 4. Local Cache Check
        if (mockRedisCache[cacheKey]) {
            return res.status(200).json({
                success: true,
                credits_remaining: req.user.credits,
                credits_charged: 0, 
                ...mockRedisCache[cacheKey]
            });
        }

        // 5. Execute the Scraper API Wrapper
        const products = await scrapeAmazonStorefront(cleanUrl);

        const responseData = {
            storefront_url: cleanUrl,
            total_products_extracted: products.length,
            products: products
        };

        // 6. Deduct Credit & Store in Cache
        req.user.credits -= costToUser;
        mockRedisCache[cacheKey] = responseData;

        // 7. Return Response
        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.message.includes('timeout') || error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        
        let finalErrorMsg = error.message;
        if (isTimeout) finalErrorMsg = "504 Gateway Timeout: The Scraping API took too long to fetch the Amazon storefront. The proxy may have been blocked.";

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/amazon/storefront', 
                params: { url: cleanUrl }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

// Catch-all for undefined API routes
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: "404 Not Found: The requested API endpoint does not exist."
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`SignalQub API is awake and listening on port ${PORT}`);
});