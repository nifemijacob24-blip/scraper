
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { ApifyClient } = require('apify-client');


chromium.use(stealth);

const axios = require('axios');
const cheerio = require('cheerio');

// Map user-friendly marketplace codes to Amazon TLDs and ScraperAPI country codes
const MARKETPLACE_MAP = {
    us: { domain: 'amazon.com', country: 'us' },
    uk: { domain: 'amazon.co.uk', country: 'gb' },
    de: { domain: 'amazon.de', country: 'de' },
    ca: { domain: 'amazon.ca', country: 'ca' },
    fr: { domain: 'amazon.fr', country: 'fr' },
    es: { domain: 'amazon.es', country: 'es' },
    it: { domain: 'amazon.it', country: 'it' },
    in: { domain: 'amazon.in', country: 'in' },
    jp: { domain: 'amazon.co.jp', country: 'jp' },
    au: { domain: 'amazon.com.au', country: 'au' }
};

async function scrapeAmazonSearchAPI(keyword, marketplace = 'us', page = 1) {
    if (!process.env.SCRAPER_API_KEY) throw new Error("SCRAPER_API_KEY missing from environment");

    const code = marketplace.toLowerCase().trim();
    const targetMarket = MARKETPLACE_MAP[code] || MARKETPLACE_MAP['us'];

    const pageNum = parseInt(page, 10) || 1;
    const encodedKeyword = encodeURIComponent(keyword.trim());
    const searchUrl = `https://www.${targetMarket.domain}/s?k=${encodedKeyword}&page=${pageNum}`;

    const response = await axios.get('https://api.scraperapi.com/', {
        params: {
            api_key: process.env.SCRAPER_API_KEY,
            url: searchUrl,
            premium: 'true',
            country_code: targetMarket.country,
            render: 'true'
        },
        timeout: 60000
    });

    const $ = cheerio.load(response.data);

    if ($('title').text().includes('Robot Check') || $('title').text().includes('CAPTCHA')) {
        throw new Error("Amazon served a CAPTCHA to the proxy. Retry request.");
    }

    const products = [];
    const seenAsins = new Set();

    // Target all search result card containers with a valid ASIN
    $('div[data-asin]:not([data-asin=""])').each((i, el) => {
        const $el = $(el);
        const asin = $el.attr('data-asin')?.trim();

        if (!asin || asin.length !== 10 || seenAsins.has(asin)) return;

        // Extract Title
        let name = $el.find('h2 a span, h2 span, h2 a').first().text().trim();
        if (!name) {
            name = $el.find('img.s-image').attr('alt')?.trim() || "";
        }

        // Filter out promotional ads/banners that carry an ASIN but no real title
        if (!name || name.toLowerCase().includes('overall pick') || name.toLowerCase().includes('featured from our brands')) {
            return;
        }

        // Extract Price
        let price = null;
        const priceOffscreen = $el.find('.a-price .a-offscreen').first().text().trim();
        if (priceOffscreen) {
            const priceMatch = priceOffscreen.match(/[\d,]+\.\d{2}/) || priceOffscreen.match(/[\d,]+/);
            if (priceMatch) {
                price = parseFloat(priceMatch[0].replace(/,/g, ''));
            }
        }

        // Fallback for whole + fraction price spans
        if (price === null) {
            const whole = $el.find('.a-price-whole').first().text().replace(/[^0-9]/g, '');
            const fraction = $el.find('.a-price-fraction').first().text().replace(/[^0-9]/g, '') || '00';
            if (whole) {
                price = parseFloat(`${whole}.${fraction}`);
            }
        }

        // Extract Rating
        let rating = null;
        const ratingText = $el.find('i[class*="a-icon-star"] span, .a-icon-alt').first().text().trim();
        if (ratingText) {
            const ratingMatch = ratingText.match(/([\d.]+)\s*out of/i) || ratingText.match(/^([\d.]+)/);
            if (ratingMatch) {
                rating = parseFloat(ratingMatch[1]);
            }
        }

        // Extract Reviews Count
        let reviews_count = null;
        const reviewsText = $el.find('span[aria-label*="ratings"], a[href*="#customerReviews"] span, span.a-size-base.s-underline-text').first().text().trim();
        if (reviewsText) {
            const reviewsMatch = reviewsText.replace(/,/g, '').match(/\d+/);
            if (reviewsMatch) {
                reviews_count = parseInt(reviewsMatch[0], 10);
            }
        }

        // Extract Image
        const image = $el.find('img.s-image').attr('src') || "";

        seenAsins.add(asin);
        products.push({
            asin,
            name: name.substring(0, 200),
            price,
            rating,
            reviews_count,
            image,
            url: `https://www.${targetMarket.domain}/dp/${asin}`
        });
    });

    return products;
}

const cleanText = (str) => {
    if (!str) return "";
    return str.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '')
              .replace(/\s\s+/g, ' ')
              .trim();
};

async function scrapeAmazonProductAPI(asin, marketplace = 'us') {
    if (!process.env.SCRAPER_API_KEY) throw new Error("SCRAPER_API_KEY missing from environment");

    const code = marketplace.toLowerCase().trim();
    const targetMarket = MARKETPLACE_MAP[code] || MARKETPLACE_MAP['us'];
    const cleanAsin = asin.toUpperCase().trim();

    const targetUrl = `https://www.${targetMarket.domain}/dp/${cleanAsin}?th=1&psc=1`;

    const response = await axios.get('https://api.scraperapi.com/', {
        params: {
            api_key: process.env.SCRAPER_API_KEY,
            url: targetUrl,
            premium: 'true',
            country_code: targetMarket.country,
            render: 'true'
        },
        timeout: 60000
    });

    const $ = cheerio.load(response.data);
    const htmlBody = $.html();

    if ($('title').text().includes('Robot Check') || $('title').text().includes('CAPTCHA')) {
        throw new Error("Amazon served a CAPTCHA to the proxy. The provider will rotate IPs on the next request.");
    }

    const title = $('#productTitle').text().trim();
    if (!title) {
        throw new Error(`Product not found. The ASIN '${cleanAsin}' may be invalid or unavailable in the '${code}' marketplace.`);
    }

    const cleanText = (text) => text ? text.replace(/\s+/g, ' ').trim() : '';

    const product = {
        asin: cleanAsin,
        title: title,
        brand: "",
        price: null,
        currency: "$",
        rating: null,
        reviews_count: null,
        availability: "",
        is_prime: false,
        categories: [],
        images: [],
        description: [],
        about_product: "",
        specifications: {},
        variants: [],
        url: targetUrl
    };

    // --- 1. HIDDEN JSON-LD SCHEMA EXTRACTION ---
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const data = JSON.parse($(el).html());
            const item = Array.isArray(data) ? data[0] : data;
            if (item['@type'] === 'Product' || item['@type'] === 'ItemPage') {
                if (item.brand && item.brand.name) product.brand = cleanText(item.brand.name);
                if (item.description) product.about_product = cleanText(item.description);
                
                if (item.offers) {
                    if (item.offers.price) product.price = parseFloat(item.offers.price);
                    else if (item.offers.lowPrice) product.price = parseFloat(item.offers.lowPrice); 
                    
                    if (item.offers.priceCurrency) {
                        if (item.offers.priceCurrency === 'GBP') product.currency = '£';
                        else if (item.offers.priceCurrency === 'EUR') product.currency = '€';
                    }
                }
            }
        } catch (e) {}
    });

    // --- 2. BRAND FALLBACKS ---
    if (!product.brand) {
        let brandText = $('#bylineInfo, #brand, .po-brand .a-span9').first().text();
        brandText = cleanText(brandText).replace(/^Visit the /i, '').replace(/ Store$/i, '').replace(/^Brand:\s*/i, '');
        product.brand = brandText || title.split(' ')[0]; 
    }

    // --- 3A. AGGRESSIVE DOM PRICE EXTRACTION ---
    if (!product.price) {
        const priceSelectors = [
            '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
            '#corePrice_desktop .a-price .a-offscreen',
            '.priceToPay .a-offscreen',
            '.apexPriceToPay .a-offscreen',
            '#priceblock_ourprice',
            '#priceblock_dealprice',
            '.a-price-range .a-price:first-child .a-offscreen', // Grabs lower end of range
            'span.a-price span.a-offscreen' // Ultimate fallback
        ];

        // Loop through all matching nodes across all selectors
        for (const selector of priceSelectors) {
            $(selector).each((_, el) => {
                if (product.price) return; // Skip if already found
                const priceText = $(el).text();
                const priceMatch = priceText.replace(/\s/g, '').match(/[\d,]+\.\d{2}/) || priceText.replace(/\s/g, '').match(/[\d,]+/);
                
                if (priceMatch) {
                    const parsedPrice = parseFloat(priceMatch[0].replace(/,/g, ''));
                    if (parsedPrice > 0) {
                        product.price = parsedPrice;
                        if (priceText.includes('£')) product.currency = '£';
                        else if (priceText.includes('€')) product.currency = '€';
                    }
                }
            });
            if (product.price) break;
        }
    }

    // --- 3B. THE "TWISTER MATRIX" REGEX RIPPER ---
    // If the DOM is completely empty because it's a parent ASIN without a size selected,
    // we rip the price directly out of Amazon's hidden frontend variables.
    if (!product.price) {
        const rawMatches = [
            ...htmlBody.matchAll(/"priceAmount":\s*([\d.]+)/g),
            ...htmlBody.matchAll(/&quot;priceAmount&quot;:\s*([\d.]+)/g),
            ...htmlBody.matchAll(/"displayPrice":"[^0-9]*([\d.]+)"/g),
            ...htmlBody.matchAll(/data-asin-price="([\d.]+)"/g),
            ...htmlBody.matchAll(/value="([\d.]+)"\s+id="twister-plus-price-data-price"/g),
            ...htmlBody.matchAll(/"lowPrice":\s*([\d.]+)/g)
        ];
        
        for (const m of rawMatches) {
            const parsed = parseFloat(m[1]);
            if (!isNaN(parsed) && parsed > 0) {
                product.price = parsed;
                break;
            }
        }
    }

    // --- 4. RATINGS & REVIEWS ---
    const ratingText = $('#acrPopover').attr('title') || $('.a-icon-star .a-icon-alt').first().text();
    if (ratingText) {
        const rMatch = ratingText.match(/([\d.]+)\s*out of/i);
        if (rMatch) product.rating = parseFloat(rMatch[1]);
    }

    const reviewText = $('#acrCustomerReviewText').first().text();
    if (reviewText) {
        const revMatch = reviewText.replace(/,/g, '').match(/\d+/);
        if (revMatch) product.reviews_count = parseInt(revMatch[0], 10);
    }

    // --- 5. CATEGORIES / BREADCRUMBS ---
    $('#wayfinding-breadcrumbs_feature_div ul li a').each((_, el) => {
        const cat = cleanText($(el).text());
        if (cat) product.categories.push(cat);
    });

    // --- 6. AVAILABILITY & PRIME STATUS ---
    product.availability = cleanText($('#availability span').first().text()) || "Unknown";
    if (htmlBody.includes('icon-prime') || htmlBody.includes('prime-logo')) {
        product.is_prime = true;
    }

    // --- 7. BULLET POINTS EXTRACTION ---
    $('#feature-bullets li span.a-list-item').each((_, el) => {
        const point = cleanText($(el).text());
        if (point && !point.toLowerCase().includes('make sure this fits')) {
            product.description.push(point);
        }
    });

    // --- 8. TRUE HIGH-RES IMAGE GALLERY ---
    const imageSet = new Set();
    $('#altImages img').each((_, el) => {
        const src = $(el).attr('src');
        if (src && src.includes('/images/I/') && !src.includes('play-button')) {
            const highResUrl = src.replace(/\._.*?_\./g, '.');
            imageSet.add(highResUrl);
        }
    });
    product.images = Array.from(imageSet);

    // --- 9. GHOST-CHARACTER FREE SPECIFICATIONS ---
    $('#productDetails_techSpec_section_1 tr, #prodDetails tr').each((_, el) => {
        const key = cleanText($(el).find('th, td.prodDetSectionEntry').text());
        const value = cleanText($(el).find('td:not(.prodDetSectionEntry)').text());
        if (key && value) product.specifications[key] = value;
    });

    if (Object.keys(product.specifications).length === 0) {
        $('#detailBullets_feature_div li').each((_, el) => {
            const text = $(el).text();
            const parts = text.split(':');
            if (parts.length >= 2) {
                const key = cleanText(parts[0]);
                const val = cleanText(parts.slice(1).join(':'));
                if (key && val && !key.toLowerCase().includes('customer reviews')) {
                    product.specifications[key] = val;
                }
            }
        });
    }

    // --- 10. DEEP VARIANT EXTRACTION ---
    const variantSet = new Set();

    $('[data-defaultasin], [data-dp-url]').each((_, el) => {
        const dpUrl = $(el).attr('data-dp-url') || "";
        const vAsin = $(el).attr('data-defaultasin') || (dpUrl.match(/\/dp\/([A-Z0-9]{10})/) || [])[1];
        if (vAsin && vAsin.toUpperCase() !== cleanAsin) variantSet.add(vAsin.toUpperCase());
    });

    const variantRegex = /"asin":"(B[A-Z0-9]{9})"/gi;
    let match;
    while ((match = variantRegex.exec(htmlBody)) !== null) {
        if (match[1] !== cleanAsin) variantSet.add(match[1]);
    }

    product.variants = Array.from(variantSet);

    return product;
}

async function scrapeAmazonStorefront(storeUrl) {
    if (!process.env.PROXY_URL) throw new Error("PROXY_URL missing from environment");

    const proxyUrl = new URL(process.env.PROXY_URL);
    const proxyConfig = {
        server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
        username: proxyUrl.username,
        password: proxyUrl.password
    };

    let browser;
    try {
        browser = await chromium.launch({ 
            headless: true, 
            proxy: proxyConfig,
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            locale: 'en-US'
        });

        const page = await context.newPage();
        
        const targetUrl = storeUrl.split('?')[0].split('ref=')[0];
        
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Scroll to force Amazon's React widgets to render
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                let distance = 500;
                let timer = setInterval(() => {
                    let scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;

                    // Stop if we hit the bottom or scroll too deep (failsafe)
                    if (totalHeight >= scrollHeight - window.innerHeight || totalHeight > 15000) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 150);
            });
        });

        await new Promise(r => setTimeout(r, 2000));

        const products = await page.evaluate(() => {
            const results = [];
            const seenAsins = new Set();
            
            // Targets BOTH Influencer Shops and React Brand Stores
            const cards = document.querySelectorAll('[data-asin], li[class*="item"], div[class*="ProductGridItem"], div[class*="style__item__"]');
            
            cards.forEach(card => {
                // 1. ASIN Extraction
                let asin = card.getAttribute('data-asin');
                if (!asin) {
                    const link = card.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
                    if (link) {
                        const m = link.getAttribute('href').match(/\/(?:dp|product)\/([A-Z0-9]{10})/i);
                        if (m) asin = m[1].toUpperCase();
                    }
                }
                
                // Ignore Amazon Credit Card Ads
                const ignoredASINs = new Set(['B084KP3NG6', 'B0DVBL912R', 'B079RQCGVB']);
                if (!asin || seenAsins.has(asin) || ignoredASINs.has(asin)) return;

                // 2. Title Extraction
                let name = "";
                const titleEl = card.querySelector('h2, [class*="title" i], [class*="name" i], .a-truncate-cut');
                
                if (titleEl && titleEl.innerText.trim().length > 5) {
                    name = titleEl.innerText.trim();
                }
                
                if (!name) {
                    const img = card.querySelector('img');
                    if (img && img.alt && img.alt.length > 5 && !img.alt.toLowerCase().includes('image')) {
                        name = img.alt.trim();
                    } else if (img && img.title && img.title.length > 5) {
                        name = img.title.trim();
                    }
                }

                // Fallback: Split raw text to find the title
                if (!name) {
                    const lines = (card.innerText || "").split('\n').map(l => l.trim());
                    const validLine = lines.find(l => l.length > 10 && !l.includes('$') && !l.toLowerCase().includes('out of'));
                    if (validLine) name = validLine;
                }

                // Clean artifacts and skip promotional banners
                name = name.replace(/^Sponsored\s*/i, '').replace(/\n/g, ' ').trim();
                if (!name || name.toLowerCase().includes('overall pick') || name.toLowerCase().includes('products highlighted')) return;

                // 3. Price Extraction
                let price = null;
                const offscreen = card.querySelector('.a-price .a-offscreen');
                
                if (offscreen) {
                    const pMatch = offscreen.innerText.match(/\$([\d,]+(?:\.\d{2})?)/);
                    if (pMatch) price = parseFloat(pMatch[1].replace(/,/g, ''));
                }

                if (!price) {
                    const whole = card.querySelector('.a-price-whole, [class*="priceWhole" i], [class*="whole" i]');
                    const fraction = card.querySelector('.a-price-fraction, [class*="priceFraction" i], [class*="fraction" i]');
                    
                    if (whole && fraction) {
                        const w = whole.innerText.replace(/[^0-9]/g, '');
                        const f = fraction.innerText.replace(/[^0-9]/g, '');
                        if (w) price = parseFloat(`${w}.${f}`);
                    } else {
                        // Regex over the raw string block. Matches the FIRST valid price to prevent fusion.
                        const rawText = card.innerText.replace(/\s+/g, '');
                        const pMatch = rawText.match(/\$([\d,]+\.\d{2})/);
                        if (pMatch) price = parseFloat(pMatch[1].replace(/,/g, ''));
                    }
                }

                // 4. Rating Extraction
                let rating = null;
                const ratingEl = card.querySelector('[aria-label*="out of 5"], .a-icon-alt');
                if (ratingEl) {
                    const rText = ratingEl.getAttribute('aria-label') || ratingEl.innerText || "";
                    const rMatch = rText.match(/([\d.]+)\s*out of/i);
                    if (rMatch) rating = parseFloat(rMatch[1]);
                }

                // 5. Image Extraction
                const img = card.querySelector('img');
                const image = img ? (img.getAttribute('src') || img.getAttribute('data-src') || "") : "";

                // Strict filter: MUST have a valid price and a valid title to return!
                if (price !== null && price > 0 && name.length > 5) {
                    seenAsins.add(asin);
                    results.push({ 
                        asin, 
                        name: name.substring(0, 200), 
                        price, 
                        rating, 
                        image, 
                        url: `https://www.amazon.com/dp/${asin}` 
                    });
                }
            });
            return results;
        });

        await browser.close();
        return products;

    } catch (error) {
        if (browser) await browser.close();
        throw error;
    }
}


module.exports = { scrapeAmazonStorefront,scrapeAmazonSearchAPI,MARKETPLACE_MAP,scrapeAmazonProductAPI };