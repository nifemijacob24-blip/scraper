const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

// Inject stealth evasions to bypass Fastly WAF
chromium.use(stealth);

async function scrapeSubredditDetails(subredditName) {
    if (!process.env.PROXY_URL) throw new Error("PROXY_URL missing from environment");
    
    // Parse the Decodo proxy string so Playwright can authenticate
    const proxyUrl = new URL(process.env.PROXY_URL);
    const proxyConfig = {
        server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
        username: proxyUrl.username,
        password: proxyUrl.password
    };

    // 3-Attempt Retry Loop for stability
    for (let attempt = 1; attempt <= 3; attempt++) {
        let browser;
        try {
            browser = await chromium.launch({ 
                headless: true, 
                proxy: proxyConfig 
            });
            
            const context = await browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            });

            // Bypass the NSFW/18+ warning screen instantly
            await context.addCookies([{ 
                name: 'over18', 
                value: '1', 
                domain: '.reddit.com', 
                path: '/' 
            }]);

            const page = await context.newPage();
            const url = `https://www.reddit.com/r/${subredditName}/`;

            // Wait until the DOM is loaded. We don't need all the images/ads.
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            
            // Wait for Reddit's modern UI to render the header component
            await page.waitForSelector('shreddit-subreddit-header', { timeout: 15000 }).catch(() => {});
            
            // Wait an extra 2 seconds for Reddit's JS to fetch the numbers and hydrate the UI
            await page.waitForTimeout(2000);

            // Execute extraction logic in the browser context
            // Wait an extra 2 seconds for Reddit's JS to fetch the numbers and hydrate the UI
            await page.waitForTimeout(2000);

            // Execute extraction logic in the browser context
            const data = await page.evaluate(async (subreddit) => {
                const header = document.querySelector('shreddit-subreddit-header');
                let subscribers = 0, activeUsers = 0, description = "";
                let header_img = null, icon_img = null;
                let weekly_contributions = 0;
                let rulesText = "";

                if (header) {
                    description = header.getAttribute('description') || "";
                    
                    // --- GRAB METRICS ---
                    subscribers = parseInt(header.getAttribute('weekly-active-users') || '0', 10);
                    weekly_contributions = parseInt(header.getAttribute('weekly-contributions') || '0', 10);
                    
                    if (subscribers === 0) subscribers = parseInt(header.getAttribute('subscribers') || '0', 10);
                    if (activeUsers === 0) activeUsers = parseInt(header.getAttribute('active') || '0', 10);
                }

                // --- GRAB IMAGES ---
                const iconElement = document.querySelector('img.shreddit-subreddit-icon__icon, img[src*="communityIcon"]');
                if (iconElement) icon_img = iconElement.getAttribute('src');
                
                const bannerElement = document.querySelector('img[src*="banner"], img[src*="mobileBanner"]');
                if (bannerElement) header_img = bannerElement.getAttribute('src');

                // --- GRAB RULES (NEW JSON API CALL) ---
                try {
                    // Fetch the rules directly from Reddit's API while inside the WAF bypass
                    const rulesResponse = await fetch(`https://www.reddit.com/r/${subreddit}/about/rules.json`);
                    if (rulesResponse.ok) {
                        const rulesData = await rulesResponse.json();
                        // Reddit returns an array of rule objects, we just need their short_names
                        if (rulesData && rulesData.rules && rulesData.rules.length > 0) {
                            rulesText = rulesData.rules.map(r => r.short_name).join(' | ');
                        }
                    }
                } catch (e) {
                    console.log("Failed to fetch rules JSON: " + e.message);
                }

                return { 
                    subscribers, 
                    activeUsers, 
                    description, 
                    header_img, 
                    icon_img, 
                    rules: rulesText, 
                    weekly_contributions
                };
            }, subredditName); // Pass the subredditName into the evaluate function

            await browser.close();
            await browser.close();

            // Format the final Data-as-a-Service JSON payload
            return {
                subreddit_id: `r/${subredditName}`,
                display_name: subredditName,
                // If activeUsers is 0 (new UI), default to subscribers count for safety
                weekly_active_users: data.activeUsers > 0 ? (data.activeUsers * 7) : data.subscribers, 
                weekly_contributions: data.weekly_contributions, 
                rules: data.rules, 
                description: data.description,
                header_img: data.header_img,
                icon_img: data.icon_img,
                subscribers: data.subscribers,
                advertiser_category: "",
                created_at: new Date().toISOString(),
                submit_text: ""
            };

        } catch (error) {
            // Ensure the browser closes even if the try block fails
            if (browser) await browser.close();
            
            if (attempt === 3) {
                throw new Error(`Playwright Scraper Error after 3 attempts: ${error.message}`);
            }
            
            console.log(`[Scraper] Timeout or blocked. Retrying in 3 seconds... (${attempt}/3)`);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
}

// --- 1. UPDATED SCRAPER FUNCTION ---
async function scrapeSubredditPosts(subredditName, sort = 'hot', timeframe = 'all', cursor = null, limit = 100) {
    if (!process.env.PROXY_URL) throw new Error("PROXY_URL missing from environment");
    
    const proxyUrl = new URL(process.env.PROXY_URL);
    const proxyConfig = {
        server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
        username: proxyUrl.username,
        password: proxyUrl.password
    };

    // Construct the target URL
    const targetUrl = new URL(`https://www.reddit.com/r/${subredditName}/${sort}.json`);
    
    targetUrl.searchParams.append('raw_json', '1');
    targetUrl.searchParams.append('limit', limit.toString()); // Now dynamic based on user input
    
    if (sort === 'top' || sort === 'controversial') {
        targetUrl.searchParams.append('t', timeframe);
    }
    
    // Map the standard 'cursor' term to Reddit's 'after' parameter
    if (cursor) {
        targetUrl.searchParams.append('after', cursor);
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
        let browser;
        try {
            browser = await chromium.launch({ headless: true, proxy: proxyConfig });
            const context = await browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            });

            await context.addCookies([{ name: 'over18', value: '1', domain: '.reddit.com', path: '/' }]);

            const page = await context.newPage();
            
            await page.goto(`https://www.reddit.com/r/${subredditName}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(1500); 

            const jsonPayload = await page.evaluate(async (fetchUrl) => {
                const response = await fetch(fetchUrl);
                if (!response.ok) throw new Error(`Reddit API returned status ${response.status}`);
                return await response.json();
            }, targetUrl.toString());

            await browser.close();

            // Return posts and the next pagination token
            return {
                posts: jsonPayload.data.children.map(child => child.data),
                next_cursor: jsonPayload.data.after
            };

        } catch (error) {
            if (browser) await browser.close();
            if (attempt === 3) throw new Error(`Playwright Posts Scraper Error: ${error.message}`);
            
            console.log(`[Posts Scraper] Timeout or blocked. Retrying in 3s... (${attempt}/3)`);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
}



function formatRedditSearch(rawChildren) {
    const formatted = { posts: [], comments: [], media: [] };
    let positionCounter = 0;

    rawChildren.forEach(child => {
        const data = child.data;
        const kind = child.kind;
        positionCounter++;

        if (kind === 't3') {
            const postObj = {
                id: data.name,
                post_id: data.name,
                title: data.title,
                url: data.url,
                permalink: data.permalink,
                nsfw: data.over_18 || false,
                spoiler: data.spoiler || false,
                is_crosspost: !!data.crosspost_parent,
                subreddit: { id: data.subreddit_id, name: data.subreddit, nsfw: data.subreddit_type === "nfsw" },
                votes: data.ups,
                num_comments: data.num_comments,
                created_at: new Date(data.created_utc * 1000).toISOString(),
                thumbnail: (data.thumbnail && data.thumbnail.startsWith('http')) ? data.thumbnail : null,
                position: positionCounter
            };
            formatted.posts.push(postObj);

            if (data.post_hint === 'image' || (data.url && data.url.match(/\.(jpeg|jpg|gif|png)$/))) {
                formatted.media.push({
                    id: data.name,
                    title: data.title,
                    url: data.url,
                    permalink: data.permalink,
                    media_type: data.is_video ? 'video' : 'image',
                    image: {
                        src: data.url,
                        width: data.preview?.images[0]?.source?.width || null,
                        height: data.preview?.images[0]?.source?.height || null
                    },
                    nsfw: data.over_18 || false,
                    spoiler: data.spoiler || false,
                    subreddit: postObj.subreddit,
                    position: positionCounter
                });
            }
        } else if (kind === 't1') {
            formatted.comments.push({
                id: data.name,
                post_id: data.link_id,
                parent_comment_id: data.parent_id !== data.link_id ? data.parent_id : null,
                is_reply_to_comment: data.parent_id !== data.link_id,
                author: data.author,
                body: data.body,
                votes: data.ups,
                permalink: data.permalink,
                created_at: new Date(data.created_utc * 1000).toISOString(),
                subreddit: { id: data.subreddit_id, name: data.subreddit },
                position: positionCounter
            });
        }
    });

    return formatted;
}

// --- 1. UPDATED SEARCH SCRAPER FUNCTION ---
async function scrapeSubredditSearch(subredditName, query, sort = 'relevance', timeframe = 'all', cursor = null, limit = 100) {
    if (!process.env.PROXY_URL) throw new Error("PROXY_URL missing from environment");
    
    const proxyUrl = new URL(process.env.PROXY_URL);
    const proxyConfig = {
        server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
        username: proxyUrl.username,
        password: proxyUrl.password
    };

    const targetUrl = new URL(`https://www.reddit.com/r/${subredditName}/search.json`);
    targetUrl.searchParams.append('q', query);
    targetUrl.searchParams.append('restrict_sr', '1');
    targetUrl.searchParams.append('raw_json', '1');
    targetUrl.searchParams.append('limit', limit.toString()); // Now dynamic
    targetUrl.searchParams.append('sort', sort);
    targetUrl.searchParams.append('t', timeframe);
    
    // Map cursor to Reddit's 'after' parameter
    if (cursor) targetUrl.searchParams.append('after', cursor);

    for (let attempt = 1; attempt <= 3; attempt++) {
        let browser;
        try {
            browser = await chromium.launch({ headless: true, proxy: proxyConfig });
            const context = await browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            });

            await context.addCookies([{ name: 'over18', value: '1', domain: '.reddit.com', path: '/' }]);
            const page = await context.newPage();
            
            await page.goto(`https://www.reddit.com/r/${subredditName}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(1500);

            const jsonPayload = await page.evaluate(async (fetchUrl) => {
                const response = await fetch(fetchUrl);
                if (!response.ok) throw new Error(`Reddit API returned status ${response.status}`);
                return await response.json();
            }, targetUrl.toString());

            await browser.close();

            // Format the data BEFORE returning it to server.js
            const formattedData = formatRedditSearch(jsonPayload.data.children);
            
            return {
                ...formattedData,
                next_cursor: jsonPayload.data.after // Expose standard cursor naming
            };

        } catch (error) {
            if (browser) await browser.close();
            if (attempt === 3) throw new Error(`Playwright Search Scraper Error: ${error.message}`);
            console.log(`[Search Scraper] Timeout or blocked. Retrying in 3s... (${attempt}/3)`);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
}




function parseCommentsTree(childrenArray) {
    const items = [];
    let more = { has_more: false, cursor: null };

    for (const child of childrenArray) {
        if (child.kind === 't1') { // It's a Comment
            const c = child.data;
            
            // Build the core comment object
            const parsedComment = {
                ...c, // Spread raw data to keep all Reddit fields
                url: `https://www.reddit.com${c.permalink}`,
                created_at_iso: new Date(c.created_utc * 1000).toISOString(),
                replies: { items: [], more: { has_more: false, cursor: null } }
            };

            // Recursively process replies if they exist
            if (c.replies && c.replies.data && c.replies.data.children) {
                parsedComment.replies = parseCommentsTree(c.replies.data.children);
            }

            items.push(parsedComment);
        } else if (child.kind === 'more') { // It's a Pagination Token
            more = {
                has_more: true,
                cursor: child.data.children.join(',') // Comma-separated IDs for the next request
            };
        }
    }

    return { items, more };
}

// --- 1. UPDATED FORMATTER ---
function formatRedditPostAndComments(rawJson) {
    // rawJson[0] is the post, rawJson[1] is the comment tree
    const postData = rawJson[0].data.children[0].data;
    const commentsData = rawJson[1].data.children;

    const parsedCommentsTree = parseCommentsTree(commentsData);

    return {
        post: {
            ...postData,
            created_at_iso: new Date(postData.created_utc * 1000).toISOString()
        },
        comments: parsedCommentsTree.items,
        // Standardize the pagination naming for your API consumers
        next_cursor: parsedCommentsTree.more && parsedCommentsTree.more.length > 0 ? parsedCommentsTree.more[0] : null,
        more: parsedCommentsTree.more
    };
}


// --- 2. UPDATED SCRAPER FUNCTION ---
async function scrapePostComments(postUrl, limit = 100, cursor = null) {
    if (!process.env.PROXY_URL) throw new Error("PROXY_URL missing from environment");
    
    const proxyUrl = new URL(process.env.PROXY_URL);
    const proxyConfig = {
        server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
        username: proxyUrl.username,
        password: proxyUrl.password
    };

    // Clean URL to ensure we append .json correctly
    const baseUrl = postUrl.split('?')[0].replace(/\/$/, '');
    const targetUrl = new URL(`${baseUrl}.json`);
    
    targetUrl.searchParams.append('raw_json', '1');
    targetUrl.searchParams.append('limit', limit.toString());
    
    // Reddit comment threads use the 'comment' param to focus the tree on a specific comment ID
    if (cursor) {
        targetUrl.searchParams.append('comment', cursor);
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
        let browser;
        try {
            browser = await chromium.launch({ headless: true, proxy: proxyConfig });
            const context = await browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            });

            await context.addCookies([{ name: 'over18', value: '1', domain: '.reddit.com', path: '/' }]);
            const page = await context.newPage();
            
            await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(1500);

            const jsonPayload = await page.evaluate(async (fetchUrl) => {
                const response = await fetch(fetchUrl);
                if (!response.ok) throw new Error(`Reddit API returned status ${response.status}`);
                return await response.json();
            }, targetUrl.toString());

            await browser.close();

            // Format before returning
            return formatRedditPostAndComments(jsonPayload);

        } catch (error) {
            if (browser) await browser.close();
            if (attempt === 3) throw new Error(`Playwright Comments Scraper Error: ${error.message}`);
            console.log(`[Comments Scraper] Timeout or blocked. Retrying in 3s... (${attempt}/3)`);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
}




async function scrapeGlobalSearch(query, sort = 'relevance', timeframe = 'all', after = null) {
    if (!process.env.PROXY_URL) throw new Error("PROXY_URL missing from environment");
    
    const proxyUrl = new URL(process.env.PROXY_URL);
    const proxyConfig = {
        server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
        username: proxyUrl.username,
        password: proxyUrl.password
    };

    // --- CONSTRUCT THE GLOBAL SEARCH JSON URL ---
    // Example: https://www.reddit.com/search.json?q=webscraping&raw_json=1
    const targetUrl = new URL(`https://www.reddit.com/search.json`);
    
    targetUrl.searchParams.append('q', query);
    targetUrl.searchParams.append('raw_json', '1');
    targetUrl.searchParams.append('limit', '100');
    targetUrl.searchParams.append('sort', sort);
    targetUrl.searchParams.append('t', timeframe);
    
    if (after) {
        targetUrl.searchParams.append('after', after);
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
        let browser;
        try {
            browser = await chromium.launch({ headless: true, proxy: proxyConfig });
            const context = await browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            });

            await context.addCookies([{ name: 'over18', value: '1', domain: '.reddit.com', path: '/' }]);
            const page = await context.newPage();
            
            // STEP 1: Navigate to the visual search page to clear the WAF
            await page.goto(`https://www.reddit.com/search/?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(1500);

            // STEP 2: Fetch the JSON from inside the cleared context
            const jsonPayload = await page.evaluate(async (fetchUrl) => {
                const response = await fetch(fetchUrl);
                if (!response.ok) throw new Error(`Reddit API returned status ${response.status}`);
                return await response.json();
            }, targetUrl.toString());

            await browser.close();

            // Inject the `created_at_iso` field into each post to match your exact schema
            const formattedPosts = jsonPayload.data.children.map(child => {
                const post = child.data;
                return {
                    ...post,
                    created_at_iso: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null
                };
            });

            return {
                posts: formattedPosts,
                after: jsonPayload.data.after
            };

        } catch (error) {
            if (browser) await browser.close();
            if (attempt === 3) throw new Error(`Playwright Global Search Error: ${error.message}`);
            console.log(`[Global Search Scraper] Timeout or blocked. Retrying in 3s... (${attempt}/3)`);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
}

module.exports = { scrapeSubredditDetails,scrapeSubredditPosts,scrapeSubredditSearch,scrapePostComments,scrapeGlobalSearch };