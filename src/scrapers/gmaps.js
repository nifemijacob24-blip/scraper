const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

chromium.use(stealth);

async function scrapeGoogleMapsSearch(query) {
    if (!process.env.PROXY_URL) throw new Error("PROXY_URL missing from environment");

    const proxyUrl = new URL(process.env.PROXY_URL);
    const proxyConfig = {
        server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
        username: proxyUrl.username,
        password: proxyUrl.password
    };

    const cleanQuery = encodeURIComponent(query.trim());
    const targetUrl = `https://www.google.com/maps/search/${cleanQuery}?hl=en`;

    let browser;
    try {
        browser = await chromium.launch({ 
            headless: true, 
            proxy: proxyConfig,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-dev-shm-usage', 
                '--disable-gpu',           
                '--disable-features=IsolateOrigins,site-per-process', 
                '--js-flags="--max-old-space-size=256"' 
            ]
        });

        const context = await browser.newContext({
            viewport: { width: 1366, height: 768 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            locale: 'en-US', 
            ignoreHTTPSErrors: true
        });

        const page = await context.newPage();

        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'media', 'stylesheet', 'font'].includes(type)) {
                route.abort();
            } else {
                route.continue();
            }
        });

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

        const consentButton = await page.$('button:has-text("Accept all"), button:has-text("Agree")');
        if (consentButton) {
            await consentButton.click().catch(() => {});
        }

        const feedSelector = 'div[role="feed"]';
        await page.waitForSelector(feedSelector, { timeout: 15000 }).catch(() => {});

        const feedElement = await page.$(feedSelector);
        
        if (!feedElement) {
            const title = await page.title();
            if (title.includes('Google Maps')) {
                throw new Error("No search feed found. Google Maps loaded a direct place match, or the proxy was blocked.");
            }
            return [];
        }

        // --- UPGRADED AUTO-SCROLL LOGIC ---
        let previousCount = 0;
        let unchangedCount = 0;
        const scrollStartTime = Date.now();

        // Focus the feed so keyboard events work
        await feedElement.focus().catch(() => {});

        while (unchangedCount < 3) {
            if (Date.now() - scrollStartTime > 45000) {
                console.log("[Maps Scraper] Scroll timeout reached (45s). Extracting results.");
                break;
            }

            await page.evaluate(() => {
                // 1. Scroll the feed container directly
                const feed = document.querySelector('div[role="feed"]');
                if (feed) feed.scrollTop = feed.scrollHeight;
                
                // 2. Scroll the last element into view
                const links = document.querySelectorAll('a[href*="/maps/place/"]');
                if (links.length > 0) {
                    links[links.length - 1].scrollIntoView({ behavior: 'smooth', block: 'end' });
                }
            });
            
            // 3. Simulate pressing the 'End' key to trigger listeners
            await page.keyboard.press('End').catch(() => {});
            
            await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for lazy load

            const currentCount = await page.evaluate(() => document.querySelectorAll('a[href*="/maps/place/"]').length);
            
            if (currentCount === previousCount) {
                const endText = await page.evaluate(() => document.body.innerText.includes("You've reached the end of the list"));
                if (endText) break;
                unchangedCount++;
            } else {
                unchangedCount = 0;
                previousCount = currentCount;
            }

            if (currentCount >= 120) break;
        }

        // --- DOM EXTRACTION (Fixed Reviews & Phone) ---
        const rawListings = await page.evaluate(() => {
            const items = [];
            const links = document.querySelectorAll('a[href*="/maps/place/"]');
            
            links.forEach(a => {
                const url = a.href;
                let container = a.parentElement;
                if (container && container.parentElement) {
                    container = container.parentElement;
                }
                
                const name = a.getAttribute('aria-label') || container.querySelector('.qBF1Pd')?.innerText || "";
                const textContent = container.innerText || "";
                
                let rating = null;
                let reviews = 0;
                let phone = null;
                
                // 1. Phone Extraction
                const phoneRegex = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}/g;
                const matches = textContent.match(phoneRegex);
                if (matches) {
                    const validPhone = matches.find(m => m.replace(/[\s.-]/g, '').length >= 10);
                    if (validPhone) phone = validPhone.trim();
                }

                // 2. Rating & Reviews
                const ratingEl = container.querySelector('[aria-label*="star"]');
                if (ratingEl) {
                    const aria = ratingEl.getAttribute('aria-label'); 
                    const ratingMatch = aria.match(/([\d.]+)\s*(?:stars?|out of)/i);
                    if (ratingMatch) rating = parseFloat(ratingMatch[1]);

                    const reviewMatch = aria.match(/([\d,]+)\s*reviews?/i);
                    if (reviewMatch) reviews = parseInt(reviewMatch[1].replace(/,/g, ''), 10);
                }

                // Fallback for Rating
                if (rating === null) {
                    // Looks strictly for "4.5 (1,234)" format to avoid area codes
                    const ratingTextMatch = textContent.match(/([1-5](?:\.\d)?)\s*\(([\d,]+)\)/);
                    if (ratingTextMatch) {
                        rating = parseFloat(ratingTextMatch[1]);
                        if (reviews === 0) reviews = parseInt(ratingTextMatch[2].replace(/,/g, ''), 10);
                    }
                }

                // Bulletproof Fallback for Reviews
                if (reviews === 0) {
                    // Find a span that contains EXACTLY a number in parentheses, e.g. "(1,234)"
                    const spans = Array.from(container.querySelectorAll('span'));
                    for (const span of spans) {
                        const txt = span.innerText.trim();
                        if (/^\([\d,]+\)$/.test(txt)) {
                            reviews = parseInt(txt.replace(/\D/g, ''), 10);
                            break;
                        }
                    }
                }

                // 3. Coordinates
                let lat = null;
                let lng = null;
                const coordMatch = url.match(/!3d([-.\d]+)!4d([-.\d]+)/);
                if (coordMatch) {
                    lat = parseFloat(coordMatch[1]);
                    lng = parseFloat(coordMatch[2]);
                } else {
                    const atMatch = url.match(/@([-.\d]+),([-.\d]+)/);
                    if (atMatch) {
                        lat = parseFloat(atMatch[1]);
                        lng = parseFloat(atMatch[2]);
                    }
                }
                
                // 4. Place ID
                let place_id = null;
                const placeIdMatch = url.match(/!19s([^?!&]+)/);
                if (placeIdMatch) {
                    place_id = placeIdMatch[1];
                }

                // 5. Website & Domain
                let website = null;
                let domain = null;
                let websiteEl = container.querySelector('a[data-value="Website"]') || 
                                container.querySelector('a[aria-label*="Website" i]');
                
                if (!websiteEl) {
                    websiteEl = Array.from(container.querySelectorAll('a')).find(link => 
                        link.href.startsWith('http') && !link.href.includes('google.com')
                    );
                }

                if (websiteEl && websiteEl.href) {
                    website = websiteEl.href;
                    try {
                        const urlObj = new URL(website);
                        domain = urlObj.hostname.replace(/^www\./i, '');
                    } catch (e) {}
                }

                if (name) {
                    items.push({ name, url, rating, reviews, phone, lat, lng, place_id, website, domain });
                }
            });
            
            const unique = [];
            const seen = new Set();
            for (const item of items) {
                if (!seen.has(item.url)) {
                    seen.add(item.url);
                    unique.push(item);
                }
            }
            return unique;
        });

        await browser.close();
        return rawListings;

    } catch (error) {
        if (browser) await browser.close();
        throw error;
    }
}

const { ApifyClient } = require('apify-client');

async function scrapeGoogleMapsReviews(placeUrl, limit = 50, sort = 'newest') {
    if (!process.env.APIFY_API_TOKEN) throw new Error("APIFY_API_TOKEN missing from environment");

    const client = new ApifyClient({ token: process.env.APIFY_API_TOKEN });

    // Map your API's friendly sort terms to the exact Compass Actor enums
    const sortMapping = {
        'newest': 'newest',
        'relevant': 'mostRelevant',
        'highest': 'highestRanking',
        'lowest': 'lowestRanking'
    };
    
    const apifySort = sortMapping[sort.toLowerCase()] || 'newest';
    const cleanUrl = placeUrl.trim();

    // 1. Prepare the exact JSON schema the Compass actor expects
    const apifyInput = {
        startUrls: [{ url: cleanUrl }],
        maxReviews: parseInt(limit, 10) || 50,
        reviewsSort: apifySort,
        language: "en"
    };

    try {
        // 2. Execute the Actor on Apify's cloud
        const run = await client.actor('compass/google-maps-reviews-scraper').call(apifyInput);
        const { items } = await client.dataset(run.defaultDatasetId).listItems();

        if (!items || items.length === 0) {
            return [];
        }

        // 3. Format Apify's raw output into a clean, standardized JSON array
        return items.map((review, i) => {
            return {
                review_id: review.reviewId || `review_${i}`,
                author_name: review.name || review.reviewerName || "Google User",
                rating: review.stars || review.rating || null,
                text: review.text || review.reviewText || "",
                date_text: review.publishedAtDate || review.publishedAt || review.date || "",
                likes: review.likesCount || 0,
                owner_response: review.responseFromOwnerText || null,
                photos: Array.isArray(review.reviewImageUrls) ? review.reviewImageUrls : (Array.isArray(review.images) ? review.images : [])
            };
        });

    } catch (error) {
        throw new Error(`Apify GMaps Actor Failed: ${error.message}`);
    }
}

module.exports = { scrapeGoogleMapsSearch,scrapeGoogleMapsReviews };