const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

// Inject stealth plugin to strip Playwright's webdriver fingerprint
chromium.use(stealth);

async function scrapeTikTokShopProductsNative(shopUrl, cursor = null, sortBy = 'top', region = 'US') {
    if (!process.env.PROXY_URL) throw new Error("PROXY_URL missing from environment");

    const proxyUrl = new URL(process.env.PROXY_URL);
    const proxyConfig = {
        server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
        username: proxyUrl.username,
        password: proxyUrl.password
    };

    const targetUrl = shopUrl.trim().split('?')[0];

    for (let attempt = 1; attempt <= 3; attempt++) {
        let browser, page;
        let interceptedPayload = null;
        let nextCursor = null;
        let hasMore = false;

        try {
            browser = await chromium.launch({ 
                headless: true, 
                proxy: proxyConfig,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-infobars',
                    '--window-size=1920,1080',
                    '--disable-features=IsolateOrigins,site-per-process'
                ]
            });

            const context = await browser.newContext({
                viewport: { width: 1920, height: 1080 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                locale: 'en-US',
                timezoneId: 'America/New_York',
                extraHTTPHeaders: {
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
                    'Sec-Ch-Ua-Mobile': '?0',
                    'Sec-Ch-Ua-Platform': '"Windows"'
                }
            });

            // Force region cookies
            await context.addCookies([
                { name: 'store-country-code', value: region.toLowerCase(), domain: '.tiktok.com', path: '/' },
                { name: 'store-idc', value: 'useast2a', domain: '.tiktok.com', path: '/' }
            ]);

            page = await context.newPage();

            // WIRETAP: If we are paginating, we must catch the background API call
            page.on('response', async (response) => {
                const url = response.request().url();
                if (url.includes('/api/shop/') || url.includes('/api/commerce/')) {
                    try {
                        const json = await response.json();
                        if (json && json.products) {
                            interceptedPayload = json;
                        }
                    } catch (e) {}
                }
            });

            // Block media to save proxy bandwidth and speed up load times
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'media', 'font'].includes(type)) {
                    route.abort();
                } else {
                    route.continue();
                }
            });

            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

            let shopInfo = {};
            let products = [];

            if (cursor) {
                // PAGINATION MODE: We rely on the frontend to generate X-Bogus.
                // We scroll to the bottom to force the next page to load.
                let waitLoops = 0;
                while (!interceptedPayload && waitLoops < 15) {
                    await page.evaluate(() => window.scrollBy(0, 1500));
                    await new Promise(r => setTimeout(r, 1000));
                    waitLoops++;
                }

                if (!interceptedPayload) {
                    throw new Error("Pagination failed. TikTok refused to load more items or required a captcha.");
                }

                products = parseTikTokProducts(interceptedPayload);
                nextCursor = interceptedPayload.cursor || null;
                hasMore = interceptedPayload.has_more || false;
            } else {
                // FIRST PAGE MODE: Rip the data straight out of the SSR state.
                const ssrData = await page.evaluate(() => {
                    const tag = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__') || document.getElementById('SIGI_STATE');
                    if (!tag || !tag.textContent) return null;
                    try {
                        return JSON.parse(tag.textContent);
                    } catch (e) {
                        return null;
                    }
                });

                if (!ssrData) {
                    throw new Error("Could not find SSR data. TikTok dropped the connection or shadowbanned the IP.");
                }

                shopInfo = extractShopInfo(ssrData);
                products = parseTikTokProducts(ssrData);
                
                // Try to find the next cursor in the SSR state
                const cursorMatch = JSON.stringify(ssrData).match(/"cursor"\s*:\s*"([^"]+)"/);
                nextCursor = cursorMatch ? cursorMatch[1] : null;
                hasMore = products.length >= 10; // Rough estimation if boolean not found
            }

            // De-duplicate products just in case
            products = Array.from(new Map(products.map(p => [p.product_id, p])).values());

            await browser.close();

            return {
                status: "success",
                shopInfo,
                products,
                has_more: hasMore,
                cursor: nextCursor
            };

        } catch (error) {
            if (browser) await browser.close();
            if (attempt === 3) throw new Error(`TikTok Native Shop Error: ${error.message}`);
            
            const backoff = Math.floor(Math.random() * (4000 - 2000) + 2000);
            console.log(`[TikTok Native Shop] Attempt ${attempt} failed: ${error.message}. Retrying...`);
            await new Promise(resolve => setTimeout(resolve, backoff));
        }
    }
}

// Extract the Shop Meta Data
function extractShopInfo(payload) {
    let info = {};
    const str = JSON.stringify(payload);
    
    try {
        const nameMatch = str.match(/"shop_name"\s*:\s*"([^"]+)"/);
        const sellerMatch = str.match(/"seller_id"\s*:\s*"([^"]+)"/);
        const soldMatch = str.match(/"sold_count"\s*:\s*(\d+)/);
        const followerMatch = str.match(/"followers_count"\s*:\s*"([^"]+)"/);
        
        info.shop_name = nameMatch ? nameMatch[1] : "";
        info.seller_id = sellerMatch ? sellerMatch[1] : "";
        info.sold_count = soldMatch ? parseInt(soldMatch[1], 10) : 0;
        info.followers_count = followerMatch ? followerMatch[1] : "0";
    } catch (e) {}
    
    return info;
}

// Deep recursive parser to extract product blocks from TikTok's nested JSON
function parseTikTokProducts(payload) {
    let products = [];
    let seenIds = new Set();

    function searchObj(obj) {
        if (!obj || typeof obj !== 'object') return;

        if ((obj.product_id || obj.productId || obj.id) && (obj.title || obj.name || obj.product_name)) {
            const id = String(obj.product_id || obj.productId || obj.id);
            if (!seenIds.has(id) && (obj.product_price_info || obj.price || obj.seller_info || obj.sold_info)) {
                seenIds.add(id);

                const priceInfo = obj.product_price_info || obj.price || {};
                const rateInfo = obj.rate_info || obj.rating || {};
                const soldInfo = obj.sold_info || obj.sold || {};

                products.push({
                    product_id: id,
                    title: obj.title || obj.name || obj.product_name || "",
                    image: obj.image || obj.cover || null,
                    product_price_info: {
                        currency_symbol: priceInfo.currency_symbol || "$",
                        sale_price_format: priceInfo.sale_price_format || priceInfo.sale_price || "0.00",
                        origin_price_format: priceInfo.origin_price_format || priceInfo.origin_price || null
                    },
                    rate_info: {
                        score: rateInfo.score || rateInfo.rating || 0,
                        review_count: String(rateInfo.review_count || rateInfo.reviews || 0)
                    },
                    sold_info: {
                        sold_count: soldInfo.sold_count || soldInfo.count || 0
                    },
                    seo_url: obj.seo_url || { canonical_url: `https://www.tiktok.com/view/product/${id}` }
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
    return products;
}

module.exports = { scrapeTikTokShopProductsNative };