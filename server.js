require('dotenv').config();
const express = require('express');
const redditOrchestrator = require('./src/services/reddit-orchestrator');
const instagramOrchestrator = require('./src/services/instagram-orchestrator');
const trustpilotOrchestrator = require('./src/services/trustpilot-orchestrator');
const amazonOrchestrator = require('./src/services/amazon-orchestrator');
const sequenzy = require('./src/services/sequenzy');
const { universalCacheMiddleware } = require('./cacheMiddleware');
const axios = require('axios');


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
        persistSession: false 
    },
    // DELETE the 'global' block and replace it with this 'realtime' block:
    realtime: {
        transport: WebSocket
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

// Reusable logging function
const logApiRequest = async (req, endpoint, cost, params, statusCode) => {
    console.log(`\n--- 📊 ATTEMPTING TO LOG API CALL ---`);
    console.log(`Endpoint: ${endpoint} | Cost: ${cost} | Status: ${statusCode}`);
    
    // 1. Check if the user object exists and what keys it has
    console.log(`User Object in Request:`, req.user); 

    if (!req.user) {
        console.error('❌ LOGGING ABORTED: req.user is entirely missing from the request.');
        return;
    }

    if (!req.user.id) {
        console.error('❌ LOGGING ABORTED: req.user exists, but req.user.id is undefined. Check your authMiddleware!');
        return;
    }

    try {
        const { error } = await supabase
            .from('api_logs')
            .insert({
                user_id: req.user.id,
                endpoint: endpoint,
                cost: cost,
                request_params: params,
                status_code: statusCode
            });

        if (error) {
            // 2. Check if Supabase rejected it (usually an RLS error)
            console.error(`❌ SUPABASE INSERT ERROR:`, error);
        } else {
            console.log(`✅ Log successfully inserted into api_logs!`);
        }
    } catch (err) {
        // 3. Catch server crashes (like supabase being undefined)
        console.error('❌ FATAL SERVER ERROR DURING LOGGING:', err);
    }
};

app.post('/api/webhook/dodo', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const event = dodo.webhooks.unwrap(req.body, req.headers);
        if (event.type === 'payment.succeeded') {
            const payment = event.data;
            const userId = payment.metadata?.user_id;
            const tier = payment.metadata?.tier;
            const creditsToAdd = tier === 'starter' ? 7500 : tier === 'freelance' ? 25000 : tier === 'business' ? 400000 : 0;
            if (userId && creditsToAdd > 0) {
                const { data: profile } = await supabase.from('profiles').select('credits').eq('id', userId).single();
                if (profile) await supabase.from('profiles').update({ credits: profile.credits + creditsToAdd }).eq('id', userId);
            }
        }
        res.status(200).send('Webhook processed');
    } catch (err) {
        console.error('Webhook Verification Error:', err.message);
        res.status(401).send(`Webhook Error: ${err.message}`);
    }
});

app.use(cors({
    origin: ['https://signalqub.com', 'https://www.signalqub.com', 'http://localhost:5173'],
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true
}));
app.use(express.json());

const DODO_PRODUCTS = {
    freelance: 'pdt_0Nm64vHyFBNMYQ8psOOvG',
    business: 'pdt_0Nm65NK5dcgDghkgeaYD5',
    starter: 'pdt_0Noa0SXDyHzMb0Ak1Efy1'
};

app.post('/api/checkout', authMiddleware, async (req, res) => {
    try {
        const { tier } = req.body;
        const productId = DODO_PRODUCTS[tier];
        if (!productId) return res.status(400).json({ success: false, error: "Invalid pricing tier selected." });
        const session = await dodo.checkoutSessions.create({
            product_cart: [{ product_id: productId, quantity: 1 }],
            metadata: { user_id: req.user.id, tier },
            return_url: 'https://signalqub.com/dashboard?payment=success'
        });
        res.json({ success: true, url: session.checkout_url });
    } catch (error) {
        console.error("Checkout Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const mockRedisCache = {};

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
        thumbnail: (post.thumbnail === "self" || post.thumbnail === "default" || post.thumbnail === "") ? null : post.thumbnail
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
            .select('*')
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
            api_key: userProfile.api_key,
            firstName: userProfile.first_name || userProfile.firstName || undefined
        };

        let lastResponseBody;
        const originalJson = res.json.bind(res);
        res.json = body => {
            lastResponseBody = body;
            return originalJson(body);
        };
        res.on('finish', () => {
            sequenzy.trackSuccessfulApiCall(req.user, req, res.statusCode, lastResponseBody, supabase);

            if (req.path.startsWith('/v1/') && res.statusCode === 200 && lastResponseBody?.success && lastResponseBody.credits_charged === 0) {
                supabase.from('api_logs')
                    .insert([{ user_id: req.user.id, cost: 0 }])
                    .then(({error}) => { if (error) console.error("DB Zero-cost API log failed:", error); });
            }
        });

        // --- THE MAGIC TRICK ---
        // This intercepts `req.user.credits -= 1` in your endpoints 
        // and automatically syncs the new balance to the database!
        // --- THE MAGIC TRICK (Upgraded for Graphs) ---
        let currentCredits = userProfile.credits;
        Object.defineProperty(req.user, 'credits', {
            get: function() { return currentCredits; },
            set: function(newVal) {
                const cost = currentCredits - newVal; // Calculate credits spent
                const crossedDepletionThreshold = currentCredits > 200 && newVal <= 200;
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

                if (crossedDepletionThreshold) {
                    sequenzy.trackCreditDepletion(req.user, newVal);
                }
            }
        });

        next();
    } catch (err) {
        console.error("Auth Middleware Error:", err);
        return res.status(500).json({ success: false, error: "Internal Server Error verifying API key." });
    }
}

app.use('/v1', authMiddleware);
// Apply the global cache middleware to all routes under '/v1'
app.use('/v1', universalCacheMiddleware);

// --- EXPRESS ROUTE: REDDIT SUBREDDIT DETAILS ---
app.get('/v1/reddit/subreddit/details', authMiddleware, async (req, res) => {
    const { url, subreddit, name, cache_max_age } = req.query;

    // 1. Parameter Validation
    // Accept url, subreddit, or name (for backward compatibility)
    if (!url && !subreddit && !name) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter. Provide either 'subreddit' or 'url'."
        });
    }

    const baseCostToUser = 1;

    // 2. Pre-flight Credit Check
    if (req.user.credits < baseCostToUser) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires up to ${baseCostToUser} credit(s).`
        });
    }

    // Safely parse the subreddit name from various possible user inputs
    let cleanSubreddit = null;
    let cleanUrl = null;

    if (url) {
        cleanUrl = url.trim().split('?')[0];
    } else {
        const rawInput = subreddit || name;
        cleanSubreddit = rawInput.trim().split('?')[0].replace(/\/$/, '');
        if (cleanSubreddit.includes('reddit.com/r/')) {
            cleanSubreddit = cleanSubreddit.split('reddit.com/r/')[1].split('/')[0];
        } else if (cleanSubreddit.startsWith('r/')) {
            cleanSubreddit = cleanSubreddit.replace(/^r\//, '');
        }
    }

    try {
        // 3. Build Extraction Request
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment configuration");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/reddit/subreddit/details');
        
        if (cleanUrl) targetUrl.searchParams.append('url', cleanUrl);
        if (cleanSubreddit) targetUrl.searchParams.append('subreddit', cleanSubreddit); // Note: Case Sensitive!
        if (cache_max_age) targetUrl.searchParams.append('cache_max_age', cache_max_age);

        // 4. Execute Request (20s timeout)
        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000)
        });

        const payload = await response.json();

        // 5. Handle Upstream Errors 
        if (!response.ok || !payload.success) {
            const apiErr = payload.error ? payload.error.toLowerCase() : "";
            if (response.status === 404 || apiErr.includes('not found')) {
                throw new Error("404 Not Found: The requested subreddit does not exist, is banned, or is private.");
            }
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to extract subreddit data'}`);
        }

        // 6. Payload Construction & Strict Mapping
        const responseData = {
            subreddit_id: payload.subreddit_id || null,
            display_name: payload.display_name || cleanSubreddit,
            subscribers: payload.subscribers || 0,
            weekly_active_users: payload.weekly_active_users || 0,
            weekly_contributions: payload.weekly_contributions || 0,
            description: payload.description || "",
            rules: payload.rules || "",
            icon_img: payload.icon_img || null,
            header_img: payload.header_img || null,
            advertiser_category: payload.advertiser_category || "",
            created_at: payload.created_at || null,
            submit_text: payload.submit_text || "",
            cached: payload.cached || false,
            cached_at: payload.cached_at || null
        };

        // 7. Dynamic Billing Deduction
        // If upstream served from cache, they charged 0. We pass that savings to the user.
        const actualCost = payload.credits_charged === 0 ? 0 : baseCostToUser;
        req.user.credits -= actualCost;

        const requestParamsLog = { url: cleanUrl, subreddit: cleanSubreddit, cache_max_age };

        // [NEW] 8. LOG THE SUCCESS
        await logApiRequest(req, '/v1/reddit/subreddit/details', actualCost, requestParamsLog, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData 
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const isNotFound = error.message.includes('404');
        
        let statusCode = 500;
        let finalErrorMsg = "Internal Server Error: Failed to extract subreddit data at this time.";

        if (isNotFound) {
            statusCode = 404;
            finalErrorMsg = "404 Not Found: The requested subreddit does not exist, is banned, or is private.";
        } else if (isTimeout) {
            statusCode = 504;
            finalErrorMsg = "504 Gateway Timeout: Data extraction took too long to complete. Please try again.";
        } else if (error.message) {
            finalErrorMsg = error.message;
        }

        const requestParamsLog = { url: cleanUrl, subreddit: cleanSubreddit, cache_max_age };

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/reddit/subreddit/details',
                params: requestParamsLog,
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // [NEW] LOG THE FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/reddit/subreddit/details', 0, requestParamsLog, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

// --- 2. UPDATED EXPRESS ROUTE ---
app.get('/v1/reddit/subreddit/posts', authMiddleware, async (req, res) => {
    const rawInput = req.query.subreddit || req.query.name;
    const sort = req.query.sort || 'hot';
    const timeframe = req.query.timeframe || 'all';
    const cursor = req.query.cursor || req.query.after || null; 
    const limit = parseInt(req.query.limit, 10) || 100; 
    const trim = req.query.trim === 'true';

    if (!rawInput) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'subreddit' or 'name'"
        });
    }

    let cleanSubreddit = rawInput.trim().split('?')[0].replace(/\/$/, '');
    if (cleanSubreddit.includes('reddit.com/r/')) {
        cleanSubreddit = cleanSubreddit.split('reddit.com/r/')[1].split('/')[0];
    } else if (cleanSubreddit.startsWith('r/')) {
        cleanSubreddit = cleanSubreddit.replace(/^r\//, '');
    }

    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credit(s).`
        });
    }

    let postsData = null;
    let nextCursor = null;
    let primaryErrorMsg = "";

    try {
        // --- PRIMARY ATTEMPT: GetAnyAPI ---
        const getAnyApiKey = process.env.GETANYAPI_KEY;
        if (!getAnyApiKey) throw new Error("Missing primary API key");

        const getAnyApiBody = {
            subreddit: cleanSubreddit,
            sort: sort,
            limit: limit
        };
        
        if (sort === 'top') {
            getAnyApiBody.timeframe = timeframe;
        }
        if (cursor) {
            getAnyApiBody.cursor = cursor;
        }

        const primaryResponse = await fetch('https://api.getanyapi.com/v1/run/reddit.subreddit_posts', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${getAnyApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(getAnyApiBody),
            signal: AbortSignal.timeout(8000)
        });

        if (!primaryResponse.ok) {
            throw new Error(`HTTP ${primaryResponse.status}`);
        }

        const primaryData = await primaryResponse.json();

        if (primaryData.output && primaryData.output.found) {
            postsData = primaryData.output.data.posts;
            nextCursor = primaryData.output.data.nextCursor;
        } else {
            throw new Error("404 Not Found");
        }

    } catch (primaryError) {
        primaryErrorMsg = primaryError.message;
        
        // --- FALLBACK ATTEMPT: ScrapeCreators ---
        try {
            const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
            if (!upstreamApiKey) throw new Error("Missing fallback API key");

            const targetUrl = new URL('https://api.scrapecreators.com/v1/reddit/subreddit/posts');
            targetUrl.searchParams.append('subreddit', cleanSubreddit);
            targetUrl.searchParams.append('sort', sort);
            if (timeframe && sort === 'top') targetUrl.searchParams.append('timeframe', timeframe);
            if (cursor) targetUrl.searchParams.append('cursor', cursor);
            targetUrl.searchParams.append('limit', limit);

            const fallbackResponse = await fetch(targetUrl.toString(), {
                method: 'GET',
                headers: {
                    'x-api-key': upstreamApiKey,
                    'Content-Type': 'application/json'
                },
                signal: AbortSignal.timeout(12000)
            });

            const fallbackPayload = await fallbackResponse.json();

            if (!fallbackResponse.ok || fallbackPayload.success === false) {
                const apiErr = fallbackPayload.error ? fallbackPayload.error.toLowerCase() : "";
                if (fallbackResponse.status === 404 || apiErr.includes('not found')) {
                    throw new Error("404 Not Found");
                }
                throw new Error(fallbackPayload.error || `HTTP ${fallbackResponse.status}`);
            }

            postsData = fallbackPayload.posts;
            nextCursor = fallbackPayload.next_cursor;

        } catch (fallbackError) {
            const isTimeout = fallbackError.name === 'TimeoutError' || primaryError.name === 'TimeoutError';
            const isNotFound = fallbackError.message.includes('404') || primaryErrorMsg.includes('404');
            
            let statusCode = 500;
            let clientErrorMsg = "Internal Server Error: Failed to extract posts at this time.";

            if (isNotFound) {
                statusCode = 404;
                clientErrorMsg = "404 Not Found: The requested subreddit does not exist, is banned, or is private.";
            } else if (isTimeout) {
                statusCode = 504;
                clientErrorMsg = "504 Gateway Timeout: Data extraction took too long to complete. Please try again.";
            }

            if (typeof notifyFailure === 'function') {
                notifyFailure({
                    endpoint: '/v1/reddit/subreddit/posts',
                    params: { subreddit: cleanSubreddit, sort, timeframe, cursor, limit, trim },
                    statusCode: statusCode,
                    errorMsg: `Primary: ${primaryErrorMsg} | Fallback: ${fallbackError.message}`
                });
            }

            // [NEW] 1. LOG THE FAILURE (Cost = 0)
            await logApiRequest(req, '/v1/reddit/subreddit/posts', 0, { subreddit: cleanSubreddit, sort, timeframe, cursor, limit, trim }, statusCode);

            return res.status(statusCode).json({
                success: false,
                error: clientErrorMsg
            });
        }
    }

    const formattedPosts = formatRedditPosts(postsData, trim);

    req.user.credits -= costPerRequest;

    // [NEW] 2. LOG THE SUCCESS (Cost = 1)
    await logApiRequest(req, '/v1/reddit/subreddit/posts', costPerRequest, { subreddit: cleanSubreddit, sort, timeframe, cursor, limit, trim }, 200);

    return res.status(200).json({
        success: true,
        credits_remaining: req.user.credits,
        credits_charged: costPerRequest,
        posts: formattedPosts,
        next_cursor: nextCursor
    });
});


app.get('/v1/reddit/subreddit/search', authMiddleware, async (req, res) => {
    const rawInput = req.query.subreddit || req.query.name;
    const query = req.query.q || req.query.query;
    const sort = req.query.sort || 'relevance';
    const timeframe = req.query.timeframe || 'all';
    const cursor = req.query.cursor || req.query.after || null;
    const limit = parseInt(req.query.limit, 10) || 100;

    if (!rawInput || !query) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameters 'subreddit' and 'q' (or 'query')"
        });
    }

    let cleanSubreddit = rawInput.trim().split('?')[0].replace(/\/$/, '');
    if (cleanSubreddit.includes('reddit.com/r/')) {
        cleanSubreddit = cleanSubreddit.split('reddit.com/r/')[1].split('/')[0];
    } else if (cleanSubreddit.startsWith('r/')) {
        cleanSubreddit = cleanSubreddit.replace(/^r\//, '');
    }

    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credit(s).`
        });
    }

    let upstreamPayload = null;
    let primaryErrorMsg = "";

    try {
        // --- PRIMARY ATTEMPT: GetAnyAPI ---
        const getAnyApiKey = process.env.GETANYAPI_KEY;
        if (!getAnyApiKey) throw new Error("Missing primary API key");

        const getAnyApiBody = {
            subreddit: cleanSubreddit,
            query: query,
            sort: sort,
            timeframe: timeframe
        };
        
        if (cursor) {
            getAnyApiBody.cursor = cursor;
        }

        const primaryResponse = await fetch('https://api.getanyapi.com/v1/run/reddit.subreddit_search', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${getAnyApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(getAnyApiBody),
            signal: AbortSignal.timeout(8000)
        });

        if (!primaryResponse.ok) {
            throw new Error(`HTTP ${primaryResponse.status}`);
        }

        const primaryData = await primaryResponse.json();

        if (primaryData.output && primaryData.output.found) {
            const data = primaryData.output.data;
            
            upstreamPayload = {
                cursor: data.nextCursor || null,
                posts: data.posts || [],
                comments: data.comments || [],
                media: data.media || []
            };
        } else {
            throw new Error("404 Not Found");
        }

    } catch (primaryError) {
        primaryErrorMsg = primaryError.message;
        
        // --- FALLBACK ATTEMPT: ScrapeCreators ---
        try {
            const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
            if (!upstreamApiKey) throw new Error("Missing fallback API key");

            const targetUrl = new URL('https://api.scrapecreators.com/v1/reddit/subreddit/search');
            targetUrl.searchParams.append('subreddit', cleanSubreddit);
            targetUrl.searchParams.append('query', query);
            targetUrl.searchParams.append('sort', sort);
            targetUrl.searchParams.append('timeframe', timeframe);
            
            if (cursor) {
                targetUrl.searchParams.append('cursor', cursor);
            }

            const fallbackResponse = await fetch(targetUrl.toString(), {
                method: 'GET',
                headers: {
                    'x-api-key': upstreamApiKey,
                    'Content-Type': 'application/json'
                },
                signal: AbortSignal.timeout(12000)
            });

            const fallbackPayload = await fallbackResponse.json();

            if (!fallbackResponse.ok || fallbackPayload.success === false) {
                const apiErr = fallbackPayload.error ? fallbackPayload.error.toLowerCase() : "";
                if (fallbackResponse.status === 404 || apiErr.includes('not found')) {
                    throw new Error("404 Not Found");
                }
                throw new Error(fallbackPayload.error || `HTTP ${fallbackResponse.status}`);
            }

            upstreamPayload = {
                cursor: fallbackPayload.cursor || null,
                posts: fallbackPayload.posts || [],
                comments: fallbackPayload.comments || [],
                media: fallbackPayload.media || []
            };

        } catch (fallbackError) {
            const isTimeout = fallbackError.name === 'TimeoutError' || primaryError.name === 'TimeoutError';
            const isNotFound = fallbackError.message.includes('404') || primaryErrorMsg.includes('404');
            
            let statusCode = 500;
            let clientErrorMsg = "Internal Server Error: Failed to execute search at this time.";

            if (isNotFound) {
                statusCode = 404;
                clientErrorMsg = "404 Not Found: The requested subreddit does not exist or cannot be searched.";
            } else if (isTimeout) {
                statusCode = 504;
                clientErrorMsg = "504 Gateway Timeout: The search query took too long to complete. Please try again.";
            }

            if (typeof notifyFailure === 'function') {
                notifyFailure({
                    endpoint: '/v1/reddit/subreddit/search',
                    params: { subreddit: cleanSubreddit, query, sort, timeframe, cursor, limit },
                    statusCode: statusCode,
                    errorMsg: `Primary: ${primaryErrorMsg} | Fallback: ${fallbackError.message}`
                });
            }

            // [NEW] 1. LOG THE FAILURE (Cost = 0)
            await logApiRequest(req, '/v1/reddit/subreddit/search', 0, { subreddit: cleanSubreddit, query, sort, timeframe, cursor, limit }, statusCode);

            return res.status(statusCode).json({
                success: false,
                error: clientErrorMsg
            });
        }
    }

    const responseData = {
        cursor: upstreamPayload.cursor,
        posts: upstreamPayload.posts,
        comments: upstreamPayload.comments,
        media: upstreamPayload.media
    };
    
    req.user.credits -= costPerRequest;

    // [NEW] 2. LOG THE SUCCESS (Cost = 1)
    await logApiRequest(req, '/v1/reddit/subreddit/search', costPerRequest, { subreddit: cleanSubreddit, query, sort, timeframe, cursor, limit }, 200);

    return res.status(200).json({
        success: true,
        credits_remaining: req.user.credits,
        credits_charged: costPerRequest,
        cursor: responseData.cursor,
        ...responseData 
    });
});

const { scrapePostComments } = require('./src/scrapers/reddit');

// --- ENDPOINT 4: POST COMMENTS (1 CREDIT) ---
// --- 3. UPDATED EXPRESS ROUTE ---
app.get('/v1/reddit/post/comments', authMiddleware, async (req, res) => {
    const postUrl = req.query.url || req.query.permalink;
    
    // Support 'after' for legacy consumers, but strictly use 'cursor' going forward
    const cursor = req.query.cursor || req.query.after || null;
    const trim = req.query.trim === 'true';
    
    if (!postUrl) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'url'"
        });
    }

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
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credit(s).`
        });
    }

    let upstreamPayload = { comments: [] };
    let primaryErrorMsg = "";

    try {
        // --- PRIMARY ATTEMPT: GetAnyAPI ---
        const getAnyApiKey = process.env.GETANYAPI_KEY;
        if (!getAnyApiKey) throw new Error("Missing primary API key");

        const getAnyApiBody = {
            url: postUrl
        };
        
        if (cursor) {
            getAnyApiBody.cursor = cursor;
        }

        const primaryResponse = await fetch('https://api.getanyapi.com/v1/run/reddit.post_comments', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${getAnyApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(getAnyApiBody),
            signal: AbortSignal.timeout(8000)
        });

        if (!primaryResponse.ok) {
            throw new Error(`HTTP ${primaryResponse.status}`);
        }

        const primaryData = await primaryResponse.json();

        if (primaryData.output && primaryData.output.found) {
            const data = primaryData.output.data;
            
            const moreObject = data.nextCursor ? { id: data.nextCursor } : null;
            
            upstreamPayload = {
                more: moreObject,
                post: null, 
                comments: data.comments || [],
                cursor: data.nextCursor || null
            };
        } else {
            throw new Error("404 Not Found");
        }

    } catch (primaryError) {
        primaryErrorMsg = primaryError.message;
        
        // --- FALLBACK ATTEMPT: ScrapeCreators ---
        try {
            const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
            if (!upstreamApiKey) throw new Error("Missing fallback API key");

            const targetUrl = new URL('https://api.scrapecreators.com/v1/reddit/post/comments');
            targetUrl.searchParams.append('url', postUrl);
            
            if (cursor) {
                targetUrl.searchParams.append('cursor', cursor);
            }
            if (trim) {
                targetUrl.searchParams.append('trim', 'true');
            }

            const fallbackResponse = await fetch(targetUrl.toString(), {
                method: 'GET',
                headers: {
                    'x-api-key': upstreamApiKey,
                    'Content-Type': 'application/json'
                },
                signal: AbortSignal.timeout(12000)
            });

            const fallbackPayload = await fallbackResponse.json();

            if (!fallbackResponse.ok || fallbackPayload.success === false) {
                const apiErr = fallbackPayload.error ? fallbackPayload.error.toLowerCase() : "";
                if (fallbackResponse.status === 404 || apiErr.includes('not found') || apiErr.includes('invalid url')) {
                    throw new Error("404 Not Found");
                }
                throw new Error(fallbackPayload.error || `HTTP ${fallbackResponse.status}`);
            }

            upstreamPayload = {
                more: fallbackPayload.more || null,
                post: fallbackPayload.post || null,
                comments: fallbackPayload.comments || [],
                cursor: fallbackPayload.cursor || null
            };

        } catch (fallbackError) {
            const isTimeout = fallbackError.name === 'TimeoutError' || primaryError.name === 'TimeoutError';
            const isNotFound = fallbackError.message.includes('404') || primaryErrorMsg.includes('404');
            
            let statusCode = 500;
            let clientErrorMsg = "Internal Server Error: Failed to extract comments at this time.";

            if (isNotFound) {
                statusCode = 404;
                clientErrorMsg = "404 Not Found: The requested post does not exist, was deleted, or the URL is invalid.";
            } else if (isTimeout) {
                statusCode = 504;
                clientErrorMsg = "504 Gateway Timeout: Data extraction took too long to complete. Please try again.";
            }

            if (typeof notifyFailure === 'function') {
                notifyFailure({
                    endpoint: '/v1/reddit/post/comments',
                    params: { postUrl, cursor, trim },
                    statusCode: statusCode,
                    errorMsg: `Primary: ${primaryErrorMsg} | Fallback: ${fallbackError.message}`
                });
            }

            // [NEW] 1. LOG THE FAILURE (Cost = 0)
            await logApiRequest(req, '/v1/reddit/post/comments', 0, { url: postUrl, cursor, trim }, statusCode);

            return res.status(statusCode).json({
                success: false,
                error: clientErrorMsg
            });
        }
    }
    
    const activeCursor = upstreamPayload.cursor || (upstreamPayload.more ? upstreamPayload.more.id : null);

    req.user.credits -= costPerRequest;

    // [NEW] 2. LOG THE SUCCESS (Cost = 1)
    await logApiRequest(req, '/v1/reddit/post/comments', costPerRequest, { url: postUrl, cursor, trim }, 200);

    return res.status(200).json({
        success: true,
        credits_remaining: req.user.credits,
        credits_charged: costPerRequest,
        cursor: activeCursor,
        more: upstreamPayload.more,
        post: upstreamPayload.post,
        comments: upstreamPayload.comments
    });
});


// --- ENDPOINT 5: GLOBAL SEARCH (1 CREDIT) ---
app.get('/v1/reddit/search', authMiddleware, async (req, res) => {
    const query = req.query.q || req.query.query;
    const sort = req.query.sort || 'relevance';
    const timeframe = req.query.timeframe || 'all';
    
    const filter = req.query.filter || 'posts';
    
    const cursor = req.query.cursor || req.query.after || null;
    const trim = req.query.trim === 'true';
    const limit = parseInt(req.query.limit, 10) || 100;

    if (!query) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'q' (or 'query')"
        });
    }

    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credit(s).`
        });
    }

    try {
        const upstreamApiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!upstreamApiKey) throw new Error("Missing ScrapeCreators API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/reddit/search');
        targetUrl.searchParams.append('query', query);
        targetUrl.searchParams.append('sort', sort);
        targetUrl.searchParams.append('timeframe', timeframe);
        
        if (req.query.filter) {
            targetUrl.searchParams.append('filter', filter);
        }

        if (cursor) {
            targetUrl.searchParams.append('after', cursor);
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

        if (!response.ok || upstreamPayload.success === false) {
            throw new Error(`Upstream API Error: ${upstreamPayload.error || response.statusText || 'Failed to execute global search'}`);
        }

        const responseData = {
            cursor: upstreamPayload.after || null,
            posts: upstreamPayload.posts || [],
            comments: upstreamPayload.comments || []
        };
        
        req.user.credits -= costPerRequest;

        // [NEW] 1. LOG THE SUCCESS (Cost = 1)
        await logApiRequest(req, '/v1/reddit/search', costPerRequest, { query, filter, sort, timeframe, cursor, limit, trim }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData 
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : (error.statusCode || 500);
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: Server took too long to respond." 
            : errorMessage;

        if (statusCode >= 500 || statusCode === 403 || statusCode === 429) {
            if (typeof notifyFailure === 'function') {
                notifyFailure({
                    endpoint: '/v1/reddit/search',
                    params: { query, filter, sort, timeframe, cursor, limit, trim },
                    statusCode: statusCode,
                    errorMsg: finalErrorMsg
                });
            }
        }

        // [NEW] 2. LOG THE FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/reddit/search', 0, { query, filter, sort, timeframe, cursor, limit, trim }, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

const { scrapeInstagramProfile } = require('./src/scrapers/instagram');

// --- ENDPOINT 6: INSTAGRAM BASIC PROFILE (1 CREDIT) ---
// --- ENDPOINT 6: INSTAGRAM BASIC PROFILE (1 CREDIT) ---
app.get('/v1/instagram/basic-profile', authMiddleware, async (req, res) => {
    const userId = typeof req.query.userId === 'string' ? req.query.userId.trim() : '';
    const cacheMaxAge = req.query.cache_max_age || '7d';
    const supportedCacheAges = new Set(['1d', '3d', '7d', '14d', '30d']);

    if (!userId) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'userId'."
        });
    }

    if (!supportedCacheAges.has(cacheMaxAge)) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: 'cache_max_age' must be one of 1d, 3d, 7d, 14d, or 30d."
        });
    }

    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credit.`
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error('Missing extraction API Key in environment');
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/instagram/basic-profile');
        targetUrl.searchParams.set('userId', userId);
        targetUrl.searchParams.set('cache_max_age', cacheMaxAge);

        const response = await fetch(targetUrl, {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Accept': 'application/json'
            },
            signal: AbortSignal.timeout(15000)
        });

        let payload;
        try {
            payload = await response.json();
        } catch (parseError) {
            throw new Error(`Extraction server returned invalid JSON (HTTP ${response.status})`);
        }

        if (!response.ok || payload.success === false) {
            const serverError = payload.error || response.statusText || 'Failed to fetch Instagram basic profile';
            const error = new Error(`Server Error: ${serverError}`);
            error.statusCode = response.status;
            throw error;
        }

        const creditsCharged = Number.isFinite(Number(payload.credits_charged))
            ? Number(payload.credits_charged)
            : costPerRequest;

        if (creditsCharged < 0 || creditsCharged > 1) {
            throw new Error('Server returned an invalid credit charge');
        }

        const {
            success,
            credits_remaining: ignoredCreditsRemaining,
            credits_charged: ignoredCreditsCharged,
            ...profileData
        } = payload;

        req.user.credits -= creditsCharged;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/instagram/basic-profile', creditsCharged, { userId, cache_max_age: cacheMaxAge }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: creditsCharged,
            ...profileData
        });
    } catch (error) {
        const statusCode = error.name === 'TimeoutError'
            ? 504
            : (error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500);
            
        // White-labeled timeout message
        const errorMessage = error.name === 'TimeoutError'
            ? '504 Gateway Timeout: The extraction server took too long to respond.'
            : error.message || 'Internal Server Error';

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/instagram/basic-profile',
                params: { userId, cache_max_age: cacheMaxAge },
                statusCode,
                errorMsg: errorMessage
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/instagram/basic-profile', 0, { userId, cache_max_age: cacheMaxAge }, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: errorMessage
        });
    }
});

// --- ENDPOINT 6: INSTAGRAM PROFILE (1 CREDIT) ---
app.get('/v1/instagram/profile', authMiddleware, async (req, res) => {
    const rawInput = req.query.username || req.query.user || req.query.handle;
    const trim = req.query.trim === 'true';
    const cacheMaxAge = req.query.cache_max_age || '7d';

    if (!rawInput) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'username' or 'handle'"
        });
    }

    let cleanHandle = rawInput.trim().replace('@', '').split('?')[0].replace(/\/$/, '').toLowerCase();
    if (cleanHandle.includes('instagram.com/')) {
        cleanHandle = cleanHandle.split('instagram.com/')[1].split('/')[0];
    }

    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credit(s).`
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/instagram/profile');
        targetUrl.searchParams.append('handle', cleanHandle);
        targetUrl.searchParams.append('cache_max_age', cacheMaxAge);
        
        if (trim) {
            targetUrl.searchParams.append('trim', 'true');
        }

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(15000)
        });

        const payload = await response.json();

        if (!response.ok || payload.success === false) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch Instagram profile'}`);
        }

        const responseData = {
            user: payload.data?.user || payload.user || null
        };
        
        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/instagram/profile', costPerRequest, { handle: cleanHandle, trim, cache_max_age: cacheMaxAge }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            cursor: payload.cursor || null,
            ...responseData 
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : (error.statusCode || 500);
        
        // White-labeled timeout message
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : errorMessage;

        if (statusCode >= 500 || statusCode === 403 || statusCode === 429) {
            if (typeof notifyFailure === 'function') {
                notifyFailure({
                    endpoint: '/v1/instagram/profile',
                    params: { handle: cleanHandle, trim, cache_max_age: cacheMaxAge },
                    statusCode: statusCode,
                    errorMsg: finalErrorMsg
                });
            }
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/instagram/profile', 0, { handle: cleanHandle, trim, cache_max_age: cacheMaxAge }, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
}); 

// --- EXPRESS ROUTE: INSTAGRAM USER POSTS (v2 ARBITRAGE) ---
app.get('/v1/instagram/user/posts', authMiddleware, async (req, res) => {
    const handle = req.query.handle || req.query.username;
    const cursor = req.query.next_max_id || req.query.cursor || null;
    const trim = req.query.trim === 'true';

    if (!handle) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'handle'" 
        });
    }

    let cleanHandle = handle.split('?')[0].replace(/\/$/, '').replace('@', '');
    if (cleanHandle.includes('instagram.com/')) {
        cleanHandle = cleanHandle.split('instagram.com/')[1].split('/')[0];
    }

    const costPerRequest = 1; 

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

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
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(15000)
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch user posts'}`);
        }

        const responseData = {
            user: payload.user || null,
            post_count: payload.num_results || (payload.items ? payload.items.length : 0),
            has_more: payload.more_available || false,
            next_cursor: payload.next_max_id || null, 
            posts: payload.items || [] 
        };

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/instagram/user/posts', costPerRequest, { handle: cleanHandle, cursor, trim }, 200);

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
        
        // White-labeled timeout message
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : errorMessage;

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/instagram/user/posts',
                params: { handle: cleanHandle, next_max_id: cursor, trim },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/instagram/user/posts', 0, { handle: cleanHandle, cursor, trim }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

// --- EXPRESS ROUTE: INSTAGRAM USER HIGHLIGHTS (ARBITRAGE) ---
// --- ENDPOINT 7: INSTAGRAM USER HIGHLIGHTS (2 CREDITS) ---
app.get('/v1/instagram/user/highlights', authMiddleware, async (req, res) => {
    const userId = req.query.user_id;
    const handle = req.query.handle || req.query.username;

    if (!userId && !handle) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. Provide either 'user_id' or 'handle'." 
        });
    }

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

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/instagram/user/highlights');
        
        if (userId) {
            targetUrl.searchParams.append('user_id', userId);
        } else if (cleanHandle) {
            targetUrl.searchParams.append('handle', cleanHandle);
        }

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(15000)
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch highlights'}`);
        }

        const highlights = payload.highlights || (payload.data && payload.data.highlights) || [];

        const responseData = {
            highlights_count: highlights.length,
            highlights: highlights
        };

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/instagram/user/highlights', costPerRequest, { user_id: userId, handle: cleanHandle }, 200);

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
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : errorMessage;

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/instagram/user/highlights',
                params: { user_id: userId, handle: cleanHandle },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/instagram/user/highlights', 0, { user_id: userId, handle: cleanHandle }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- ENDPOINT 8: INSTAGRAM SINGLE POST ---
app.get('/v1/instagram/post', authMiddleware, async (req, res) => {
    const { shortcode, region, trim, download_media, cache_max_age } = req.query;

    if (!shortcode) {
        return res.status(400).json({ success: false, error: "400 Bad Request: Missing required parameter 'shortcode'" });
    }

    const isDownloadRequested = String(download_media).toLowerCase() === 'true';
    const maxExpectedCost = isDownloadRequested ? 10 : 1;
    
    if (req.user.credits < maxExpectedCost) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires up to ${maxExpectedCost} credits.`
        });
    }

    const targetUrl = shortcode.startsWith('http')
        ? shortcode
        : `https://www.instagram.com/p/${shortcode}/`;

    let primaryError;
    
    // --- PRIMARY ENGINE ---
    try {
        const primaryApiKey = process.env.GETANYAPI_KEY;
        if (!primaryApiKey) throw new Error('Missing primary API key in environment');

        const response = await fetch('https://api.getanyapi.com/v1/run/instagram.post', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${primaryApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ url: targetUrl, ...(isDownloadRequested ? { hostVideo: true } : {}) }),
            signal: AbortSignal.timeout(20000)
        });
        
        const payload = await response.json();
        
        if (!response.ok) {
            const error = new Error(`Extraction Error: ${payload.error || response.statusText || 'Failed to fetch Instagram post'}`);
            error.statusCode = response.status;
            throw error;
        }

        const actualCreditsCharged = isDownloadRequested ? 10 : 1;
        req.user.credits -= actualCreditsCharged;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/instagram/post', actualCreditsCharged, { shortcode, region, trim, download_media, cache_max_age }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCreditsCharged,
            status: 'success',
            data: payload.output?.data || null
        });
    } catch (error) {
        primaryError = error;
        console.error('[SignalQub] Primary extraction engine failed:', error.message);
    }

    // --- FALLBACK ENGINE ---
    try {
        const fallbackUrl = new URL('https://api.scrapecreators.com/v1/instagram/post');
        fallbackUrl.searchParams.set('url', targetUrl);
        if (region) fallbackUrl.searchParams.set('region', region);
        if (trim) fallbackUrl.searchParams.set('trim', trim);
        if (download_media) fallbackUrl.searchParams.set('download_media', download_media);
        if (cache_max_age) fallbackUrl.searchParams.set('cache_max_age', cache_max_age);

        const response = await fetch(fallbackUrl, {
            method: 'GET',
            headers: {
                'x-api-key': process.env.SCRAPE_CREATORS_API_KEY,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000)
        });
        
        const payload = await response.json();
        
        if (!response.ok || !payload.success) {
            const error = new Error(payload.detail || payload.message || payload.error || 'Failed to fetch Instagram post');
            error.statusCode = response.status === 200 ? 500 : response.status;
            throw error;
        }

        const actualCreditsCharged = payload.credits_charged || 1;
        req.user.credits -= actualCreditsCharged;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/instagram/post', actualCreditsCharged, { shortcode, region, trim, download_media, cache_max_age }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCreditsCharged,
            status: 'success',
            data: payload.data
        });
    } catch (fallbackError) {
        const isTimeout = fallbackError.name === 'TimeoutError' || primaryError?.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : (fallbackError.statusCode || 500);
        
        // White-labeled
        const errorMessage = isTimeout
            ? '504 Gateway Timeout: All extraction servers took too long to respond.'
            : `500 Internal Server Error: The extraction failed. (${fallbackError.message})`;

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/instagram/post',
                params: { shortcode, region, trim, download_media, cache_max_age },
                statusCode,
                errorMsg: `Primary Engine: ${primaryError?.message || 'unknown'} | Fallback Engine: ${fallbackError.message}`
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/instagram/post', 0, { shortcode, region, trim, download_media, cache_max_age }, statusCode);

        return res.status(statusCode).json({ success: false, error: errorMessage });
    }
});


// --- ENDPOINT 9: INSTAGRAM POST (LEGACY) ---
app.get('/v1/instagram/post-legacy', authMiddleware, async (req, res) => {
    const { shortcode, region, trim, download_media, cache_max_age } = req.query;

    if (!shortcode) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'shortcode'" 
        });
    }

    const isDownloadRequested = String(download_media).toLowerCase() === 'true';
    const maxExpectedCost = isDownloadRequested ? 10 : 1;

    if (req.user.credits < maxExpectedCost) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires up to ${maxExpectedCost} credits.`
        });
    }

    const serverUrl = new URL('https://api.scrapecreators.com/v1/instagram/post');
    
    let targetUrl = shortcode;
    if (!shortcode.startsWith('http')) {
        targetUrl = `https://www.instagram.com/p/${shortcode}/`;
    }
    
    serverUrl.searchParams.append('url', targetUrl);
    if (region) serverUrl.searchParams.append('region', region);
    if (trim) serverUrl.searchParams.append('trim', trim);
    if (download_media) serverUrl.searchParams.append('download_media', download_media);
    if (cache_max_age) serverUrl.searchParams.append('cache_max_age', cache_max_age);

    try {
        console.log(`[SignalQub] Calling extraction server for: ${targetUrl}`);

        const response = await fetch(serverUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': process.env.SCRAPE_CREATORS_API_KEY, 
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const payload = await response.json();
        
        console.log(`[Extraction Response] Status: ${response.status}`, JSON.stringify(payload).substring(0, 250));

        if (!response.ok || !payload.success) {
            const statusCode = response.status === 200 ? 500 : response.status;
            const rawError = payload.detail || payload.message || payload.error || "Unknown extraction error occurred.";
            
            let cleanErrorMsg = "500 Internal Server Error: Extraction failed. The engineering team has been notified.";

            if (statusCode === 404) {
                cleanErrorMsg = "404 Not Found: The requested Instagram post does not exist, was deleted, or the account is private.";
            } else if (statusCode === 429) {
                cleanErrorMsg = "429 Too Many Requests: Extraction rate limit exceeded. Please back off and retry.";
            } else if (statusCode === 400 || statusCode === 422 || statusCode === 401 || statusCode === 403) {
                // Completely swap out any provider branding
                cleanErrorMsg = `${statusCode} Error: ${rawError.replace(/scrapecreators|upstream|provider/ig, 'SignalQub')}`;
            } else if (statusCode >= 500) {
                cleanErrorMsg = "500 Internal Server Error: Instagram anti-bot protection triggered. Please try again in a few moments.";
            }

            // [NEW] LOG FAILURE (Cost = 0) BEFORE EARLY RETURN
            await logApiRequest(req, '/v1/instagram/post-legacy', 0, { shortcode, region, trim, download_media, cache_max_age }, statusCode);

            return res.status(statusCode).json({
                success: false,
                error: cleanErrorMsg
            });
        }

        const actualCreditsCharged = payload.credits_charged || 1;
        req.user.credits -= actualCreditsCharged;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/instagram/post-legacy', actualCreditsCharged, { shortcode, region, trim, download_media, cache_max_age }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCreditsCharged,
            status: "success",
            data: payload.data 
        });

    } catch (error) {
        console.error('[SignalQub] Extraction Error:', error);
        
        const isTimeout = error.name === 'TimeoutError' || error.message === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction engine took too long to respond." 
            : `500 Internal Server Error: The extraction failed. (${error.message})`;

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/instagram/post-legacy', 0, { shortcode, region, trim, download_media, cache_max_age }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg
        });
    }
});


// --- ENDPOINT 10: INSTAGRAM TRANSCRIPT ---
app.get('/v1/instagram/transcript', authMiddleware, async (req, res) => {
    const { shortcode, cache_max_age } = req.query;

    if (!shortcode) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'shortcode'" 
        });
    }

    const costPerRequest = 2;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. Transcripts require ${costPerRequest} credits.`
        });
    }

    const serverUrl = new URL('https://api.scrapecreators.com/v2/instagram/media/transcript');
    
    let targetUrl = shortcode;
    if (!shortcode.startsWith('http')) {
        targetUrl = `https://www.instagram.com/p/${shortcode}/`;
    }
    
    serverUrl.searchParams.append('url', targetUrl);
    if (cache_max_age) serverUrl.searchParams.append('cache_max_age', cache_max_age);

    try {
        console.log(`[SignalQub] Requesting AI Transcript for: ${targetUrl}`);

        const response = await fetch(serverUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': process.env.SCRAPE_CREATORS_API_KEY,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(35000) 
        });

        const payload = await response.json();

        console.log(`[Server Transcript] Status: ${response.status}`, JSON.stringify(payload).substring(0, 200));

        if (!response.ok || !payload.success) {
            const statusCode = response.status === 200 ? 500 : response.status;
            const rawError = payload.detail || payload.message || payload.error || "Failed to generate transcript.";
            
            let cleanErrorMsg = "500 Internal Server Error: AI Transcription failed. The engineering team has been notified.";

            if (statusCode === 404) {
                cleanErrorMsg = "404 Not Found: The requested video does not exist or the account is private.";
            } else if (statusCode === 429) {
                cleanErrorMsg = "429 Too Many Requests: Rate limit exceeded. Please back off and retry.";
            } else if (statusCode === 400 || statusCode === 422 || statusCode === 401 || statusCode === 403) {
                // White-label regex swap
                cleanErrorMsg = `${statusCode} Error: ${rawError.replace(/scrapecreators|upstream|provider/ig, 'SignalQub')}`;
            } else if (statusCode >= 500) {
                cleanErrorMsg = "500 Internal Server Error: Video extraction or transcription process failed. Please ensure the video is under 2 minutes.";
            }

            // [NEW] LOG FAILURE (Cost = 0) BEFORE EARLY RETURN
            await logApiRequest(req, '/v1/instagram/transcript', 0, { shortcode, cache_max_age }, statusCode);

            return res.status(statusCode).json({
                success: false,
                error: cleanErrorMsg
            });
        }

        const formattedTranscripts = (payload.transcripts || []).map(t => ({
            id: t.id,
            type: 'video', 
            transcript: t.text || null
        }));

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/instagram/transcript', costPerRequest, { shortcode, cache_max_age }, 200);

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
        
        const isTimeout = error.name === 'TimeoutError' || error.message === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        
        // White-labeled
        const errorMsg = isTimeout 
            ? "504 Gateway Timeout: The AI transcription engine took too long to respond. The video may be too long or the queue is full."
            : `500 Internal Server Error: ${error.message}`;

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/instagram/transcript', 0, { shortcode, cache_max_age }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: errorMsg 
        });
    }
});

// --- 2. EXPRESS ROUTE ---
// --- EXPRESS ROUTE: INSTAGRAM ARBITRAGE SEARCH ---
// --- EXPRESS ROUTE: INSTAGRAM ARBITRAGE SEARCH ---
// --- EXPRESS ROUTE: INSTAGRAM SEARCH ---
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

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/instagram/search');
        targetUrl.searchParams.append('query', query);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(15000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Unknown Error'}`);
        }

        const scrapedContent = payload.data !== undefined ? payload.data : payload;

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/instagram/search', costPerRequest, { query }, 200);

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
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : errorMessage;

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/instagram/search',
                params: { query },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/instagram/search', 0, { query }, statusCode);

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

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/instagram/user/tagged-posts');
        targetUrl.searchParams.append('user_id', userId);
        if (cursor) {
            targetUrl.searchParams.append('cursor', cursor);
        }

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(15000)
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch tagged posts'}`);
        }

        const posts = payload.posts || (payload.data && payload.data.posts) || [];
        const nextCursor = payload.cursor || (payload.data && payload.data.cursor) || null;
        const hasMore = payload.has_more ?? (payload.data && payload.data.has_more) ?? false;

        const responseData = {
            posts: posts,
            cursor: nextCursor,
            has_more: hasMore
        };

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/instagram/user/tagged-posts', costPerRequest, { user_id: userId, cursor }, 200);

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
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : errorMessage;

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/instagram/user/tagged-posts',
                params: { user_id: userId, cursor },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/instagram/user/tagged-posts', 0, { user_id: userId, cursor }, statusCode);

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
    const includeReplies = req.query.include_replies === 'true'; 

    if (!postUrl) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'url'"
        });
    }

    const costPerRequest = includeReplies ? 15 : 2;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v2/instagram/post/comments');
        targetUrl.searchParams.append('url', postUrl);
        
        if (cursor) {
            targetUrl.searchParams.append('cursor', cursor);
        }
        if (includeReplies) {
            targetUrl.searchParams.append('include_replies', 'true');
        }

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(35000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch comments'}`);
        }

        const comments = payload.comments || (payload.data && payload.data.comments) || [];
        const nextCursor = payload.cursor || (payload.data && payload.data.cursor) || null;

        const responseData = {
            comments: comments,
            cursor: nextCursor
        };

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/instagram/post/comments', costPerRequest, { url: postUrl, cursor, include_replies: includeReplies }, 200);

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
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond. This is common when include_replies=true." 
            : errorMessage;

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/instagram/post/comments',
                params: { url: postUrl, cursor, include_replies: includeReplies },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/instagram/post/comments', 0, { url: postUrl, cursor, include_replies: includeReplies }, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

// --- 2. EXPRESS ROUTE ---

// --- 2. EXPRESS ROUTE ---
// --- EXPRESS ROUTE: YOUTUBE CHANNEL INFO ---
// --- EXPRESS ROUTE: YOUTUBE CHANNEL INFO ---
app.get('/v1/youtube/channel', authMiddleware, async (req, res) => {
    const { channelId, handle, url, q, cache_max_age } = req.query;

    let targetParamKey = null;
    let targetParamValue = null;

    if (channelId) {
        targetParamKey = 'channelId';
        targetParamValue = channelId.trim();
    } else if (handle) {
        targetParamKey = 'handle';
        targetParamValue = handle.trim().startsWith('@') ? handle.trim() : `@${handle.trim()}`;
    } else if (url) {
        targetParamKey = 'url';
        targetParamValue = url.trim();
    } else if (q) {
        const rawQ = q.trim();
        if (rawQ.startsWith('http')) {
            targetParamKey = 'url';
        } else if (rawQ.startsWith('@')) {
            targetParamKey = 'handle';
        } else if (rawQ.startsWith('UC') && rawQ.length === 24) {
            targetParamKey = 'channelId';
        } else {
            targetParamKey = 'handle';
        }
        targetParamValue = rawQ;
    }

    if (!targetParamValue) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter (channelId, handle, or url)"
        });
    }

    const baseCostToUser = 1;

    if (req.user.credits < baseCostToUser) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires up to ${baseCostToUser} credit(s).`
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/youtube/channel');
        targetUrl.searchParams.append(targetParamKey, targetParamValue);
        
        if (cache_max_age) targetUrl.searchParams.append('cache_max_age', cache_max_age);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000)
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch YouTube channel info'}`
            );
        }

        // Separate billing/cache metadata from the raw channel data
        const { success, credits_remaining, credits_charged, cached, cached_at, ...channelData } = payload;

        const responseData = {
            cached: cached || false,
            cached_at: cached_at || null,
            ...channelData
        };

        // Pass 0-cost savings to the user if it was a cache hit upstream
        const actualCost = credits_charged === 0 ? 0 : baseCostToUser;
        req.user.credits -= actualCost;

        const requestParamsLog = { [targetParamKey]: targetParamValue, cache_max_age };

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/youtube/channel', actualCost, requestParamsLog, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch the channel data." 
            : error.message;

        const requestParamsLog = { [targetParamKey]: targetParamValue, cache_max_age };

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/channel',
                params: requestParamsLog,
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/youtube/channel', 0, requestParamsLog, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});


// --- EXPRESS ROUTE: YOUTUBE CHANNEL VIDEOS ---
app.get('/v1/youtube/channel/videos', authMiddleware, async (req, res) => {
    const { 
        channelId, 
        handle, 
        sort, 
        continuationToken, 
        is_paid_promotions, 
        includeExtras 
    } = req.query;

    if (!channelId && !handle) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'channelId' or 'handle'"
        });
    }

    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    try {
        const apiKey = process.env.GETANYAPI_KEY;
        if (!apiKey) throw new Error("Missing extraction API key in environment");

        const extractionInput = {
            ...(channelId ? { channelId: channelId.trim() } : {}),
            ...(handle ? { handle: handle.trim().startsWith('@') ? handle.trim() : `@${handle.trim()}` } : {}),
            ...(sort ? { sort } : {}),
            ...(continuationToken ? { cursor: continuationToken } : {})
        };

        const response = await fetch('https://api.getanyapi.com/v1/run/youtube.channel_videos', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(extractionInput),
            signal: AbortSignal.timeout(35000)
        });

        let payload;
        try {
            payload = await response.json();
        } catch (parseError) {
            throw new Error(`Extraction server returned invalid JSON (HTTP ${response.status})`);
        }

        if (!response.ok) {
            const serverError = payload.error || response.statusText || 'Failed to fetch channel videos';
            const error = new Error(`Server Error: ${serverError}`);
            error.statusCode = response.status;
            throw error;
        }

        const output = payload.output || {};
        const videosData = output.data || {};

        const responseData = {
            videos: videosData.videos || [],
            continuationToken: videosData.nextCursor || null
        };

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/youtube/channel/videos', costPerRequest, { channelId, handle, sort, continuationToken, is_paid_promotions, includeExtras }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            found: output.found ?? false,
            ...responseData,
            ...(output.reason ? { reason: output.reason } : {})
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout
            ? 504
            : (error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500);
        
        // White-labeled
        let finalErrorMsg = isTimeout ? "504 Gateway Timeout: The extraction server took too long to respond." : errorMessage;
        if (isTimeout && includeExtras === 'true') {
            finalErrorMsg += " Note: The includeExtras flag is known to increase latency and error rates.";
        }

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/channel/videos',
                params: { channelId, handle, sort, continuationToken, is_paid_promotions, includeExtras },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/youtube/channel/videos', 0, { channelId, handle, sort, continuationToken, is_paid_promotions, includeExtras }, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});


// --- EXPRESS ROUTE: YOUTUBE CHANNEL PLAYLISTS ---
app.get('/v1/youtube/channel/playlists', authMiddleware, async (req, res) => {
    const { 
        channelId, 
        handle, 
        continuationToken 
    } = req.query;

    if (!channelId && !handle) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'channelId' or 'handle'"
        });
    }

    const costPerRequest = 2;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/youtube/channel/playlists');
        
        if (channelId) targetUrl.searchParams.append('channelId', channelId);
        if (handle) targetUrl.searchParams.append('handle', handle);
        if (continuationToken) targetUrl.searchParams.append('continuationToken', continuationToken);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(35000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch channel playlists'}`);
        }

        const playlists = payload.playlists || [];
        const nextToken = payload.continuationToken || null;

        const responseData = {
            playlists: playlists,
            continuationToken: nextToken
        };

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/youtube/channel/playlists', costPerRequest, { channelId, handle, continuationToken }, 200);

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
        
        // White-labeled
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: The extraction server took too long to respond." : errorMessage;

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/channel/playlists',
                params: { channelId, handle, continuationToken },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/youtube/channel/playlists', 0, { channelId, handle, continuationToken }, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});


// --- EXPRESS ROUTE: YOUTUBE CHANNEL LIVES ---
app.get('/v1/youtube/channel/lives', authMiddleware, async (req, res) => {
    const { 
        channelId, 
        handle, 
        continuationToken 
    } = req.query;

    if (!channelId && !handle) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'channelId' or 'handle'"
        });
    }

    const costPerRequest = 2;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/youtube/channel/lives');
        
        if (channelId) targetUrl.searchParams.append('channelId', channelId);
        if (handle) targetUrl.searchParams.append('handle', handle);
        if (continuationToken) targetUrl.searchParams.append('continuationToken', continuationToken);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(35000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch channel lives'}`);
        }

        const lives = payload.lives || [];
        const nextToken = payload.continuationToken || null;

        const responseData = {
            lives: lives,
            continuationToken: nextToken
        };

        req.user.credits -= costPerRequest;
        
        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/youtube/channel/lives', costPerRequest, { channelId, handle, continuationToken }, 200);

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
        
        // White-labeled
        const finalErrorMsg = isTimeout ? "504 Gateway Timeout: The extraction server took too long to respond." : errorMessage;

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/channel/lives',
                params: { channelId, handle, continuationToken },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/youtube/channel/lives', 0, { channelId, handle, continuationToken }, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

// --- EXPRESS ROUTE: YOUTUBE CHANNEL COMMUNITY POSTS ---
app.get('/v1/youtube/channel/community-posts', authMiddleware, async (req, res) => {
    const { 
        channelId, 
        handle, 
        continuationToken 
    } = req.query;

    if (!channelId && !handle) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'channelId' or 'handle'"
        });
    }

    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/youtube/channel/community-posts');
        
        if (channelId) targetUrl.searchParams.append('channelId', channelId);
        if (handle) targetUrl.searchParams.append('handle', handle);
        if (continuationToken) targetUrl.searchParams.append('continuationToken', continuationToken);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(35000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch community posts'}`);
        }

        const posts = payload.posts || [];
        const nextToken = payload.continuationToken || null;

        const responseData = {
            posts: posts,
            continuationToken: nextToken
        };

        req.user.credits -= costPerRequest;
        
        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/youtube/channel/community-posts', costPerRequest, { channelId, handle, continuationToken }, 200);

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
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : errorMessage;

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/channel/community-posts',
                params: { channelId, handle, continuationToken },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/youtube/channel/community-posts', 0, { channelId, handle, continuationToken }, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});


// --- EXPRESS ROUTE: YOUTUBE CHANNEL SHORTS ---
app.get('/v1/youtube/channel/shorts', authMiddleware, async (req, res) => {
    const { 
        channelId, 
        handle, 
        sort,
        continuationToken 
    } = req.query;

    if (!channelId && !handle) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'channelId' or 'handle'"
        });
    }

    const costPerRequest = 2;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/youtube/channel/shorts');
        
        if (channelId) targetUrl.searchParams.append('channelId', channelId);
        if (handle) targetUrl.searchParams.append('handle', handle);
        if (sort) targetUrl.searchParams.append('sort', sort);
        if (continuationToken) targetUrl.searchParams.append('continuationToken', continuationToken);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(35000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch shorts'}`);
        }

        const shorts = payload.shorts || [];
        const nextToken = payload.continuationToken || null;

        const responseData = {
            shorts: shorts,
            continuationToken: nextToken
        };

        req.user.credits -= costPerRequest;
        
        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/youtube/channel/shorts', costPerRequest, { channelId, handle, sort, continuationToken }, 200);

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
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : errorMessage;

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/channel/shorts',
                params: { channelId, handle, sort, continuationToken },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/youtube/channel/shorts', 0, { channelId, handle, sort, continuationToken }, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});


// --- EXPRESS ROUTE: YOUTUBE SINGLE VIDEO ---
app.get('/v1/youtube/video', authMiddleware, async (req, res) => {
    const { url, language, cache_max_age } = req.query;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'url'"
        });
    }

    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/youtube/video');
        targetUrl.searchParams.append('url', url);
        
        if (language) targetUrl.searchParams.append('language', language);
        if (cache_max_age) targetUrl.searchParams.append('cache_max_age', cache_max_age);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Accept': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
            const errorMessage = data.error || data.reason || "Extraction failed.";
            const statusCode = response.status === 200 ? 500 : response.status; 
            
            throw new Error(`${statusCode} Server Error: ${errorMessage}`);
        }

        const { success, credits_remaining, credits_charged, ...videoData } = data;

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/youtube/video', costPerRequest, { url, language, cache_max_age }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...videoData 
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message === 'TimeoutError';
        
        // White-labeled
        const errorMessage = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : (error.message || "500 Internal Server Error");
        
        const statusCodeMatch = errorMessage.match(/^(\d{3})/);
        const statusCode = isTimeout ? 504 : (statusCodeMatch ? parseInt(statusCodeMatch[1], 10) : 500);

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/video',
                params: { url, language },
                statusCode: statusCode,
                errorMsg: errorMessage
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/youtube/video', 0, { url, language, cache_max_age }, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: errorMessage
        });
    }
});

// --- EXPRESS ROUTE: YOUTUBE TRANSCRIPT ---
app.get('/v1/youtube/transcript', authMiddleware, async (req, res) => {
    const { url, language, cache_max_age } = req.query;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'url'"
        });
    }

    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. Transcripts require ${costPerRequest} credits.`
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/youtube/video/transcript');
        targetUrl.searchParams.append('url', url);
        
        if (language) targetUrl.searchParams.append('language', language);
        if (cache_max_age) targetUrl.searchParams.append('cache_max_age', cache_max_age);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(35000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            const errorMsg = payload.error || response.statusText;
            const statusCode = response.status;
            
            if (statusCode === 404 || (errorMsg && errorMsg.toLowerCase().includes('not available'))) {
                 throw new Error("404 Not Found: No transcript or captions available for this video.");
            }

            throw new Error(`Server Error: ${errorMsg || 'Failed to fetch transcript'}`);
        }

        const responseData = { ...payload };
        delete responseData.success;
        delete responseData.credits_remaining;
        delete responseData.credits_charged;

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/youtube/transcript', costPerRequest, { url, language, cache_max_age }, 200);

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
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : errorMessage;

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/transcript',
                params: { url, language, cache_max_age },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/youtube/transcript', 0, { url, language, cache_max_age }, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});


// --- EXPRESS ROUTE: YOUTUBE SEARCH ---
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

    if (!query) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'query'"
        });
    }

    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    try {
        const apiKey = process.env.GETANYAPI_KEY;
        if (!apiKey) throw new Error("Missing extraction API key in environment");

        const extractionInput = {
            query: query.trim(),
            ...(uploadDate ? { uploadDate } : {}),
            ...(sortBy ? { sortBy } : {}),
            ...(continuationToken ? { cursor: continuationToken } : {})
        };

        const response = await fetch('https://api.getanyapi.com/v1/run/youtube.search', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(extractionInput),
            signal: AbortSignal.timeout(35000)
        });

        let payload;
        try {
            payload = await response.json();
        } catch (parseError) {
            throw new Error(`Extraction server returned invalid JSON (HTTP ${response.status})`);
        }

        if (!response.ok) {
            const serverError = payload.error || response.statusText || 'Failed to fetch search results';
            const error = new Error(`Server Error: ${serverError}`);
            error.statusCode = response.status;
            throw error;
        }

        const output = payload.output || {};
        const searchData = output.data || {};

        const responseData = {
            videos: searchData.videos || [],
            channels: [],
            playlists: [],
            shorts: [],
            shelves: [],
            lives: [],
            continuationToken: searchData.nextCursor || null
        };

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/youtube/search', costPerRequest, { query, uploadDate, sortBy, type, duration, region, continuationToken, includeExtras }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            found: output.found ?? false,
            ...responseData,
            ...(output.reason ? { reason: output.reason } : {})
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout
            ? 504
            : (error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500);
        
        // White-labeled
        let finalErrorMsg = isTimeout ? "504 Gateway Timeout: The extraction server took too long to respond." : errorMessage;

        if (isTimeout && includeExtras === 'true') {
            finalErrorMsg += " Note: The 'includeExtras' flag requires additional scraping and increases latency.";
        }

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/search',
                params: { query, uploadDate, sortBy, type, duration, region, includeExtras, continuationToken },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/youtube/search', 0, { query, uploadDate, sortBy, type, duration, region, continuationToken, includeExtras }, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});


// --- EXPRESS ROUTE: YOUTUBE VIDEO COMMENTS ---
app.get('/v1/youtube/video/comments', authMiddleware, async (req, res) => {
    const { 
        url, 
        continuationToken, 
        order 
    } = req.query;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'url'"
        });
    }

    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/youtube/video/comments');
        targetUrl.searchParams.append('url', url);
        
        if (continuationToken) targetUrl.searchParams.append('continuationToken', continuationToken);
        if (order) targetUrl.searchParams.append('order', order);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(35000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            if (response.status === 403 || (payload.error && payload.error.toLowerCase().includes('disabled'))) {
                throw new Error("403 Forbidden: Comments are disabled for this video.");
            }
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch comments'}`);
        }

        const responseData = {
            comments: payload.comments || [],
            continuationToken: payload.continuationToken || null
        };

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/youtube/video/comments', costPerRequest, { url, continuationToken, order }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const errorMessage = error.message || "Internal Server Error";
        
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = errorMessage.includes('403') ? 403 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : errorMessage;

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/youtube/video/comments',
                params: { url, order, continuationToken },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/youtube/video/comments', 0, { url, continuationToken, order }, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

// --- EXPRESS ROUTE: GOOGLE SEARCH ---
app.get('/v1/google/search', authMiddleware, async (req, res) => {
    const { 
        query, 
        region, 
        date_posted, 
        page 
    } = req.query;

    if (!query) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'query'"
        });
    }

    const pageNum = parseInt(page || 1, 10);
    if (pageNum < 1 || pageNum > 11) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Page number must be between 1 and 11."
        });
    }

    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/google/search');
        targetUrl.searchParams.append('query', query);
        
        if (region) targetUrl.searchParams.append('region', region);
        if (date_posted) targetUrl.searchParams.append('date_posted', date_posted);
        if (page) targetUrl.searchParams.append('page', page);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch search results'}`);
        }

        const responseData = {
            results: payload.results || []
        };

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/google/search', costPerRequest, { query, region, date_posted, page }, 200);

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
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : errorMessage;

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/google/search',
                params: { query, region, date_posted, page },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/google/search', 0, { query, region, date_posted, page }, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});


// --- EXPRESS ROUTE: TIKTOK KEYWORD SEARCH ---
app.get('/v1/tiktok/search/keyword', authMiddleware, async (req, res) => {
    const { query, date_posted, sort_by, region, cursor, trim } = req.query;

    if (!query || query.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'query'." 
        });
    }

    const costPerRequest = 1;
    if (req.user.credits < costPerRequest) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credit.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/search/keyword');
        targetUrl.searchParams.append('query', query.trim());
        
        if (date_posted) targetUrl.searchParams.append('date_posted', date_posted);
        if (sort_by) targetUrl.searchParams.append('sort_by', sort_by);
        if (region) targetUrl.searchParams.append('region', region);
        if (cursor) targetUrl.searchParams.append('cursor', cursor);
        if (trim) targetUrl.searchParams.append('trim', trim);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to search keyword'}`);
        }

        const rawVideoList = Array.isArray(payload.search_item_list) ? payload.search_item_list : [];
        
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
            cursor: payload.cursor ?? null,
            has_more: !!payload.has_more,
            videos: trimmedVideos
        };

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/tiktok/search/keyword', costPerRequest, { query, date_posted, sort_by, region, cursor, trim }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : error.message;
        
        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/search/keyword', 
                params: { query, cursor }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/tiktok/search/keyword', 0, { query, date_posted, sort_by, region, cursor, trim }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: TIKTOK USERS SEARCH ---
app.get('/v1/tiktok/search/users', authMiddleware, async (req, res) => {
    const { query, cursor, trim } = req.query;

    if (!query || query.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'query'." 
        });
    }

    const costPerRequest = 1;
    if (req.user.credits < costPerRequest) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credit.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/search/users');
        targetUrl.searchParams.append('query', query.trim());
        
        if (cursor) targetUrl.searchParams.append('cursor', cursor);
        if (trim) targetUrl.searchParams.append('trim', trim);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to search users'}`);
        }

        const rawUserList = Array.isArray(payload.user_list) ? payload.user_list : [];
        
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
            cursor: payload.cursor ?? null,
            has_more: !!payload.has_more,
            users: trimmedUsers
        };

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/tiktok/search/users', costPerRequest, { query, cursor, trim }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : error.message;
        
        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/search/users', 
                params: { query, cursor }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/tiktok/search/users', 0, { query, cursor, trim }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

// --- EXPRESS ROUTE: TIKTOK USER FOLLOWERS ---
app.get('/v1/tiktok/user/followers', authMiddleware, async (req, res) => {
    const { handle, user_id, min_time, trim } = req.query;

    if (!handle && !user_id) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'handle' or 'user_id'." 
        });
    }

    const minimumRequiredCredits = 2;
    if (req.user.credits < minimumRequiredCredits) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${minimumRequiredCredits} credits.` 
        });
    }

    const identifier = handle ? handle.replace('@', '').toLowerCase().trim() : `uid_${user_id}`;

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/user/followers');
        
        if (handle) targetUrl.searchParams.append('handle', identifier);
        if (user_id) targetUrl.searchParams.append('user_id', user_id);
        if (min_time) targetUrl.searchParams.append('min_time', min_time);
        if (trim) targetUrl.searchParams.append('trim', trim);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch follower list'}`);
        }

        const responseData = {
            has_more: payload.has_more || false,
            min_time: payload.min_time || 0,
            max_time: payload.max_time || 0,
            total: payload.total || 0,
            next_page_token: payload.next_page_token || null,
            followers: payload.followers || []
        };

        const upstreamCost = payload.credits_charged || 1;
        const finalCostToUser = upstreamCost * 2;

        req.user.credits -= finalCostToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/tiktok/user/followers', finalCostToUser, { handle: identifier, user_id, min_time, trim }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: finalCostToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message === 'TimeoutError';
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : error.message;
        
        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/user/followers', 
                params: { handle: identifier, user_id, min_time, trim }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/tiktok/user/followers', 0, { handle: identifier, user_id, min_time, trim }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: TIKTOK USER FOLLOWING ---
app.get('/v1/tiktok/user/following', authMiddleware, async (req, res) => {
    const { handle, min_time, trim } = req.query;

    if (!handle) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'handle'." 
        });
    }

    const minimumRequiredCredits = 2;
    if (req.user.credits < minimumRequiredCredits) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${minimumRequiredCredits} credits.` 
        });
    }

    const identifier = handle.replace('@', '').toLowerCase().trim();

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/user/following');
        targetUrl.searchParams.append('handle', identifier);
        
        if (min_time) targetUrl.searchParams.append('min_time', min_time);
        if (trim) targetUrl.searchParams.append('trim', trim);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch following list'}`);
        }

        const responseData = {
            has_more: payload.has_more || false,
            min_time: payload.min_time || 0,
            max_time: payload.max_time || 0,
            total: payload.total || 0,
            next_page_token: payload.next_page_token || null,
            followings: payload.followings || []
        };

        const upstreamCost = payload.credits_charged || 1;
        const finalCostToUser = upstreamCost * 2;

        req.user.credits -= finalCostToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/tiktok/user/following', finalCostToUser, { handle: identifier, min_time, trim }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: finalCostToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message === 'TimeoutError';
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : error.message;
        
        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/user/following', 
                params: { handle: identifier, min_time, trim }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/tiktok/user/following', 0, { handle: identifier, min_time, trim }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: TIKTOK VIDEO COMMENTS ---
app.get('/v1/tiktok/video/comments', authMiddleware, async (req, res) => {
    const { url, cursor, trim } = req.query;

    if (!url) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    const costPerRequest = 1;
    if (req.user.credits < costPerRequest) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credit.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/video/comments');
        targetUrl.searchParams.append('url', url);
        
        if (cursor) targetUrl.searchParams.append('cursor', cursor);
        if (trim) targetUrl.searchParams.append('trim', trim);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch comments'}`);
        }

        const responseData = {
            has_more: payload.has_more,
            cursor: payload.cursor,
            total: payload.total || 0,
            comments: payload.comments || []
        };

        const actualCost = costPerRequest;
        req.user.credits -= actualCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/tiktok/video/comments', actualCost, { url, cursor, trim }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message === 'TimeoutError';
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : error.message;
        
        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/video/comments', 
                params: { url, cursor, trim }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/tiktok/video/comments', 0, { url, cursor, trim }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

// --- EXPRESS ROUTE: TIKTOK USER LIVE ---
app.get('/v1/tiktok/user/live', authMiddleware, async (req, res) => {
    const { handle } = req.query;

    if (!handle) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'handle'." 
        });
    }

    const costPerRequest = 1;
    if (req.user.credits < costPerRequest) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credit.` 
        });
    }

    const identifier = handle.replace('@', '').toLowerCase().trim();

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/user/live');
        targetUrl.searchParams.append('handle', identifier);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000)
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch live stream details'}`);
        }

        const responseData = {
            liveRoomUserInfo: payload.liveRoomUserInfo || null,
            liveRoom: payload.liveRoom || null
        };

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/tiktok/user/live', costPerRequest, { handle: identifier }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message === 'TimeoutError';
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/user/live', 
                params: { handle: identifier }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/tiktok/user/live', 0, { handle: identifier }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: TIKTOK VIDEO TRANSCRIPT ---
app.get('/v1/tiktok/video/transcript', authMiddleware, async (req, res) => {
    const { url, language, use_ai_as_fallback } = req.query;

    if (!url) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    const maxPotentialCost = use_ai_as_fallback === 'true' ? 15 : 2;
    if (req.user.credits < maxPotentialCost) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires up to ${maxPotentialCost} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/video/transcript');
        targetUrl.searchParams.append('url', url);
        if (language) targetUrl.searchParams.append('language', language);
        if (use_ai_as_fallback) targetUrl.searchParams.append('use_ai_as_fallback', use_ai_as_fallback);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000)
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch transcript'}`);
        }

        const responseData = {
            id: payload.id || null,
            url: payload.url || url,
            transcript: payload.transcript || ""
        };

        const actualCost = payload.credits_charged || maxPotentialCost; 
        req.user.credits -= actualCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/tiktok/video/transcript', actualCost, { url, language, use_ai_as_fallback }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message === 'TimeoutError';
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/video/transcript', 
                params: { url, language, use_ai_as_fallback }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/tiktok/video/transcript', 0, { url, language, use_ai_as_fallback }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: TIKTOK SINGLE VIDEO ---
app.get('/v1/tiktok/video', authMiddleware, async (req, res) => {
    const { url, get_transcript, region, trim, download_media, cache_max_age } = req.query;

    if (!url) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    const maxPotentialCost = download_media === 'true' ? 10 : 1;
    if (req.user.credits < maxPotentialCost) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires up to ${maxPotentialCost} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v2/tiktok/video');
        targetUrl.searchParams.append('url', url);
        
        if (get_transcript) targetUrl.searchParams.append('get_transcript', get_transcript);
        if (region) targetUrl.searchParams.append('region', region);
        if (trim) targetUrl.searchParams.append('trim', trim);
        if (download_media) targetUrl.searchParams.append('download_media', download_media);
        if (cache_max_age) targetUrl.searchParams.append('cache_max_age', cache_max_age);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch video data'}`);
        }

        const responseData = {
            status_code: payload.status_code,
            status_msg: payload.status_msg,
            aweme_detail: payload.aweme_detail || null,
            transcript: payload.transcript || null,
            cached: payload.cached || false,
            cached_at: payload.cached_at || null
        };

        const actualCost = payload.credits_charged || 1;
        req.user.credits -= actualCost;
        
        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/tiktok/video', actualCost, { url, get_transcript, region, trim, download_media, cache_max_age }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message === 'TimeoutError';
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : error.message;
        
        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/video', 
                params: { url, get_transcript, region, trim, download_media, cache_max_age }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/tiktok/video', 0, { url, get_transcript, region, trim, download_media, cache_max_age }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

// --- EXPRESS ROUTE: TIKTOK PROFILE VIDEOS ---
app.get('/v1/tiktok/profile/videos', authMiddleware, async (req, res) => {
    const { handle, user_id, sort_by, max_cursor, region, trim } = req.query;

    if (!handle && !user_id) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'handle' or 'user_id'." 
        });
    }

    const costPerRequest = 1;
    if (req.user.credits < costPerRequest) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.` 
        });
    }

    const identifier = handle ? handle.replace('@', '').toLowerCase() : user_id;

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v3/tiktok/profile/videos');
        
        if (handle) targetUrl.searchParams.append('handle', identifier);
        if (user_id) targetUrl.searchParams.append('user_id', user_id);
        if (sort_by) targetUrl.searchParams.append('sort_by', sort_by);
        if (max_cursor) targetUrl.searchParams.append('max_cursor', max_cursor);
        if (region) targetUrl.searchParams.append('region', region);
        if (trim) targetUrl.searchParams.append('trim', trim);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch profile videos'}`);
        }

        const responseData = {
            has_more: payload.has_more,
            max_cursor: payload.max_cursor,
            min_cursor: payload.min_cursor,
            status_code: payload.status_code,
            status_msg: payload.status_msg,
            aweme_list: payload.aweme_list || []
        };

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/tiktok/profile/videos', costPerRequest, { handle: identifier, user_id, sort_by, max_cursor, region, trim }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message === 'TimeoutError';
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : error.message;
        
        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/profile/videos', 
                params: { identifier, max_cursor }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/tiktok/profile/videos', 0, { handle: identifier, user_id, sort_by, max_cursor, region, trim }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: TIKTOK PROFILE REGION ---
app.get('/v1/tiktok/profile/region', authMiddleware, async (req, res) => {
    const { handle } = req.query;

    if (!handle) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'handle'."
        });
    }

    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    const cleanHandle = handle.startsWith('@') ? handle.substring(1) : handle;

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/profile/region');
        targetUrl.searchParams.append('handle', cleanHandle);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch region'}`);
        }

        const responseData = {
            handle: payload.handle,
            profile_url: payload.profile_url,
            region: payload.region
        };

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/tiktok/profile/region', costPerRequest, { handle: cleanHandle }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : (error.message || "Internal Server Error");

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/tiktok/profile/region',
                params: { handle: cleanHandle },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/tiktok/profile/region', 0, { handle: cleanHandle }, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});


// --- EXPRESS ROUTE: TIKTOK PROFILE ---
app.get('/v1/tiktok/profile', authMiddleware, async (req, res) => {
    const { 
        handle, 
        user_id, 
        cache_max_age 
    } = req.query;

    if (!handle && !user_id) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter. You must provide either 'handle' or 'user_id'."
        });
    }

    const costPerRequest = 1;
    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/profile');
    
    let cleanHandle = null;
    if (handle) {
        cleanHandle = handle.startsWith('@') ? handle.substring(1) : handle;
        targetUrl.searchParams.append('handle', cleanHandle);
    }
    
    if (user_id) {
        targetUrl.searchParams.append('user_id', user_id);
    }

    if (cache_max_age) {
        targetUrl.searchParams.append('cache_max_age', cache_max_age);
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': apiKey, 
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000)
        });

        let data;
        try {
            data = await response.json();
        } catch (parseError) {
            throw new Error(`Extraction server returned invalid JSON. Status: ${response.status}`);
        }

        if (!response.ok || !data.success) {
            const serverError = data.error || data.message || `Server error: ${response.statusText}`;
            throw new Error(`[${response.status}] ${serverError}`);
        }

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/tiktok/profile', costPerRequest, { handle: cleanHandle, user_id, cache_max_age }, 200);

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
        const isTimeout = error.name === 'TimeoutError';
        const isNotFound = error.message.includes('[404]');
        
        const statusCode = isNotFound ? 404 : (isTimeout ? 504 : 500);
        let finalErrorMsg = error.message || "Internal Server Error";

        // White-labeled
        if (isTimeout) {
            finalErrorMsg = "504 Gateway Timeout: The extraction server took too long to respond.";
        } else if (isNotFound) {
            finalErrorMsg = "404 Not Found: The requested TikTok profile does not exist or is banned.";
        }

        if (typeof notifyFailure === 'function' && !isNotFound) {
            notifyFailure({
                endpoint: '/v1/tiktok/profile',
                params: { handle: cleanHandle, user_id },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/tiktok/profile', 0, { handle: cleanHandle, user_id, cache_max_age }, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});


// --- EXPRESS ROUTE: TIKTOK COLLECTION VIDEOS ---
app.get('/v1/tiktok/collection/videos', authMiddleware, async (req, res) => {
    const { url, cursor } = req.query;

    if (!url) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'url'."
        });
    }

    const costPerRequest = 1;

    if (req.user.credits < costPerRequest) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credits.`
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/collection/videos');
        targetUrl.searchParams.append('url', url);
        if (cursor) targetUrl.searchParams.append('cursor', cursor);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(35000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch collection videos'}`);
        }

        const responseData = {
            collection_id: payload.collection_id,
            has_more: payload.has_more,
            max_cursor: payload.max_cursor,
            status_code: payload.status_code,
            status_msg: payload.status_msg,
            videos: payload.videos || []
        };

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/tiktok/collection/videos', costPerRequest, { url, cursor }, 200);

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
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : errorMessage;

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/tiktok/collection/videos',
                params: { url, cursor },
                statusCode: statusCode,
                errorMsg: finalErrorMsg
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/tiktok/collection/videos', 0, { url, cursor }, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: finalErrorMsg
        });
    }
});

// --- EXPRESS ROUTE: LINKEDIN PROFILE ---
app.get('/v1/linkedin/profile', authMiddleware, async (req, res) => {
    const { url, handle } = req.query;

    let targetLinkedInUrl = url || handle;

    if (!targetLinkedInUrl || typeof targetLinkedInUrl !== 'string' || targetLinkedInUrl.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url' or 'handle'." 
        });
    }

    targetLinkedInUrl = targetLinkedInUrl.trim();

    if (!targetLinkedInUrl.startsWith('http://') && !targetLinkedInUrl.startsWith('https://')) {
        const cleanHandle = targetLinkedInUrl.replace(/^@/, '').replace(/^in\//, '').replace(/\/$/, '');
        targetLinkedInUrl = `https://www.linkedin.com/in/${cleanHandle}`;
    }

    try {
        const parsedUrl = new URL(targetLinkedInUrl);
        targetLinkedInUrl = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/$/, '')}`;
    } catch (e) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Invalid LinkedIn URL or handle provided." 
        });
    }

    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/linkedin/profile');
        targetUrl.searchParams.append('url', targetLinkedInUrl);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch LinkedIn profile'}`);
        }

        const trimmedProfile = {
            name: payload.name || null,
            image: payload.image || null,
            location: payload.location || null,
            followers: payload.followers || 0,
            connections: payload.connections || null,
            about: payload.about || null,
            url: targetLinkedInUrl,
            recentPosts: Array.isArray(payload.recentPosts) 
                ? payload.recentPosts.map(post => ({
                    title: post.title || "",
                    activityType: post.activityType || "",
                    link: post.link || "",
                    image: post.image || null
                })) 
                : [],

            experience: Array.isArray(payload.experience)
                ? payload.experience.map(exp => ({
                    company: exp.name || null,
                    url: exp.url || null,
                    location: exp.location || null
                }))
                : [],
            education: Array.isArray(payload.education)
                ? payload.education.map(edu => ({
                    school: edu.name || null,
                    url: edu.url || null,
                    startYear: edu.member?.startDate || null,
                    endYear: edu.member?.endDate || null
                }))
                : [],
            articles: Array.isArray(payload.articles)
                ? payload.articles.map(art => ({
                    headline: art.headline || "",
                    datePublished: art.datePublished || null,
                    image: art.image || null,
                    body: art.articleBody || ""
                }))
                : [],
            recommendations: Array.isArray(payload.recommendations)
                ? payload.recommendations.map(rec => ({
                    name: rec.name || "",
                    link: rec.link || "",
                    text: rec.text || ""
                }))
                : [],
            similarProfiles: Array.isArray(payload.similarProfiles)
                ? payload.similarProfiles.map(sim => ({
                    name: sim.name || "",
                    link: sim.link || "",
                    image: sim.image || null
                }))
                : []
        };

        req.user.credits -= costToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/linkedin/profile', costToUser, { url: targetLinkedInUrl }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...trimmedProfile
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch the profile." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/linkedin/profile', 
                params: { targetLinkedInUrl }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/linkedin/profile', 0, { url: targetLinkedInUrl }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: LINKEDIN EMAIL FINDER ---
app.get('/v1/linkedin/email', authMiddleware, async (req, res) => {
    const profileUrl = req.query.profileUrl || req.query.url;
    const costToUser = 15;

    if (!profileUrl || typeof profileUrl !== 'string' || profileUrl.trim() === '') {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Missing required parameter 'profileUrl'."
        });
    }

    const cleanProfileUrl = profileUrl.trim();

    if (req.user.credits < costToUser) {
        return res.status(403).json({
            success: false,
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.`
        });
    }

    try {
        const apiKey = process.env.GETANYAPI_KEY;
        if (!apiKey) throw new Error('Missing extraction API key in environment');

        const response = await fetch('https://api.getanyapi.com/v1/run/linkedin.email', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ profileUrl: cleanProfileUrl }),
            signal: AbortSignal.timeout(25000)
        });

        let payload;
        try {
            payload = await response.json();
        } catch (parseError) {
            throw new Error(`Extraction server returned invalid JSON (HTTP ${response.status})`);
        }

        if (!response.ok) {
            const serverError = payload.error || response.statusText || 'Failed to find LinkedIn email';
            const error = new Error(`Server Error: ${serverError}`);
            error.statusCode = response.status;
            throw error;
        }

        const output = payload.output || {};
        req.user.credits -= costToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/linkedin/email', costToUser, { profileUrl: cleanProfileUrl }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            found: output.found ?? false,
            data: output.data ?? null,
            ...(output.reason ? { reason: output.reason } : {})
        });
    } catch (error) {
        const isTimeout = error.name === 'TimeoutError';
        const statusCode = isTimeout
            ? 504
            : (error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500);
        
        // White-labeled
        const errorMessage = isTimeout
            ? '504 Gateway Timeout: The extraction server took too long to find the LinkedIn email.'
            : error.message || 'Internal Server Error';

        if (typeof notifyFailure === 'function') {
            notifyFailure({
                endpoint: '/v1/linkedin/email',
                params: { profileUrl: cleanProfileUrl },
                statusCode,
                errorMsg: errorMessage
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/linkedin/email', 0, { profileUrl: cleanProfileUrl }, statusCode);

        return res.status(statusCode).json({
            success: false,
            error: errorMessage
        });
    }
});


// --- EXPRESS ROUTE: LINKEDIN COMPANY ---
app.get('/v1/linkedin/company', authMiddleware, async (req, res) => {
    const { url, handle } = req.query;

    let targetCompanyUrl = url || handle;

    if (!targetCompanyUrl || typeof targetCompanyUrl !== 'string' || targetCompanyUrl.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url' or 'handle'." 
        });
    }

    targetCompanyUrl = targetCompanyUrl.trim();

    if (!targetCompanyUrl.startsWith('http://') && !targetCompanyUrl.startsWith('https://')) {
        const cleanHandle = targetCompanyUrl.replace(/^@/, '').replace(/^company\//, '').replace(/\/$/, '');
        targetCompanyUrl = `https://www.linkedin.com/company/${cleanHandle}`;
    }

    try {
        const parsedUrl = new URL(targetCompanyUrl);
        targetCompanyUrl = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/$/, '')}`;
    } catch (e) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Invalid LinkedIn company URL or handle provided." 
        });
    }

    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/linkedin/company');
        targetUrl.searchParams.append('url', targetCompanyUrl);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch LinkedIn company page'}`);
        }

        const trimmedCompany = {
            id: payload.id || null,
            name: payload.name || "",
            slogan: payload.slogan || null,
            description: payload.description || "",
            website: payload.website || null,
            logo: payload.logo || null,
            cover_image: payload.coverImage || null,
            industry: payload.industry || null,
            size: payload.size || null,
            employee_count: payload.employeeCount || 0,
            founded: payload.founded || null,
            headquarters: payload.headquarters || null,
            type: payload.type || null,
            location: payload.location ? {
                city: payload.location.city || "",
                state: payload.location.state || "",
                country: payload.location.country || ""
            } : null,
            specialties: Array.isArray(payload.specialties) ? payload.specialties : [],
            funding: payload.funding ? {
                number_of_rounds: payload.funding.numberOfRounds || 0,
                last_round: payload.funding.lastRound ? {
                    type: payload.funding.lastRound.type || "",
                    date: payload.funding.lastRound.date || null,
                    amount: payload.funding.lastRound.amount || ""
                } : null,
                investors: Array.isArray(payload.funding.investors)
                    ? payload.funding.investors.map(inv => ({
                        name: inv.name || "",
                        crunchbase_url: inv.crunchbaseUrl || "",
                        image: inv.image || null
                    }))
                    : []
            } : null,
            employees: Array.isArray(payload.employees)
                ? payload.employees.map(emp => ({
                    name: emp.name || "",
                    title: emp.title || "",
                    link: emp.link || "",
                    image: emp.image || null
                }))
                : [],
            posts: Array.isArray(payload.posts)
                ? payload.posts.map(post => ({
                    url: post.url || "",
                    date_published: post.datePublished || null,
                    text: post.text || ""
                }))
                : [],
            similar_pages: Array.isArray(payload.similarPages)
                ? payload.similarPages.map(page => ({
                    name: page.name || "",
                    link: page.link || "",
                    image: page.image || null
                }))
                : []
        };

        req.user.credits -= costToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/linkedin/company', costToUser, { url: targetCompanyUrl }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...trimmedCompany
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch company details." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/linkedin/company', 
                params: { targetCompanyUrl }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/linkedin/company', 0, { url: targetCompanyUrl }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

// --- EXPRESS ROUTE: LINKEDIN COMPANY POSTS ---
app.get('/v1/linkedin/company/posts', authMiddleware, async (req, res) => {
    const { url, handle, page } = req.query;

    let targetCompanyUrl = url || handle;

    if (!targetCompanyUrl || typeof targetCompanyUrl !== 'string' || targetCompanyUrl.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url' or 'handle'." 
        });
    }

    targetCompanyUrl = targetCompanyUrl.trim();

    if (!targetCompanyUrl.startsWith('http://') && !targetCompanyUrl.startsWith('https://')) {
        const cleanHandle = targetCompanyUrl.replace(/^@/, '').replace(/^company\//, '').replace(/\/$/, '');
        targetCompanyUrl = `https://www.linkedin.com/company/${cleanHandle}`;
    }

    try {
        const parsedUrl = new URL(targetCompanyUrl);
        targetCompanyUrl = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/$/, '')}`;
    } catch (e) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Invalid LinkedIn company URL or handle provided." 
        });
    }

    const pageNum = parseInt(page, 10) || 1;
    if (pageNum < 1 || pageNum > 7) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: 'page' parameter must be between 1 and 7 due to public pagination limits."
        });
    }

    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment configuration");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/linkedin/company/posts');
        targetUrl.searchParams.append('url', targetCompanyUrl);
        if (page) targetUrl.searchParams.append('page', pageNum.toString());

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch LinkedIn company posts'}`);
        }

        const trimmedPosts = Array.isArray(payload.posts) 
            ? payload.posts.map(post => ({
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

        req.user.credits -= costToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/linkedin/company/posts', costToUser, { url: targetCompanyUrl, page: pageNum }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch company posts." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/linkedin/company/posts', 
                params: { url: targetCompanyUrl, page: pageNum }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/linkedin/company/posts', 0, { url: targetCompanyUrl, page: pageNum }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: LINKEDIN SEARCH POSTS ---
app.get('/v1/linkedin/search/posts', authMiddleware, async (req, res) => {
    const { query, date_posted, cursor, trim } = req.query;

    if (!query || typeof query !== 'string' || query.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'query'." 
        });
    }

    if (cursor && parseInt(cursor, 10) >= 12) {
        return res.status(400).json({
            success: false,
            error: "400 Bad Request: Maximum pagination limit reached. LinkedIn only allows up to cursor 11 for public search."
        });
    }

    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/linkedin/search/posts');
        targetUrl.searchParams.append('query', query.trim());
        
        if (date_posted) targetUrl.searchParams.append('date_posted', date_posted);
        if (cursor) targetUrl.searchParams.append('cursor', cursor);
        if (trim) targetUrl.searchParams.append('trim', trim);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to search LinkedIn posts'}`
            );
        }

        const trimmedPosts = Array.isArray(payload.posts) 
            ? payload.posts.map(post => ({
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
            query: payload.query || query,
            cursor: payload.cursor ?? null,
            has_more: !!payload.cursor && parseInt(payload.cursor, 10) < 11,
            posts: trimmedPosts
        };

        req.user.credits -= costToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/linkedin/search/posts', costToUser, { query, date_posted, cursor, trim }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch search results." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/linkedin/search/posts', 
                params: { query, cursor }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/linkedin/search/posts', 0, { query, date_posted, cursor, trim }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: LINKEDIN SINGLE POST ---
app.get('/v1/linkedin/post', authMiddleware, async (req, res) => {
    const { url } = req.query;

    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    let targetPostUrl = url.trim();
    try {
        const parsedUrl = new URL(targetPostUrl);
        targetPostUrl = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/$/, '')}`;
    } catch (e) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Invalid LinkedIn URL provided." 
        });
    }

    const costPerRequest = 1;
    if (req.user.credits < costPerRequest) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costPerRequest} credit.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment configuration");

        const targetUrl = new URL('https://api.scrapecreators.com/v1/linkedin/post');
        targetUrl.searchParams.append('url', targetPostUrl);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch LinkedIn post'}`
            );
        }

        const trimmedPost = {
            url: payload.url || targetPostUrl,
            title: payload.name || "",
            headline: payload.headline || "",
            text: payload.description || "",
            date_published: payload.datePublished || null,
            author: payload.author ? {
                name: payload.author.name || "",
                url: payload.author.url || "",
                followers: payload.author.followers || 0
            } : null,
            stats: {
                likes: payload.likeCount || 0,
                comments: payload.commentCount || 0
            },
            comments: Array.isArray(payload.comments) 
                ? payload.comments.map(c => ({
                    author: c.author || "",
                    text: c.text || "",
                    url: c.linkedinUrl || ""
                })) 
                : [],
            more_articles: Array.isArray(payload.moreArticles) 
                ? payload.moreArticles.map(a => ({
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

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/linkedin/post', costPerRequest, { url: targetPostUrl }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...trimmedPost
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch the post." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/linkedin/post', 
                params: { url: targetPostUrl }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/linkedin/post', 0, { url: targetPostUrl }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

const { scrapeFacebookProfileNative,scrapeFacebookPostNative } = require('./src/scrapers/facebook.js');

// --- EXPRESS ROUTE: FACEBOOK GROUP INFO ---
app.get('/v1/facebook/group', authMiddleware, async (req, res) => {
    const { url, group_id } = req.query;

    if (!url && !group_id) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. Provide either 'url' or 'group_id'." 
        });
    }

    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    const targetUrl = new URL('https://api.scrapecreators.com/v1/facebook/group');

    if (group_id) {
        targetUrl.searchParams.append('group_id', group_id.trim());
    } else {
        const cleanUrl = url.trim().split('?')[0]; 
        targetUrl.searchParams.append('url', cleanUrl);
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch Facebook group details'}`
            );
        }

        const responseData = {
            id: payload.id || null,
            url: payload.url || url || null,
            name: payload.name || "",
            description: payload.description || "",
            privacy: payload.privacy ? {
                label: payload.privacy.label || "",
                description: payload.privacy.description || ""
            } : null,
            visibility: payload.visibility ? {
                label: payload.visibility.label || "",
                description: payload.visibility.description || ""
            } : null,
            categories: Array.isArray(payload.categories) 
                ? payload.categories.map(c => ({ id: c.id, name: c.name })) 
                : [],
            created_at: payload.created_at || null,
            history_summary: payload.history_summary || "",
            stats: {
                member_count: payload.member_count || 0,
                member_count_text: payload.member_count_text || "",
                administrator_count: payload.administrator_count || 0,
                moderator_count: payload.moderator_count || 0
            },
            activity: payload.activity ? {
                posts_last_day: payload.activity.posts_last_day || 0,
                posts_last_month: payload.activity.posts_last_month || 0,
                new_members_text: payload.activity.new_members_text || ""
            } : null,
            staff: {
                administrators: Array.isArray(payload.administrators) ? payload.administrators.map(admin => ({
                    id: admin.id || "",
                    name: admin.name || "",
                    url: admin.url || "",
                    profile_picture_url: admin.profile_picture_url || null
                })) : [],
                moderators: Array.isArray(payload.moderators) ? payload.moderators.map(mod => ({
                    id: mod.id || "",
                    name: mod.name || "",
                    url: mod.url || "",
                    profile_picture_url: mod.profile_picture_url || null
                })) : []
            },
            rules: Array.isArray(payload.rules) ? payload.rules.map(rule => ({
                id: rule.id || "",
                title: rule.title || "",
                description: rule.description || ""
            })) : [],
            about_info: Array.isArray(payload.about_info) ? payload.about_info.map(info => ({
                type: info.type || "",
                label: info.label || "",
                description: info.description || ""
            })) : []
        };

        req.user.credits -= costToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/facebook/group', costToUser, { url, group_id }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch group info." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/group', 
                params: { group_id, url }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/facebook/group', 0, { url, group_id }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: FACEBOOK GROUP POSTS ---
app.get('/v1/facebook/group/posts', authMiddleware, async (req, res) => {
    const { url, group_id, sort_by, cursor } = req.query;

    if (!url && !group_id) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. Provide either 'url' or 'group_id'." 
        });
    }

    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    const targetUrl = new URL('https://api.scrapecreators.com/v1/facebook/group/posts');

    if (group_id) {
        targetUrl.searchParams.append('group_id', group_id.trim());
    } else {
        const cleanUrl = url.trim().split('?')[0]; 
        targetUrl.searchParams.append('url', cleanUrl);
    }

    const safeSortBy = sort_by ? sort_by.trim().toUpperCase() : 'CHRONOLOGICAL';
    if (sort_by) targetUrl.searchParams.append('sort_by', safeSortBy);
    if (cursor) targetUrl.searchParams.append('cursor', cursor);

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(30000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch Facebook group posts'}`
            );
        }

        const trimmedPosts = Array.isArray(payload.posts) 
            ? payload.posts.map(post => ({
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
            target: group_id ? { group_id: group_id.trim() } : { url: targetUrl.searchParams.get('url') },
            sort_by: safeSortBy,
            cursor: payload.cursor || null,
            has_more: !!payload.cursor,
            total_returned: trimmedPosts.length,
            posts: trimmedPosts
        };

        req.user.credits -= costToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/facebook/group/posts', costToUser, { url, group_id, sort_by, cursor }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch group posts." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/group/posts', 
                params: { group_id, url, sort_by, cursor }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/facebook/group/posts', 0, { url, group_id, sort_by, cursor }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: FACEBOOK POST COMMENTS ---
app.get('/v1/facebook/post/comments', authMiddleware, async (req, res) => {
    const { url, feedback_id, cursor } = req.query;

    if (!url && !feedback_id) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. You must provide either 'url' or 'feedback_id'." 
        });
    }

    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    const targetUrl = new URL('https://api.scrapecreators.com/v1/facebook/post/comments');

    if (feedback_id) {
        targetUrl.searchParams.append('feedback_id', feedback_id.trim());
    } else {
        const cleanUrl = url.trim().split('?')[0]; 
        targetUrl.searchParams.append('url', cleanUrl);
    }

    if (cursor) targetUrl.searchParams.append('cursor', cursor);

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch Facebook comments'}`
            );
        }

        const trimmedComments = Array.isArray(payload.comments) 
            ? payload.comments.map(comment => ({
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
            target: feedback_id ? { feedback_id: feedback_id.trim() } : { url: targetUrl.searchParams.get('url') },
            cursor: payload.cursor || null,
            has_more: !!payload.has_next_page,
            total_returned: trimmedComments.length,
            comments: trimmedComments
        };

        req.user.credits -= costToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/facebook/post/comments', costToUser, { url, feedback_id, cursor }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch comments." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/post/comments', 
                params: { url, feedback_id, cursor }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/facebook/post/comments', 0, { url, feedback_id, cursor }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

// --- EXPRESS ROUTE: FACEBOOK SINGLE POST ---
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
    const costPerRequest = 2;
    if (req.user.credits < costPerRequest) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires up to ${costPerRequest} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/facebook/post');
        targetUrl.searchParams.append('url', cleanUrl);
        
        if (cache_max_age) targetUrl.searchParams.append('cache_max_age', cache_max_age);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch Facebook post'}`
            );
        }

        const responseData = {
            post_id: payload.post_id || null,
            url: payload.url || cleanUrl,
            description: payload.description || "",
            creation_time: payload.creation_time || null,
            stats: {
                likes: payload.like_count || 0,
                comments: payload.comment_count || 0,
                shares: payload.share_count || 0,
                views: payload.view_count || 0
            },
            author: payload.author ? {
                id: payload.author.id || "",
                name: payload.author.name || "",
                url: payload.author.url || "",
                image: payload.author.image || null,
                is_verified: !!payload.author.is_verified
            } : null,
            media: {
                image_url: payload.image_url || null,
                video: payload.video ? {
                    id: payload.video.id || "",
                    sd_url: payload.video.sd_url || null,
                    hd_url: payload.video.hd_url || null,
                    thumbnail: payload.video.thumbnail || null,
                    duration_sec: payload.video.length_in_second || 0
                } : null
            },
            music: payload.music ? {
                id: payload.music.id || "",
                title: payload.music.track_title || ""
            } : null,
            cached: payload.cached || false,
            cached_at: payload.cached_at || null
        };

        const actualCost = payload.credits_charged === 0 ? 0 : costPerRequest;
        req.user.credits -= actualCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/facebook/post', actualCost, { url: cleanUrl, cache_max_age }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch the post." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/post', 
                params: { url: cleanUrl, cache_max_age }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/facebook/post', 0, { url: cleanUrl, cache_max_age }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: FACEBOOK PROFILE REELS ---
app.get('/v1/facebook/profile/reels', authMiddleware, async (req, res) => {
    const { url, handle, next_page_id, cursor } = req.query;

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

    try {
        const parsedUrl = new URL(targetPageUrl);
        targetPageUrl = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/$/, '')}`;
    } catch (e) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Invalid Facebook URL or handle provided." 
        });
    }

    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/facebook/profile/reels');
        targetUrl.searchParams.append('url', targetPageUrl);
        
        if (next_page_id) targetUrl.searchParams.append('next_page_id', next_page_id);
        if (cursor) targetUrl.searchParams.append('cursor', cursor);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch Facebook reels'}`
            );
        }

        const trimmedReels = Array.isArray(payload.reels) 
            ? payload.reels.map(reel => ({
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
            cursor: payload.cursor || null,
            next_page_id: payload.next_page_id || null,
            has_more: !!(payload.cursor && payload.next_page_id),
            total_returned: trimmedReels.length,
            reels: trimmedReels
        };

        req.user.credits -= costToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/facebook/profile/reels', costToUser, { url: targetPageUrl, cursor, next_page_id }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch reels." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/profile/reels', 
                params: { targetPageUrl, cursor, next_page_id }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/facebook/profile/reels', 0, { url: targetPageUrl, cursor, next_page_id }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: FACEBOOK PROFILE PHOTOS ---
app.get('/v1/facebook/profile/photos', authMiddleware, async (req, res) => {
    const { url, handle, next_page_id, cursor } = req.query;

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

    try {
        const parsedUrl = new URL(targetPageUrl);
        targetPageUrl = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/$/, '')}`;
    } catch (e) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Invalid Facebook URL or handle provided." 
        });
    }

    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/facebook/profile/photos');
        targetUrl.searchParams.append('url', targetPageUrl);
        
        if (next_page_id) targetUrl.searchParams.append('next_page_id', next_page_id);
        if (cursor) targetUrl.searchParams.append('cursor', cursor);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch Facebook page photos'}`
            );
        }

        const trimmedPhotos = Array.isArray(payload.photos) 
            ? payload.photos.map(photo => ({
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
            cursor: payload.cursor || null,
            next_page_id: payload.next_page_id || null,
            has_more: !!(payload.cursor && payload.next_page_id),
            total_returned: trimmedPhotos.length,
            photos: trimmedPhotos
        };

        req.user.credits -= costToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/facebook/profile/photos', costToUser, { url: targetPageUrl, cursor, next_page_id }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch photos." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/profile/photos', 
                params: { targetPageUrl, cursor, next_page_id }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/facebook/profile/photos', 0, { url: targetPageUrl, cursor, next_page_id }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

// --- EXPRESS ROUTE: FACEBOOK PROFILE POSTS ---
app.get('/v1/facebook/profile/posts', authMiddleware, async (req, res) => {
    const { url, handle, pageId, cursor } = req.query;

    if (!url && !handle && !pageId) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. Provide either 'url', 'handle', or 'pageId'." 
        });
    }

    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    let targetPageUrl = "";
    if (pageId) {
        // Handled via pageId upstream
    } else {
        const input = handle || url;
        let cleanInput = input.trim().replace(/^@/, '');

        if (cleanInput.includes('facebook.com/')) {
            const pathPart = cleanInput.split('facebook.com/')[1].split('/')[0].split('?')[0];
            targetPageUrl = `https://www.facebook.com/${pathPart}`;
        } else if (cleanInput.startsWith('http://') || cleanInput.startsWith('https://')) {
            targetPageUrl = cleanInput;
        } else {
            targetPageUrl = `https://www.facebook.com/${cleanInput.replace(/\/$/, '')}`;
        }

        try {
            const parsedUrl = new URL(targetPageUrl);
            targetPageUrl = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/$/, '')}`;
        } catch (e) {
            return res.status(400).json({ 
                success: false, 
                error: "400 Bad Request: Invalid Facebook URL or handle provided." 
            });
        }
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/profile/posts');
        
        if (pageId) {
            upstreamUrl.searchParams.append('pageId', pageId.trim());
        } else {
            upstreamUrl.searchParams.append('url', targetPageUrl);
        }

        if (cursor) upstreamUrl.searchParams.append('cursor', cursor);

        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(30000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch Facebook posts'}`
            );
        }

        const trimmedPosts = Array.isArray(payload.posts) 
            ? payload.posts.map(post => ({
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
            target: pageId ? { page_id: pageId } : { url: targetPageUrl },
            cursor: payload.cursor || null,
            has_more: !!payload.cursor,
            total_returned: trimmedPosts.length,
            posts: trimmedPosts
        };

        req.user.credits -= costToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/facebook/profile/posts', costToUser, { url, handle, pageId, cursor }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch posts." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/profile/posts', 
                params: { pageId, url, handle, cursor }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/facebook/profile/posts', 0, { url, handle, pageId, cursor }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: FACEBOOK PROFILE EVENTS ---
app.get('/v1/facebook/profile/events', authMiddleware, async (req, res) => {
    const { url, handle, cursor } = req.query;

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

    try {
        const parsedUrl = new URL(targetPageUrl);
        targetPageUrl = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/$/, '')}`;
    } catch (e) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Invalid Facebook URL or handle provided." 
        });
    }

    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/profile/events');
        upstreamUrl.searchParams.append('url', targetPageUrl);
        
        if (cursor) upstreamUrl.searchParams.append('cursor', cursor);

        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch Facebook page events'}`
            );
        }

        const trimmedEvents = Array.isArray(payload.events) 
            ? payload.events.map(event => ({
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
            cursor: payload.cursor || null,
            has_next_page: !!payload.has_next_page,
            total_count: payload.total_count || 0,
            events_returned: trimmedEvents.length,
            events: trimmedEvents
        };

        req.user.credits -= costToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/facebook/profile/events', costToUser, { url: targetPageUrl, cursor }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch events." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/profile/events', 
                params: { targetPageUrl, cursor }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/facebook/profile/events', 0, { url: targetPageUrl, cursor }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: FACEBOOK POST TRANSCRIPT ---
app.get('/v1/facebook/post/transcript', authMiddleware, async (req, res) => {
    const { url, cache_max_age } = req.query;

    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    const targetUrl = url.trim();

    const baseCostToUser = 2;
    if (req.user.credits < baseCostToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires up to ${baseCostToUser} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/post/transcript');
        upstreamUrl.searchParams.append('url', targetUrl);
        
        if (cache_max_age) upstreamUrl.searchParams.append('cache_max_age', cache_max_age);

        const response = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch transcript. Video may be over 2 minutes long.'}`
            );
        }

        const responseData = {
            url: targetUrl,
            transcript: payload.transcript || null,
            cached: payload.cached || false,
            cached_at: payload.cached_at || null
        };

        const actualCost = payload.credits_charged === 0 ? 0 : baseCostToUser;
        
        req.user.credits -= actualCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/facebook/post/transcript', actualCost, { url: targetUrl, cache_max_age }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to generate the transcript." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/post/transcript', 
                params: { targetUrl, cache_max_age }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/facebook/post/transcript', 0, { url: targetUrl, cache_max_age }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: FACEBOOK PROFILE ---
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

    try {
        // Execute Native Scraper
        const scraperResult = await scrapeFacebookProfileNative(cleanInput);

        req.user.credits -= costPerRequest;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/facebook/profile', costPerRequest, { input: cleanInput }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costPerRequest,
            ...scraperResult.data
        });

    } catch (error) {
        const statusCode = error.message.includes('Timeout') ? 504 : 500;

        // White-labeled (Assuming scrapeFacebookProfileNative throws standard Node errors, not upstream ones)
        const finalErrorMsg = statusCode === 504 
            ? "504 Gateway Timeout: The extraction server took too long to respond." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/profile', 
                params: { input: cleanInput }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/facebook/profile', 0, { input: cleanInput }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

// --- EXPRESS ROUTE: TWITTER TWEET TRANSCRIPT ---
app.get('/v1/twitter/tweet/transcript', authMiddleware, async (req, res) => {
    const { url, cache_max_age } = req.query;

    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    const cleanUrl = url.trim().split('?')[0];

    const baseCostToUser = 2;
    if (req.user.credits < baseCostToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires up to ${baseCostToUser} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/twitter/tweet/transcript');
        targetUrl.searchParams.append('url', cleanUrl);
        
        if (cache_max_age) targetUrl.searchParams.append('cache_max_age', cache_max_age);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(60000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to generate tweet transcript'}`
            );
        }

        const responseData = {
            url: cleanUrl,
            transcript: payload.transcript || null,
            cached: payload.cached || false,
            cached_at: payload.cached_at || null
        };

        const actualCost = payload.credits_charged === 0 ? 0 : baseCostToUser;
        
        req.user.credits -= actualCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/twitter/tweet/transcript', actualCost, { url: cleanUrl, cache_max_age }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to generate the transcript." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/twitter/tweet/transcript', 
                params: { url: cleanUrl, cache_max_age }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/twitter/tweet/transcript', 0, { url: cleanUrl, cache_max_age }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: TWITTER COMMUNITY ---
app.get('/v1/twitter/community', authMiddleware, async (req, res) => {
    const { url } = req.query;

    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    const cleanUrl = url.trim().split('?')[0];

    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/twitter/community');
        targetUrl.searchParams.append('url', cleanUrl);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch Twitter community details'}`
            );
        }

        const { success, credits_remaining, credits_charged, ...communityData } = payload;
        
        const responseData = {
            ...communityData
        };

        req.user.credits -= costToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/twitter/community', costToUser, { url: cleanUrl }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch the community." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/twitter/community', 
                params: { url: cleanUrl }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/twitter/community', 0, { url: cleanUrl }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: TWITTER COMMUNITY TWEETS ---
app.get('/v1/twitter/community/tweets', authMiddleware, async (req, res) => {
    const { url } = req.query;

    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    const cleanUrl = url.trim().split('?')[0];

    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/twitter/community/tweets');
        targetUrl.searchParams.append('url', cleanUrl);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch Twitter community tweets'}`);
        }

        const trimmedTweets = Array.isArray(payload.tweets) 
            ? payload.tweets.map(tweet => ({
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

        req.user.credits -= costToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/twitter/community/tweets', costToUser, { url: cleanUrl }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch the community tweets." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/twitter/community/tweets', 
                params: { url: cleanUrl }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/twitter/community/tweets', 0, { url: cleanUrl }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

// --- EXPRESS ROUTE: TWITTER SINGLE TWEET ---
app.get('/v1/twitter/tweet', authMiddleware, async (req, res) => {
    const { url, trim, cache_max_age } = req.query;

    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    const cleanUrl = url.trim().split('?')[0]; 

    const baseCostToUser = 1;
    if (req.user.credits < baseCostToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires up to ${baseCostToUser} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/twitter/tweet');
        targetUrl.searchParams.append('url', cleanUrl);
        
        if (trim) targetUrl.searchParams.append('trim', trim);
        if (cache_max_age) targetUrl.searchParams.append('cache_max_age', cache_max_age);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch tweet details'}`
            );
        }

        const { success, credits_remaining, credits_charged, cached, cached_at, ...tweetData } = payload;
        
        const responseData = {
            cached: cached || false,
            cached_at: cached_at || null,
            ...tweetData
        };

        // Dynamic Billing: Pass 0-cost cache hits to the user
        const actualCost = credits_charged === 0 ? 0 : baseCostToUser;
        
        req.user.credits -= actualCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/twitter/tweet', actualCost, { url: cleanUrl, trim, cache_max_age }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch the tweet." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/twitter/tweet', 
                params: { url: cleanUrl, trim, cache_max_age }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/twitter/tweet', 0, { url: cleanUrl, trim, cache_max_age }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: TWITTER PROFILE TWEETS ---
app.get('/v1/twitter/profile/tweets', authMiddleware, async (req, res) => {
    const { handle, trim } = req.query;

    if (!handle || typeof handle !== 'string' || handle.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'handle'." 
        });
    }

    const cleanHandle = handle.trim().replace(/^@/, '').split('?')[0];

    const baseCostToUser = 2;
    if (req.user.credits < baseCostToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${baseCostToUser} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/twitter/user-tweets');
        targetUrl.searchParams.append('handle', cleanHandle);
        if (trim) targetUrl.searchParams.append('trim', trim);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch Twitter user tweets'}`);
        }

        const responseData = {
            handle: cleanHandle,
            total_returned: Array.isArray(payload.tweets) ? payload.tweets.length : 0,
            tweets: payload.tweets || []
        };

        req.user.credits -= baseCostToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/twitter/profile/tweets', baseCostToUser, { handle: cleanHandle, trim }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: baseCostToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch the tweets." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/twitter/profile/tweets', 
                params: { handle: cleanHandle, trim }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/twitter/profile/tweets', 0, { handle: cleanHandle, trim }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: TWITTER PROFILE ---
app.get('/v1/twitter/profile', authMiddleware, async (req, res) => {
    const { handle, cache_max_age } = req.query;

    if (!handle || typeof handle !== 'string' || handle.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'handle'." 
        });
    }

    const cleanHandle = handle.trim().replace(/^@/, '').split('?')[0];

    const baseCostToUser = 1;
    if (req.user.credits < baseCostToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires up to ${baseCostToUser} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/twitter/profile');
        targetUrl.searchParams.append('handle', cleanHandle);
        if (cache_max_age) targetUrl.searchParams.append('cache_max_age', cache_max_age);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(`Server Error: ${payload.error || response.statusText || 'Failed to fetch Twitter profile'}`);
        }

        const { success, credits_remaining, credits_charged, cached, cached_at, ...twitterData } = payload;
        
        const responseData = {
            cached: cached || false,
            cached_at: cached_at || null,
            ...twitterData
        };

        const actualCost = credits_charged === 0 ? 0 : baseCostToUser;
        
        req.user.credits -= actualCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/twitter/profile', actualCost, { handle: cleanHandle, cache_max_age }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch the profile." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/twitter/profile', 
                params: { handle: cleanHandle, cache_max_age }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/twitter/profile', 0, { handle: cleanHandle, cache_max_age }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

// --- EXPRESS ROUTE: TIKTOK PRODUCT DETAILS ---
app.get('/v1/tiktok/product', authMiddleware, async (req, res) => {
    const { url, region } = req.query;

    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    const cleanUrl = url.trim().split('?')[0]; 
    const safeRegion = region ? region.trim().toUpperCase() : 'US';

    // Charge 2 credits for 50% profit margin
    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/product');
        targetUrl.searchParams.append('url', cleanUrl);
        targetUrl.searchParams.append('region', safeRegion);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch TikTok product details'}`
            );
        }

        const responseData = {
            url: cleanUrl,
            region: safeRegion,
            categories: Array.isArray(payload.categories) 
                ? payload.categories.map(c => c.category_name) 
                : [],
            product: payload.product_info ? {
                id: payload.product_info.product_id || "",
                title: payload.product_info.product_base?.title || "",
                status: payload.product_info.status || 1,
                sold_count: payload.product_info.product_base?.sold_count || 0,
                price: {
                    original: payload.product_info.product_base?.price?.original_price || null,
                    discounted: payload.product_info.product_base?.price?.real_price || null,
                    currency: payload.product_info.product_base?.price?.currency || "USD",
                    discount_text: payload.product_info.product_base?.price?.discount || null
                },
                images: payload.product_info.product_base?.images?.map(img => img.url_list?.[0]).filter(Boolean) || [],
                video_url: payload.product_info.product_base?.desc_video?.video_infos?.[0]?.main_url || null,
                rating: {
                    score: payload.product_info.product_detail_review?.product_rating || 0,
                    review_count: payload.product_info.product_detail_review?.review_count || 0
                },
                skus: Array.isArray(payload.product_info.skus) ? payload.product_info.skus.map(sku => ({
                    id: sku.sku_id,
                    stock: sku.stock || 0,
                    price: sku.price?.real_price?.price_str || null,
                    properties: Array.isArray(sku.sku_sale_props) ? sku.sku_sale_props.map(prop => ({
                        name: prop.prop_name,
                        value: prop.prop_value
                    })) : []
                })) : []
            } : null,
            shop: payload.shop_info ? {
                id: payload.shop_info.seller_id || "",
                name: payload.shop_info.shop_name || "",
                rating: payload.shop_info.shop_rating || "",
                sold_count: payload.shop_info.sold_count || 0,
                followers_count: payload.shop_info.followers_count || "0",
                url: payload.shop_info.shop_link || ""
            } : null,
            related_videos: Array.isArray(payload.related_videos) ? payload.related_videos.map(video => ({
                id: video.item_id,
                title: video.title,
                url: video.url,
                play_count: video.play_count,
                like_count: video.like_count,
                author_name: video.author_name
            })) : []
        };

        const actualCost = payload.credits_charged === 0 ? 0 : costToUser;
        req.user.credits -= actualCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/tiktok/product', actualCost, { url: cleanUrl, region: safeRegion }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch product details." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/product', 
                params: { url: cleanUrl, region: safeRegion }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/tiktok/product', 0, { url: cleanUrl, region: safeRegion }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: TIKTOK PRODUCT REVIEWS ---
app.get('/v1/tiktok/shop/product/reviews', authMiddleware, async (req, res) => {
    const { url, product_id, region, page } = req.query;

    if (!url && !product_id) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. Provide either 'url' or 'product_id'." 
        });
    }

    const cleanUrl = url ? url.trim().split('?')[0] : null; 
    const safeProductId = product_id ? product_id.trim() : null;
    const safeRegion = region ? region.trim().toUpperCase() : 'US';
    const safePage = page ? parseInt(page, 10) : 1;

    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/shop/product/reviews');
        if (cleanUrl) targetUrl.searchParams.append('url', cleanUrl);
        if (safeProductId) targetUrl.searchParams.append('product_id', safeProductId);
        targetUrl.searchParams.append('region', safeRegion);
        targetUrl.searchParams.append('page', safePage);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch TikTok product reviews'}`
            );
        }

        const responseData = {
            has_more: !!payload.has_more,
            total_reviews: parseInt(payload.total_reviews || "0", 10),
            summary: payload.review_ratings ? {
                average_score: payload.review_ratings.overall_score || 0,
                rating_distribution: payload.review_ratings.rating_result || {}
            } : null,
            reviews: Array.isArray(payload.product_reviews) ? payload.product_reviews.map(r => ({
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

        const actualCost = payload.credits_charged === 0 ? 0 : costToUser;
        req.user.credits -= actualCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/tiktok/shop/product/reviews', actualCost, { url: cleanUrl, product_id: safeProductId, region: safeRegion, page: safePage }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch product reviews." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/shop/product/reviews', 
                params: { url: cleanUrl, product_id: safeProductId, region: safeRegion, page: safePage }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/tiktok/shop/product/reviews', 0, { url: cleanUrl, product_id: safeProductId, region: safeRegion, page: safePage }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: TIKTOK SHOP PRODUCTS ---
app.get('/v1/tiktok/shop/products', authMiddleware, async (req, res) => {
    const { url, cursor, sort_by, region } = req.query;

    if (!url || typeof url !== 'string' || url.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'url'." 
        });
    }

    const cleanUrl = url.trim().split('?')[0]; 
    const safeSortBy = sort_by && ['top', 'new_releases'].includes(sort_by.toLowerCase()) ? sort_by.toLowerCase() : 'top';
    const safeRegion = region ? region.trim().toUpperCase() : 'US';

    const baseCostToUser = 2;
    if (req.user.credits < baseCostToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${baseCostToUser} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/shop/products');
        targetUrl.searchParams.append('url', cleanUrl);
        targetUrl.searchParams.append('sort_by', safeSortBy);
        targetUrl.searchParams.append('region', safeRegion);
        if (cursor) targetUrl.searchParams.append('cursor', cursor);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(30000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch TikTok shop products'}`
            );
        }

        const responseData = {
            url: cleanUrl,
            sort_by: safeSortBy,
            region: safeRegion,
            shopInfo: payload.shopInfo ? {
                seller_id: payload.shopInfo.seller_id || "",
                shop_name: payload.shopInfo.shop_name || "",
                shop_logo: payload.shopInfo.shop_logo || null,
                shop_rating: payload.shopInfo.shop_rating || null,
                sold_count: payload.shopInfo.sold_count || 0,
                format_sold_count: payload.shopInfo.format_sold_count || "0",
                on_sell_product_count: payload.shopInfo.on_sell_product_count || 0,
                followers_count: payload.shopInfo.followers_count || "0",
                review_count: payload.shopInfo.review_count || 0,
                shop_slogan: payload.shopInfo.shop_slogan || "",
                shop_link: payload.shopInfo.shop_link || cleanUrl
            } : null,
            products: Array.isArray(payload.products) ? payload.products.map(product => ({
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
            has_more: !!payload.has_more,
            cursor: payload.cursor || null
        };

        const actualCost = payload.credits_charged === 0 ? 0 : baseCostToUser;
        
        req.user.credits -= actualCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/tiktok/shop/products', actualCost, { url: cleanUrl, cursor, sort_by: safeSortBy, region: safeRegion }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch the shop products." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/shop/products', 
                params: { url: cleanUrl, cursor, sort_by: safeSortBy, region: safeRegion }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/tiktok/shop/products', 0, { url: cleanUrl, cursor, sort_by: safeSortBy, region: safeRegion }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: TIKTOK SHOP SEARCH ---
app.get('/v1/tiktok/shop/search', authMiddleware, async (req, res) => {
    const { query, page, region } = req.query;

    if (!query || typeof query !== 'string' || query.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'query'." 
        });
    }

    const cleanQuery = query.trim();
    const safeRegion = region ? region.trim().toUpperCase() : 'US';
    const safePage = page ? parseInt(page, 10) : 1;

    // Charge 2 credits to maintain 50% margin
    const baseCostToUser = 2;
    if (req.user.credits < baseCostToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires up to ${baseCostToUser} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/tiktok/shop/search');
        targetUrl.searchParams.append('query', cleanQuery);
        if (page) targetUrl.searchParams.append('page', safePage);
        if (region) targetUrl.searchParams.append('region', safeRegion);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch TikTok shop products'}`
            );
        }

        const { success, credits_remaining, credits_charged, ...shopData } = payload;
        
        const responseData = {
            ...shopData
        };

        const actualCost = credits_charged === 0 ? 0 : baseCostToUser;
        
        req.user.credits -= actualCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/tiktok/shop/search', actualCost, { query: cleanQuery, region: safeRegion, page: safePage }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch the shop data." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/tiktok/shop/search', 
                params: { query: cleanQuery, region: safeRegion, page: safePage }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/tiktok/shop/search', 0, { query: cleanQuery, region: safeRegion, page: safePage }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

// --- EXPRESS ROUTE: LINKEDIN ADS SEARCH ---
app.get('/v1/linkedin/ads/search', authMiddleware, async (req, res) => {
    const { company, keyword, companyId, countries, startDate, endDate, paginationToken } = req.query;

    if (!company && !keyword && !companyId) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Provide at least one core search parameter ('company', 'keyword', or 'companyId')." 
        });
    }

    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/linkedin/ads/search');
        if (company) targetUrl.searchParams.append('company', company.trim());
        if (keyword) targetUrl.searchParams.append('keyword', keyword.trim());
        if (companyId) targetUrl.searchParams.append('companyId', companyId.trim());
        if (countries) targetUrl.searchParams.append('countries', countries.trim().toUpperCase());
        if (startDate) targetUrl.searchParams.append('startDate', startDate.trim());
        if (endDate) targetUrl.searchParams.append('endDate', endDate.trim());
        if (paginationToken) targetUrl.searchParams.append('paginationToken', paginationToken.trim());

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(25000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to search LinkedIn Ads Library'}`
            );
        }

        const responseData = {
            total_ads: payload.totalAds || 0,
            has_more: !payload.isLastPage,
            pagination_token: payload.paginationToken || null,
            ads: Array.isArray(payload.ads) ? payload.ads.map(ad => ({
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
                    destination_url: ad.destinationUrl ? ad.destinationUrl.split('?')[0] : null
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

        const actualCost = payload.credits_charged === 0 ? 0 : costToUser;
        req.user.credits -= actualCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/linkedin/ads/search', actualCost, { company, keyword, companyId, countries, startDate, endDate, paginationToken }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch LinkedIn ads." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/linkedin/ads/search', 
                params: { company, keyword, companyId, countries, startDate, endDate, paginationToken }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/linkedin/ads/search', 0, { company, keyword, companyId, countries, startDate, endDate, paginationToken }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: FACEBOOK AD LIBRARY SINGLE AD ---
// --- EXPRESS ROUTE: FACEBOOK AD LIBRARY SINGLE AD ---
app.get('/v1/facebook/adLibrary/ad', authMiddleware, async (req, res) => {
    const { id, url, trim, cache_max_age } = req.query;

    if (!id && !url) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. Provide either 'id' or 'url'." 
        });
    }

    const safeId = id ? id.trim() : null;
    const cleanUrl = url ? url.trim().split('?')[0] : null; 
    const safeTrim = trim === 'true' ? 'true' : 'false';

    const baseCostToUser = 2;
    if (req.user.credits < baseCostToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${baseCostToUser} credit.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/facebook/adLibrary/ad');
        if (safeId) targetUrl.searchParams.append('id', safeId);
        if (cleanUrl) targetUrl.searchParams.append('url', cleanUrl);
        if (trim) targetUrl.searchParams.append('trim', safeTrim);
        if (cache_max_age) targetUrl.searchParams.append('cache_max_age', cache_max_age);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch Facebook Ad details'}`
            );
        }

        const snap = payload.snapshot || {};
        
        let adTitle = typeof snap.title === 'string' ? snap.title : "";
        let adImages = Array.isArray(snap.images) ? snap.images.map(img => img.resized_image_url || img.original_image_url).filter(Boolean) : [];
        let adLink = typeof snap.link_url === 'string' ? snap.link_url : "";

        if (Array.isArray(snap.cards) && snap.cards.length > 0) {
            const cardTitles = snap.cards.map(c => typeof c.title === 'string' ? c.title : "").filter(Boolean);
            if (cardTitles.length > 0) adTitle = cardTitles.join(" | ");
            
            const cardImages = snap.cards.map(c => c.resized_image_url || c.original_image_url).filter(Boolean);
            if (cardImages.length > 0) adImages = cardImages;
            
            if (!adLink) adLink = typeof snap.cards[0]?.link_url === 'string' ? snap.cards[0].link_url : "";
        }

        let safeBodyText = "";
        if (typeof snap.body === 'string') {
            safeBodyText = snap.body.replace(/<br\s*\/?>/gi, '\n');
        } else if (snap.body && typeof snap.body.markup === 'string') {
            safeBodyText = snap.body.markup.replace(/<br\s*\/?>/gi, '\n');
        }

        const responseData = {
            ad_id: payload.adArchiveID || safeId,
            is_active: !!payload.isActive,
            duration: {
                start: payload.startDateString || null,
                end: payload.endDateString || null
            },
            advertiser: {
                id: payload.pageID || snap.page_id || "",
                name: payload.pageName || snap.page_name || "",
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
            platforms: Array.isArray(payload.publisherPlatform) ? payload.publisherPlatform : [],
            audience_reach: payload.aaa_info ? {
                total_reach: payload.aaa_info.eu_total_reach || null,
                age_targeting: payload.aaa_info.age_audience || null,
                gender_targeting: payload.aaa_info.gender_audience || null,
                locations: payload.aaa_info.location_audience || []
            } : null
        };

        const actualCost = payload.credits_charged === 0 ? 0 : baseCostToUser;
        req.user.credits -= actualCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/facebook/adLibrary/ad', actualCost, { id: safeId, url: cleanUrl, trim: safeTrim, cache_max_age }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch ad details." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/adLibrary/ad', 
                params: { id: safeId, url: cleanUrl, trim: safeTrim, cache_max_age }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/facebook/adLibrary/ad', 0, { id: safeId, url: cleanUrl, trim: safeTrim, cache_max_age }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: FACEBOOK AD LIBRARY TRANSCRIPT ---
app.get('/v1/facebook/adLibrary/ad/transcript', authMiddleware, async (req, res) => {
    const { id, url, cache_max_age } = req.query;

    if (!id && !url) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. Provide either 'id' or 'url'." 
        });
    }

    const safeId = id ? id.trim() : null;
    const cleanUrl = url ? url.trim().split('?')[0] : null;

    const expectedMaxCost = 5;
    if (req.user.credits < expectedMaxCost) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires up to ${expectedMaxCost} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/facebook/adLibrary/ad/transcript');
        if (safeId) targetUrl.searchParams.append('id', safeId);
        if (cleanUrl) targetUrl.searchParams.append('url', cleanUrl);
        if (cache_max_age) targetUrl.searchParams.append('cache_max_age', cache_max_age);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(30000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch Facebook Ad transcript'}`
            );
        }

        const responseData = {
            ad_id: payload.ad_id || safeId || "",
            url: payload.url || cleanUrl || "",
            transcript_available: !!payload.transcript_available,
            transcript: payload.transcript || null
        };

        const actualCost = (payload.credits_charged || 0) * 5;
        req.user.credits -= actualCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/facebook/adLibrary/ad/transcript', actualCost, { id: safeId, url: cleanUrl, cache_max_age }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch the transcript." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/adLibrary/ad/transcript', 
                params: { id: safeId, url: cleanUrl, cache_max_age }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/facebook/adLibrary/ad/transcript', 0, { id: safeId, url: cleanUrl, cache_max_age }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: FACEBOOK AD LIBRARY SEARCH ---
app.all('/v1/facebook/adLibrary/search/ads', authMiddleware, async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ success: false, error: "405 Method Not Allowed. Use GET or POST." });
    }

    const params = { ...req.query, ...req.body };
    const { 
        query, sort_by, search_type, ad_type, country, 
        status, media_type, start_date, end_date, cursor, trim 
    } = params;

    if (!query || typeof query !== 'string' || query.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'query'." 
        });
    }

    const cleanQuery = query.trim();

    // Explicitly build the log parameters so un-parseable body artifacts don't crash Supabase
    const logParams = { 
        query: cleanQuery, sort_by, search_type, ad_type, country, 
        status, media_type, start_date, end_date, cursor, trim 
    };

    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/facebook/adLibrary/search/ads');
        
        const requestOptions = {
            method: req.method,
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(30000) 
        };

        if (req.method === 'GET') {
            Object.keys(params).forEach(key => {
                if (params[key]) targetUrl.searchParams.append(key, params[key]);
            });
        } else {
            requestOptions.body = JSON.stringify(params);
        }

        const response = await fetch(targetUrl.toString(), requestOptions);
        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to search Facebook Ad Library'}`
            );
        }

        const responseData = {
            total_results: payload.searchResultsCount || 0,
            has_more: !!payload.cursor,
            cursor: payload.cursor || null,
            ads: Array.isArray(payload.searchResults) ? payload.searchResults.map(ad => {
                const snap = ad.snapshot || {};

                let bodyText = "";
                if (typeof snap.body === 'string') {
                    bodyText = snap.body.replace(/<br\s*\/?>/gi, '\n');
                } else if (snap.body && typeof snap.body.text === 'string') {
                    bodyText = snap.body.text.replace(/<br\s*\/?>/gi, '\n');
                } else if (snap.body && typeof snap.body.markup === 'string') {
                    bodyText = snap.body.markup.replace(/<br\s*\/?>/gi, '\n');
                }

                const adImages = Array.isArray(snap.images) 
                    ? snap.images.map(img => img.resized_image_url || img.original_image_url).filter(Boolean) 
                    : [];
                
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

        const actualCost = payload.credits_charged === 0 ? 0 : costToUser;
        req.user.credits -= actualCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/facebook/adLibrary/search/ads', actualCost, logParams, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch ad library data." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/adLibrary/search/ads', 
                params: logParams, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/facebook/adLibrary/search/ads', 0, logParams, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: FACEBOOK AD LIBRARY COMPANY ADS ---
app.all('/v1/facebook/adLibrary/company/ads', authMiddleware, async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ success: false, error: "405 Method Not Allowed. Use GET or POST." });
    }

    const params = { ...req.query, ...req.body };
    const { 
        pageId, companyName, country, status, media_type, 
        language, sort_by, start_date, end_date, cursor, trim 
    } = params;

    if (!pageId && !companyName) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. Provide either 'pageId' or 'companyName'." 
        });
    }

    const safePageId = pageId ? pageId.trim() : null;
    const safeCompanyName = companyName ? companyName.trim() : null;

    // Explicitly build the log parameters so un-parseable body artifacts don't crash Supabase
    const logParams = { 
        pageId: safePageId, companyName: safeCompanyName, country, status, media_type, 
        language, sort_by, start_date, end_date, cursor, trim 
    };

    const costToUser = 2; // Doubled to 2 credits for the 50% margin
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const upstreamUrl = new URL('https://api.scrapecreators.com/v1/facebook/adLibrary/company/ads');
        
        const requestOptions = {
            method: req.method,
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(30000) 
        };

        if (req.method === 'GET') {
            Object.keys(params).forEach(key => {
                if (params[key]) upstreamUrl.searchParams.append(key, params[key]);
            });
        } else {
            requestOptions.body = JSON.stringify(params);
        }

        const response = await fetch(upstreamUrl.toString(), requestOptions);
        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch company ads'}`
            );
        }

        const responseData = {
            has_more: !!payload.cursor,
            cursor: payload.cursor || null,
            ads: Array.isArray(payload.results) ? payload.results.map(ad => {
                const snap = ad.snapshot || {};

                let bodyText = "";
                if (typeof snap.body === 'string') {
                    bodyText = snap.body.replace(/<br\s*\/?>/gi, '\n');
                } else if (snap.body && typeof snap.body.text === 'string') {
                    bodyText = snap.body.text.replace(/<br\s*\/?>/gi, '\n');
                } else if (snap.body && typeof snap.body.markup === 'string') {
                    bodyText = snap.body.markup.replace(/<br\s*\/?>/gi, '\n');
                }

                const adImages = Array.isArray(snap.images) 
                    ? snap.images.map(img => img.resized_image_url || img.original_image_url).filter(Boolean) 
                    : [];
                
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

        const actualCost = (payload.credits_charged || 0) === 0 ? 0 : costToUser;
        req.user.credits -= actualCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/facebook/adLibrary/company/ads', actualCost, logParams, 200);

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
                params: logParams, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/facebook/adLibrary/company/ads', 0, logParams, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

// --- EXPRESS ROUTE: FACEBOOK MARKETPLACE LOCATION SEARCH ---
app.get('/v1/facebook/marketplace/location/search', authMiddleware, async (req, res) => {
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

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/facebook/marketplace/location/search');
        targetUrl.searchParams.append('query', cleanQuery);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(15000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to search Facebook Marketplace locations'}`
            );
        }

        const responseData = {
            query: cleanQuery,
            locations: Array.isArray(payload.locations) ? payload.locations.map(loc => ({
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

        const actualCost = payload.credits_charged === 0 ? 0 : costToUser;
        req.user.credits -= actualCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/facebook/marketplace/location/search', actualCost, { query: cleanQuery }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch location data." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/marketplace/location/search', 
                params: { query: cleanQuery }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/facebook/marketplace/location/search', 0, { query: cleanQuery }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: FACEBOOK MARKETPLACE SEARCH ---
app.get('/v1/facebook/marketplace/search', authMiddleware, async (req, res) => {
    const { 
        query, lat, lng, radius_km, min_price, max_price, count, 
        sort_by, delivery_method, condition, date_listed, availability, cursor 
    } = req.query;

    if (!query || !lat || !lng) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameters. 'query', 'lat', and 'lng' are required." 
        });
    }

    const cleanQuery = query.trim();
    const safeLat = lat.trim();
    const safeLng = lng.trim();

    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/facebook/marketplace/search');
        targetUrl.searchParams.append('query', cleanQuery);
        targetUrl.searchParams.append('lat', safeLat);
        targetUrl.searchParams.append('lng', safeLng);
        
        if (radius_km) targetUrl.searchParams.append('radius_km', radius_km.trim());
        if (min_price) targetUrl.searchParams.append('min_price', min_price.trim());
        if (max_price) targetUrl.searchParams.append('max_price', max_price.trim());
        if (count) targetUrl.searchParams.append('count', count.trim());
        if (sort_by) targetUrl.searchParams.append('sort_by', sort_by.trim());
        if (delivery_method) targetUrl.searchParams.append('delivery_method', delivery_method.trim());
        if (condition) targetUrl.searchParams.append('condition', condition.trim());
        if (date_listed) targetUrl.searchParams.append('date_listed', date_listed.trim());
        if (availability) targetUrl.searchParams.append('availability', availability.trim());
        if (cursor) targetUrl.searchParams.append('cursor', cursor.trim());

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to search Facebook Marketplace'}`
            );
        }

        const responseData = {
            query: cleanQuery,
            has_next_page: !!payload.has_next_page,
            cursor: payload.cursor || null,
            listings: Array.isArray(payload.listings) ? payload.listings.map(item => ({
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

        const actualCost = payload.credits_charged === 0 ? 0 : costToUser;
        req.user.credits -= actualCost;

        const requestParamsLog = { 
            query: cleanQuery, lat: safeLat, lng: safeLng, radius_km, min_price, max_price, 
            count, sort_by, delivery_method, condition, date_listed, availability, cursor 
        };

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/facebook/marketplace/search', actualCost, requestParamsLog, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch marketplace listings." 
            : error.message;

        const requestParamsLog = { 
            query: cleanQuery, lat: safeLat, lng: safeLng, radius_km, min_price, max_price, 
            count, sort_by, delivery_method, condition, date_listed, availability, cursor 
        };

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/marketplace/search', 
                params: requestParamsLog, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/facebook/marketplace/search', 0, requestParamsLog, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

// --- EXPRESS ROUTE: FACEBOOK MARKETPLACE ITEM ---
app.get('/v1/facebook/marketplace/item', authMiddleware, async (req, res) => {
    const { id, url } = req.query;

    if (!id && !url) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter. Provide either 'id' or 'url'." 
        });
    }

    const safeId = id ? id.trim() : null;
    const cleanUrl = url ? url.trim().split('?')[0] : null; 

    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    try {
        const apiKey = process.env.SCRAPE_CREATORS_API_KEY;
        if (!apiKey) {
            throw new Error("Missing extraction API Key in environment configuration");
        }

        const targetUrl = new URL('https://api.scrapecreators.com/v1/facebook/marketplace/item');
        if (safeId) targetUrl.searchParams.append('id', safeId);
        if (cleanUrl) targetUrl.searchParams.append('url', cleanUrl);

        const response = await fetch(targetUrl.toString(), {
            method: 'GET',
            headers: { 
                'x-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(20000) 
        });

        const payload = await response.json();

        if (!response.ok || !payload.success) {
            throw new Error(
                `Server Error: ${payload.error || response.statusText || 'Failed to fetch Marketplace item details'}`
            );
        }

        const responseData = {
            id: payload.id || safeId || "",
            url: payload.url || cleanUrl || "",
            title: payload.title || "",
            description: payload.description || "",
            creation_time: payload.creation_time || null,
            listing_date_text: payload.listing_date_text || null,
            availability_text: payload.availability_text || null,
            location: {
                text: payload.location_text || "",
                latitude: payload.location?.latitude || null,
                longitude: payload.location?.longitude || null
            },
            price: payload.price ? {
                formatted: payload.price.formatted_amount_zeros_stripped || "",
                amount: payload.price.amount || 0,
                currency: payload.price.currency || "USD"
            } : null,
            category_id: payload.category_id || "",
            attributes: Array.isArray(payload.attributes) ? payload.attributes.map(attr => ({
                name: attr.attribute_name || "",
                value: attr.value || "",
                label: attr.label || ""
            })) : [],
            photos: Array.isArray(payload.photos) ? payload.photos.map(photo => ({
                id: photo.id || "",
                url: photo.url || "",
                width: photo.width || 0,
                height: photo.height || 0
            })) : [],
            status: {
                is_live: !!payload.is_live,
                is_sold: !!payload.is_sold,
                is_pending: !!payload.is_pending,
                is_hidden: !!payload.is_hidden,
                is_shipping_offered: !!payload.is_shipping_offered
            },
            delivery_types: Array.isArray(payload.delivery_types) ? payload.delivery_types : [],
            seller: payload.seller ? {
                id: payload.seller.id || "",
                name: payload.seller.name || "",
                profile_url: payload.seller.profile_url || ""
            } : null
        };

        const actualCost = payload.credits_charged === 0 ? 0 : costToUser;
        req.user.credits -= actualCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/facebook/marketplace/item', actualCost, { id: safeId, url: cleanUrl }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.name === 'TimeoutError' || error.message.includes('Timeout');
        const statusCode = error.message.includes('404') ? 404 : (isTimeout ? 504 : 500);
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch marketplace item data." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/facebook/marketplace/item', 
                params: { id: safeId, url: cleanUrl }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/facebook/marketplace/item', 0, { id: safeId, url: cleanUrl }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: TRUSTPILOT REVIEWS ---
const { scrapeTrustpilotSearch, scrapeTrustpilotReviews } = require('./src/scrapers/trustpilot');

app.get('/v1/trustpilot/reviews', authMiddleware, async (req, res) => {
    const { domain, limit, sort, stars } = req.query;

    if (!domain || typeof domain !== 'string' || domain.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'domain'." 
        });
    }

    const cleanDomain = domain.trim().toLowerCase();
    
    let safeLimit = limit ? parseInt(limit, 10) : 20;
    if (safeLimit > 200) safeLimit = 200; 

    const safeSort = sort ? sort.trim().toLowerCase() : 'recency';
    const safeStars = stars ? stars.toString().trim() : '';

    const costToUser = 5;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    try {
        const payloadData = {
            company: cleanDomain,
            limit: safeLimit 
        };

        if (safeSort === 'recency' || safeSort === 'recent') {
            payloadData.sortBy = 'recent';
        } else if (safeSort === 'relevancy') {
            payloadData.sortBy = 'relevancy';
        } else {
            payloadData.sortBy = 'auto';
        }

        if (safeStars) {
            payloadData.stars = safeStars;
        }

        const apiKey = process.env.ANYAPI_KEY;
        if (!apiKey) throw new Error("Missing extraction API Key in environment");

        const response = await axios.post(
            'https://api.getanyapi.com/v1/run/trustpilot.reviews',
            payloadData,
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000 
            }
        );

        const payload = response.data;

        if (payload.output && payload.output.found === false) {
             // [NEW] LOG 404 AS FAILURE (Cost = 0)
             await logApiRequest(req, '/v1/trustpilot/reviews', 0, { domain: cleanDomain, limit: safeLimit, sort: safeSort, stars: safeStars }, 404);
             
             return res.status(404).json({
                success: false,
                error: `404 Not Found: No reviews found for domain: ${cleanDomain}. Reason: ${payload.output.reason}`
             });
        }

        req.user.credits -= costToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/trustpilot/reviews', costToUser, { domain: cleanDomain, limit: safeLimit, sort: safeSort, stars: safeStars }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            query: {
                domain: cleanDomain,
                limit: safeLimit,
                sort: safeSort,
                stars: safeStars
            },
            data: payload.output.data
        });

    } catch (error) {
        const isTimeout = error.code === 'ECONNABORTED' || (error.message && error.message.includes('timeout'));
        const statusCode = error.response ? error.response.status : (isTimeout ? 504 : 500);
        
        // White-labeled
        let finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch Trustpilot reviews." 
            : error.message;

        if (error.response?.data?.error) {
            finalErrorMsg = `${statusCode} Server Error: ${error.response.data.error}`;
        }

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/trustpilot/reviews', 
                params: { domain: cleanDomain, limit: safeLimit, sort: safeSort, stars: safeStars }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/trustpilot/reviews', 0, { domain: cleanDomain, limit: safeLimit, sort: safeSort, stars: safeStars }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: TRUSTPILOT SEARCH ---
app.get('/v1/trustpilot/search', authMiddleware, async (req, res) => {
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

    try {
        const result = await trustpilotOrchestrator.executeSearch(
            () => scrapeTrustpilotSearch(cleanQuery),
            cleanQuery
        );

        if (!result.success) {
            // [NEW] LOG 503 AS FAILURE (Cost = 0)
            await logApiRequest(req, '/v1/trustpilot/search', 0, { query: cleanQuery }, 503);
            
            return res.status(503).json({
                success: false,
                error: result.error,
                details: result.details
            });
        }

        const responseData = result.data;

        req.user.credits -= result.creditCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/trustpilot/search', result.creditCost, { query: cleanQuery }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: result.creditCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.message.includes('Timeout');
        const statusCode = isTimeout ? 504 : 500;
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction engine took too long to fetch Trustpilot results." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/trustpilot/search', 
                params: { query: cleanQuery }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/trustpilot/search', 0, { query: cleanQuery }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});

const { scrapeYellowpagesAPI } = require('./src/scrapers/yellowpages');

// --- YELLOWPAGES IMPORTS ---
// Assuming scrapeYellowpagesAPI is defined in your scrapers folder
const { scrapeYellowpagesAPI } = require('./src/scrapers/yellowpages');

// --- EXPRESS ROUTE: YELLOWPAGES SEARCH ---
app.get('/v1/yellowpages/search', authMiddleware, async (req, res) => {
    const { term, location, page } = req.query;

    if (!term || !location) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameters. Both 'term' and 'location' are required." 
        });
    }

    const cleanTerm = term.trim();
    const cleanLocation = location.trim();
    const safePage = page ? parseInt(page, 10) : 1;

    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    try {
        // Execute internal scraper module
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

        req.user.credits -= costToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/yellowpages/search', costToUser, { term: cleanTerm, location: cleanLocation, page: safePage }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.message.includes('Timeout') || error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch Yellowpages results." 
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/yellowpages/search', 
                params: { term: cleanTerm, location: cleanLocation, page: safePage }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/yellowpages/search', 0, { term: cleanTerm, location: cleanLocation, page: safePage }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- ZILLOW IMPORTS ---
const { scrapeZillowSearchAPI, scrapeZillowDetailAPI } = require('./src/scrapers/zillow');

// --- EXPRESS ROUTE: ZILLOW SEARCH ---
app.get('/v1/zillow/search', authMiddleware, async (req, res) => {
    const { location, page } = req.query;

    if (!location || typeof location !== 'string' || location.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing 'location'." 
        });
    }

    const cleanLocation = location.trim();
    const safePage = page ? parseInt(page, 10) : 1; 
    const costToUser = 1;

    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits.` 
        });
    }

    try {
        const apiKey = process.env.GETANYAPI_KEY;
        if (!apiKey) throw new Error("Missing extraction API key in environment");

        const payload = {
            location: cleanLocation,
            limit: 25 
        };

        const serverResponse = await axios.post(
            'https://api.getanyapi.com/v1/run/zillow.search',
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000 
            }
        );

        const resultData = serverResponse.data;

        if (resultData.output && resultData.output.found === false) {
            // [NEW] LOG 404 FAILURE (Cost = 0)
            await logApiRequest(req, '/v1/zillow/search', 0, { location: cleanLocation, page: safePage }, 404);

            return res.status(404).json({
                success: false,
                error: `404 Not Found: No listings found for location: ${cleanLocation}. Reason: ${resultData.output.reason}`
            });
        }

        const listings = resultData.output?.data?.items || [];

        const responseData = {
            query: { 
                location: cleanLocation, 
                page: safePage 
            },
            total_results_on_page: listings.length,
            listings: listings
        };

        req.user.credits -= costToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/zillow/search', costToUser, { location: cleanLocation, page: safePage }, 200);

        return res.status(200).json({
            success: true, 
            credits_remaining: req.user.credits, 
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.code === 'ECONNABORTED' || (error.message && error.message.includes('timeout'));
        const statusCode = error.response ? error.response.status : (isTimeout ? 504 : 500);
        
        // White-labeled
        let finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch Zillow listings." 
            : error.message;

        if (error.response?.data?.error) {
            finalErrorMsg = `${statusCode} Server Error: ${error.response.data.error}`;
        }

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/zillow/search', 
                params: { location: cleanLocation, page: safePage }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/zillow/search', 0, { location: cleanLocation, page: safePage }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: ZILLOW ITEM ---
app.get('/v1/zillow/item', authMiddleware, async (req, res) => {
    const { zpid, url } = req.query;

    if (!zpid && !url) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing 'zpid' or 'url'." 
        });
    }

    const safeZpid = zpid ? zpid.trim() : null;
    const cleanUrl = url ? url.trim().split('?')[0] : null;
    
    const targetUrl = cleanUrl || `https://www.zillow.com/homedetails/property/${safeZpid}_zpid/`;

    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits.` 
        });
    }

    try {
        const apiKey = process.env.GETANYAPI_KEY;
        if (!apiKey) throw new Error("Missing extraction API key in environment");

        const payload = {
            url: targetUrl
        };

        const serverResponse = await axios.post(
            'https://api.getanyapi.com/v1/run/zillow.property',
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000 
            }
        );

        const resultData = serverResponse.data;

        if (resultData.output && resultData.output.found === false) {
            // [NEW] LOG 404 FAILURE (Cost = 0)
            await logApiRequest(req, '/v1/zillow/item', 0, { zpid: safeZpid, url: cleanUrl }, 404);

            return res.status(404).json({
                success: false,
                error: `404 Not Found: Property not found. Reason: ${resultData.output.reason}`
            });
        }

        const propertyData = resultData.output?.data?.items?.[0];

        if (!propertyData) {
            throw new Error("Successfully fetched the page, but failed to locate the property data block.");
        }

        req.user.credits -= costToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/zillow/item', costToUser, { zpid: safeZpid, url: cleanUrl }, 200);

        return res.status(200).json({
            success: true, 
            credits_remaining: req.user.credits, 
            credits_charged: costToUser,
            ...propertyData 
        });

    } catch (error) {
        const isTimeout = error.code === 'ECONNABORTED' || (error.message && error.message.includes('timeout'));
        const statusCode = error.response ? error.response.status : (isTimeout ? 504 : 500);
        
        // White-labeled
        let finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch Zillow property details." 
            : error.message;

        if (error.response?.data?.error) {
            finalErrorMsg = `${statusCode} Server Error: ${error.response.data.error}`;
        }

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/zillow/item', 
                params: { zpid: safeZpid, url: cleanUrl }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/zillow/item', 0, { zpid: safeZpid, url: cleanUrl }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- GOOGLE MAPS IMPORTS ---
const { scrapeGoogleMapsSearch, scrapeGoogleMapsReviews } = require('./src/scrapers/gmaps');

// --- EXPRESS ROUTE: GOOGLE MAPS REVIEWS ---
app.get('/v1/gmaps/reviews', authMiddleware, async (req, res) => {
    const { url, limit = 50, sort = 'newest' } = req.query;

    if (!url || typeof url !== 'string' || !url.includes('google.com/maps')) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing or invalid parameter 'url'. Must be a valid Google Maps URL." 
        });
    }

    const cleanUrl = url.trim();
    const sortParam = sort.toLowerCase().trim();
    const parsedLimit = parseInt(limit, 10);

    const costToUser = 2; 
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credits.` 
        });
    }

    try {
        // Execute internal scraper module
        const reviews = await scrapeGoogleMapsReviews(cleanUrl, parsedLimit, sortParam);

        const responseData = {
            place_url: cleanUrl,
            sort: sortParam,
            total_reviews_extracted: reviews.length,
            reviews: reviews
        };

        req.user.credits -= costToUser;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/gmaps/reviews', costToUser, { url: cleanUrl, limit: parsedLimit, sort: sortParam }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: costToUser,
            ...responseData
        });

    } catch (error) {
        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/gmaps/reviews', 
                params: { url: cleanUrl, sort: sortParam, limit: parsedLimit }, 
                statusCode: 500, 
                errorMsg: error.message 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/gmaps/reviews', 0, { url: cleanUrl, limit: parsedLimit, sort: sortParam }, 500);

        return res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});
const { ApifyClient } = require('apify-client');

// --- EXPRESS ROUTE: GOOGLE MAPS SEARCH ---
app.get('/v1/gmaps/search', authMiddleware, async (req, res) => {
    const { query, location, limit } = req.query;

    if (!query || typeof query !== 'string' || query.trim() === '') {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing required parameter 'query'." 
        });
    }

    const cleanQuery = query.trim();
    const targetLocation = location ? location.trim() : "";
    const resultLimit = parseInt(limit, 10) || 50; 

    // Dynamic cost: 1 credit per 20 results (minimum 1 credit).
    const maxPotentialCost = Math.max(1, Math.ceil(resultLimit / 20));

    if (req.user.credits < maxPotentialCost) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. A limit of ${resultLimit} requires at least ${maxPotentialCost} credits.` 
        });
    }

    try {
        const apiKey = process.env.APIFY_API_TOKEN;
        if (!apiKey) throw new Error("Missing extraction API key in environment variables");

        const client = new ApifyClient({ token: apiKey });

        const runInput = {
            searchStringsArray: [cleanQuery],
            locationQuery: targetLocation || undefined,
            maxCrawledPlacesPerSearch: resultLimit,
            language: "en",
            maximumLeadsEnrichmentRecords: 0, 
            maxImages: 0 
        };

        const run = await client.actor("compass/crawler-google-places").call(runInput, { waitSecs: 25 });

        if (run.status !== 'SUCCEEDED') {
             throw new Error("The extraction process took too long to complete. Try reducing the limit parameter.");
        }

        const { items } = await client.dataset(run.defaultDatasetId).listItems();

        const responseData = {
            query: cleanQuery,
            location: targetLocation || null,
            total_results: items.length,
            listings: items.map(item => ({
                title: item.title,
                category: item.categoryName,
                address: item.address,
                phone: item.phoneUnformatted || item.phone,
                website: item.website,
                rating: item.totalScore,
                reviews_count: item.reviewsCount,
                location: item.location 
            }))
        };

        const actualCost = Math.max(1, Math.ceil(items.length / 20));
        req.user.credits -= actualCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/gmaps/search', actualCost, { query: cleanQuery, location: targetLocation, limit: resultLimit }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: actualCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.message.includes('too long to complete');
        const statusCode = isTimeout ? 504 : 500;
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch Google Maps results. Please retry with a smaller limit."
            : error.message || "Internal Server Error";

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/gmaps/search', 
                params: { query: cleanQuery, location: targetLocation, limit: resultLimit }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/gmaps/search', 0, { query: cleanQuery, location: targetLocation, limit: resultLimit }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- AMAZON IMPORTS ---
const { scrapeAmazonStorefront, scrapeAmazonSearchAPI, MARKETPLACE_MAP, scrapeAmazonProductAPI } = require('./src/scrapers/amazon');

// --- EXPRESS ROUTE: AMAZON PRODUCT ---
app.get('/v1/amazon/product', authMiddleware, async (req, res) => {
    const { asin, marketplace = 'us' } = req.query;

    if (!asin || typeof asin !== 'string' || !/^[a-zA-Z0-9]{10}$/.test(asin.trim())) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing or invalid parameter 'asin'. Must be a standard 10-character Amazon ID." 
        });
    }

    const marketCode = marketplace.toString().toLowerCase().trim();
    const cleanAsin = asin.toUpperCase().trim();

    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits.` 
        });
    }

    try {
        const result = await amazonOrchestrator.executeProduct(
            () => scrapeAmazonProductAPI(cleanAsin, marketCode),
            { asin: cleanAsin, country: MARKETPLACE_MAP[marketCode]?.country || 'us' }
        );

        if (!result.success) {
            // [NEW] LOG ORCHESTRATOR FAILURE (Cost = 0)
            await logApiRequest(req, '/v1/amazon/product', 0, { asin: cleanAsin, marketplace: marketCode }, 503);

            return res.status(503).json({
                success: false,
                error: result.error,
                details: result.details
            });
        }

        req.user.credits -= result.creditCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/amazon/product', result.creditCost, { asin: cleanAsin, marketplace: marketCode }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: result.creditCost,
            data: result.data
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

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/amazon/product', 0, { asin: cleanAsin, marketplace: marketCode }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: error.message 
        });
    }
});


// --- EXPRESS ROUTE: AMAZON SEARCH ---
app.get('/v1/amazon/search', authMiddleware, async (req, res) => {
    const { keyword, marketplace = 'us', page = 1 } = req.query;

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

    const costToUser = 2;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    try {
        const result = await amazonOrchestrator.executeSearch(
            () => scrapeAmazonSearchAPI(cleanKeyword, marketCode, pageNum),
            {
                keyword: cleanKeyword,
                marketplace: marketCode,
                country: MARKETPLACE_MAP[marketCode].country,
                page: pageNum
            }
        );

        if (!result.success) {
            // [NEW] LOG ORCHESTRATOR FAILURE (Cost = 0)
            await logApiRequest(req, '/v1/amazon/search', 0, { keyword: cleanKeyword, marketplace: marketCode, page: pageNum }, 503);

            return res.status(503).json({
                success: false,
                error: result.error,
                details: result.details
            });
        }

        const responseData = result.data;

        const productsList = Array.isArray(responseData) 
            ? responseData 
            : (responseData?.products || responseData?.results || []);

        const finalPayload = Array.isArray(responseData)
            ? { products: productsList, total_results: productsList.length }
            : responseData;

        req.user.credits -= result.creditCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/amazon/search', result.creditCost, { keyword: cleanKeyword, marketplace: marketCode, page: pageNum }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: result.creditCost,
            ...finalPayload
        });

    } catch (error) {
        const isTimeout = error.message.includes('timeout') || error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        
        // White-labeled
        let finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch Amazon search results."
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/amazon/search', 
                params: { keyword: cleanKeyword, marketplace: marketCode, page: pageNum }, 
                statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/amazon/search', 0, { keyword: cleanKeyword, marketplace: marketCode, page: pageNum }, statusCode);

        return res.status(statusCode).json({ 
            success: false, 
            error: finalErrorMsg 
        });
    }
});


// --- EXPRESS ROUTE: AMAZON STOREFRONT ---
app.get('/v1/amazon/storefront', authMiddleware, async (req, res) => {
    const { url } = req.query;

    if (!url || typeof url !== 'string' || !url.includes('amazon.com')) {
        return res.status(400).json({ 
            success: false, 
            error: "400 Bad Request: Missing or invalid parameter 'url'. Must be a valid Amazon storefront URL." 
        });
    }

    const cleanUrl = url.trim();

    const costToUser = 1;
    if (req.user.credits < costToUser) {
        return res.status(403).json({ 
            success: false, 
            error: `403 Forbidden: Insufficient credits. This request requires ${costToUser} credit.` 
        });
    }

    try {
        const result = await amazonOrchestrator.executeStorefront(
            () => scrapeAmazonStorefront(cleanUrl),
            { url: cleanUrl }
        );

        if (!result.success) {
            // [NEW] LOG ORCHESTRATOR FAILURE (Cost = 0)
            await logApiRequest(req, '/v1/amazon/storefront', 0, { url: cleanUrl }, 503);

            return res.status(503).json({
                success: false,
                error: result.error,
                details: result.details
            });
        }

        const responseData = result.data;

        req.user.credits -= result.creditCost;

        // [NEW] LOG SUCCESS
        await logApiRequest(req, '/v1/amazon/storefront', result.creditCost, { url: cleanUrl }, 200);

        return res.status(200).json({
            success: true,
            credits_remaining: req.user.credits,
            credits_charged: result.creditCost,
            ...responseData
        });

    } catch (error) {
        const isTimeout = error.message.includes('timeout') || error.name === 'TimeoutError';
        const statusCode = isTimeout ? 504 : 500;
        
        // White-labeled
        const finalErrorMsg = isTimeout 
            ? "504 Gateway Timeout: The extraction server took too long to fetch the Amazon storefront. Protection mechanisms may have blocked the request."
            : error.message;

        if (typeof notifyFailure === 'function') {
            notifyFailure({ 
                endpoint: '/v1/amazon/storefront', 
                params: { url: cleanUrl }, 
                statusCode: statusCode, 
                errorMsg: finalErrorMsg 
            });
        }

        // [NEW] LOG FAILURE (Cost = 0)
        await logApiRequest(req, '/v1/amazon/storefront', 0, { url: cleanUrl }, statusCode);

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
    sequenzy.startSignupListener(supabase);
    sequenzy.startIdleUserScanner(supabase);
});