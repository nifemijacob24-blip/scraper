const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

chromium.use(stealth);

async function scrapeTrustpilotReviews(domain, pageNum = 1, sort = 'recency', stars = '') {
    if (!process.env.PROXY_URL) throw new Error("PROXY_URL missing from environment");

    const proxyUrl = new URL(process.env.PROXY_URL);
    const proxyConfig = {
        server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
        username: proxyUrl.username,
        password: proxyUrl.password
    };

    const cleanDomain = encodeURIComponent(domain.trim());
    
    // Construct the correct Trustpilot review URL with pagination and filters
    const urlObj = new URL(`https://www.trustpilot.com/review/${cleanDomain}`);
    urlObj.searchParams.append('page', pageNum);
    if (sort) urlObj.searchParams.append('sort', sort);
    if (stars) urlObj.searchParams.append('stars', stars);
    
    const targetUrl = urlObj.toString();

    let browser;
    try {
        browser = await chromium.launch({ 
            headless: true, 
            proxy: proxyConfig,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security'
            ]
        });

        const context = await browser.newContext({
            viewport: { width: 1280, height: 720 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            ignoreHTTPSErrors: true
        });

        const page = await context.newPage();

        // Block images and media to save bandwidth, but allow CSS/fonts so Cloudflare Turnstile succeeds
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'media'].includes(type)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });

        // Wait up to 10 seconds specifically for the JSON data block to appear in the DOM
        await page.waitForSelector('#__NEXT_DATA__', { state: 'attached', timeout: 10000 }).catch(() => {});

        const ssrData = await page.evaluate(() => {
            const tag = document.getElementById('__NEXT_DATA__');
            if (!tag || !tag.textContent) return null;
            try { 
                return JSON.parse(tag.textContent); 
            } catch (e) { 
                return null; 
            }
        });

        if (!ssrData) {
            const pageTitle = await page.title();
            throw new Error(`Cloudflare blocked the proxy or challenged it. Page title: ${pageTitle}`);
        }

        await browser.close();
        return extractTrustpilotReviews(ssrData, cleanDomain);

    } catch (error) {
        if (browser) await browser.close();
        throw error;
    }
}

// Strictly map Trustpilot's internal Next.js state into a clean JSON array
function extractTrustpilotReviews(payload, domain) {
    let reviewsList = [];
    
    // 1. Primary extraction path
    if (payload?.props?.pageProps?.reviews) {
        reviewsList = payload.props.pageProps.reviews;
    } else {
        // 2. Deep recursive fallback in case Trustpilot alters their component tree
        function searchReviews(obj) {
            if (!obj || typeof obj !== 'object') return;
            
            if (Array.isArray(obj)) {
                if (obj.length > 0 && (obj[0].rating !== undefined || obj[0].stars !== undefined) && obj[0].text !== undefined) {
                    reviewsList = obj;
                    return;
                }
                for (let item of obj) searchReviews(item);
            } else {
                for (let key in obj) {
                    if (reviewsList.length > 0) return;
                    searchReviews(obj[key]);
                }
            }
        }
        searchReviews(payload);
    }
    
    // Safely map all the requested data points
    const mappedReviews = (Array.isArray(reviewsList) ? reviewsList : []).map(r => {
        const author = r.author || r.consumer || {};
        const reply = r.reply || {};

        // Safe verification parsing
        let isVerified = false;
        if (typeof r.isVerified === 'boolean') {
            isVerified = r.isVerified;
        } else if (Array.isArray(r.labels)) {
            isVerified = r.labels.some(l => typeof l === 'string' ? l.toLowerCase().includes('verified') : l?.key === 'verified');
        } else if (r.labels && typeof r.labels === 'object') {
            isVerified = !!(r.labels.isVerified || r.labels.verification?.isVerified || r.labels.verificationType);
        }
        
        return {
            id: r.id || "",
            rating: r.rating || r.stars || 0,
            title: typeof r.title === 'string' ? r.title : "",
            text: typeof r.text === 'string' ? r.text : "",
            language: r.language || r.locale || "",
            publish_date: r.dates?.publishedDate || r.createdAt || r.publishedAt || null,
            reviewer: {
                id: author.id || "",
                name: author.name || author.displayName || "Anonymous",
                profile_url: author.id ? `https://www.trustpilot.com/users/${author.id}` : null,
                avatar_url: author.imageUrl || author.image?.url || null,
                review_count: author.numberOfReviews || 0
            },
            company_reply: (reply.text || reply.body) ? {
                text: typeof reply.text === 'string' ? reply.text : (typeof reply.body === 'string' ? reply.body : ""),
                publish_date: reply.dates?.publishedDate || reply.createdAt || reply.publishedAt || null
            } : null,
            is_verified: isVerified
        };
    });
    
    // Extract high-level business context for the response
    const businessInfo = payload?.props?.pageProps?.businessUnit || {};
    
    return {
        domain: businessInfo.identifyingName || domain,
        company_name: businessInfo.displayName || "",
        total_reviews: businessInfo.numberOfReviews || 0,
        trust_score: businessInfo.trustScore || 0,
        reviews: mappedReviews
    };
}

async function scrapeTrustpilotSearch(query) {
    if (!process.env.PROXY_URL) throw new Error("PROXY_URL missing from environment");

    const proxyUrl = new URL(process.env.PROXY_URL);
    const proxyConfig = {
        server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
        username: proxyUrl.username,
        password: proxyUrl.password
    };

    const cleanQuery = encodeURIComponent(query.trim());
    const targetUrl = `https://www.trustpilot.com/search?query=${cleanQuery}`;

    let browser;
    try {
        browser = await chromium.launch({ 
            headless: true, 
            proxy: proxyConfig,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security'
            ]
        });

        const context = await browser.newContext({
            viewport: { width: 1280, height: 720 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            ignoreHTTPSErrors: true
        });

        const page = await context.newPage();

        // CRITICAL FIX: Only block images and media. 
        // If we block stylesheets/fonts, Cloudflare Turnstile fails and hangs the page (causing the 504).
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'media'].includes(type)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        // Increase timeout to 35s to allow proxy routing and Cloudflare JS challenge to resolve
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });

        // Wait up to 10 seconds specifically for the JSON data block to appear in the DOM
        await page.waitForSelector('#__NEXT_DATA__', { state: 'attached', timeout: 10000 }).catch(() => {});

        const ssrData = await page.evaluate(() => {
            const tag = document.getElementById('__NEXT_DATA__');
            if (!tag || !tag.textContent) return null;
            try { 
                return JSON.parse(tag.textContent); 
            } catch (e) { 
                return null; 
            }
        });

        if (!ssrData) {
            const pageTitle = await page.title();
            throw new Error(`Cloudflare blocked the proxy or challenged it. Page title: ${pageTitle}`);
        }

        await browser.close();
        return extractTrustpilotBusinesses(ssrData);

    } catch (error) {
        if (browser) await browser.close();
        throw error;
    }
}

// Deep recursive parser to find business nodes
function extractTrustpilotBusinesses(payload) {
    let businesses = [];
    let seenDomains = new Set();

    function searchObj(obj) {
        if (!obj || typeof obj !== 'object') return;

        if (obj.identifyingName && obj.displayName) {
            if (!seenDomains.has(obj.identifyingName)) {
                seenDomains.add(obj.identifyingName);
                
                businesses.push({
                    company_name: obj.displayName || "",
                    trustpilot_domain: obj.identifyingName || "",
                    website: obj.contactUrl || obj.websiteUrl || `https://www.${obj.identifyingName}`,
                    review_page_url: `https://www.trustpilot.com/review/${obj.identifyingName}`,
                    total_reviews: obj.numberOfReviews || 0,
                    trust_score: obj.trustScore || 0
                });
            }
        }

        if (Array.isArray(obj)) {
            for (let item of obj) searchObj(item);
        } else {
            for (let key in obj) {
                searchObj(obj[key]);
            }
        }
    }

    searchObj(payload);
    
    // Sort by review count descending
    return businesses.sort((a, b) => b.total_reviews - a.total_reviews);
}

module.exports = { scrapeTrustpilotSearch,scrapeTrustpilotReviews };