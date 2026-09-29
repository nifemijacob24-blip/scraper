const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { ApifyClient } = require('apify-client');
const { HttpsProxyAgent } = require('https-proxy-agent');
const axios = require('axios');
const cheerio = require('cheerio');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';


chromium.use(stealth);

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
    if (!process.env.PROXY_URL) throw new Error("PROXY_URL missing from environment");

    const code = marketplace.toLowerCase().trim();
    let targetMarket = MARKETPLACE_MAP[code];
    if (!targetMarket) {
        targetMarket = MARKETPLACE_MAP['us'];
    }

    let pageNum = parseInt(page, 10);
    if (!pageNum) {
        pageNum = 1;
    }

    const encodedKeyword = encodeURIComponent(keyword.trim());
    const searchUrl = `https://www.${targetMarket.domain}/s?k=${encodedKeyword}&page=${pageNum}`;

    const response = await axios.get(searchUrl, {
        httpsAgent: new HttpsProxyAgent(process.env.PROXY_URL),
        timeout: 60000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        }
    });

    const parser = cheerio.load(response.data);
    const pageTitle = parser('title').text();

    if (pageTitle.includes('Robot Check')) throw new Error("Amazon served a CAPTCHA. Retry request.");
    if (pageTitle.includes('CAPTCHA')) throw new Error("Amazon served a CAPTCHA. Retry request.");

    const products = [];
    const seenAsins = new Set();

    parser('div[data-asin]:not([data-asin=""])').each((i, el) => {
        const element = parser(el);
        const asin = element.attr('data-asin')?.trim();

        if (!asin) return;
        if (asin.length !== 10) return;
        if (seenAsins.has(asin)) return;

        let name = element.find('h2 a span, h2 span, h2 a').first().text().trim();
        if (!name) {
            const altText = element.find('img.s-image').attr('alt');
            if (altText) {
                name = altText.trim();
            } else {
                name = "";
            }
        }

        if (!name) return;
        const lowerName = name.toLowerCase();
        if (lowerName.includes('overall pick')) return;
        if (lowerName.includes('featured from our brands')) return;

        let price = null;
        const priceOffscreen = element.find('.a-price .a-offscreen').first().text().trim();
        if (priceOffscreen) {
            let priceMatch = priceOffscreen.match(/[\d,]+\.\d{2}/);
            if (!priceMatch) {
                priceMatch = priceOffscreen.match(/[\d,]+/);
            }
            if (priceMatch) {
                price = parseFloat(priceMatch[0].replace(/,/g, ''));
            }
        }

        if (price === null) {
            const whole = element.find('.a-price-whole').first().text().replace(/[^0-9]/g, '');
            let fraction = element.find('.a-price-fraction').first().text().replace(/[^0-9]/g, '');
            if (!fraction) {
                fraction = '00';
            }
            if (whole) {
                price = parseFloat(`${whole}.${fraction}`);
            }
        }

        let rating = null;
        const ratingText = element.find('i[class*="a-icon-star"] span, .a-icon-alt').first().text().trim();
        if (ratingText) {
            let ratingMatch = ratingText.match(/([\d.]+)\s*out of/i);
            if (!ratingMatch) {
                ratingMatch = ratingText.match(/^([\d.]+)/);
            }
            if (ratingMatch) {
                rating = parseFloat(ratingMatch[1]);
            }
        }

        let reviews_count = null;
        const reviewsText = element.find('span[aria-label*="ratings"], a[href*="#customerReviews"] span, span.a-size-base.s-underline-text').first().text().trim();
        if (reviewsText) {
            const reviewsMatch = reviewsText.replace(/,/g, '').match(/\d+/);
            if (reviewsMatch) {
                reviews_count = parseInt(reviewsMatch[0], 10);
            }
        }

        let image = element.find('img.s-image').attr('src');
        if (!image) {
            image = "";
        }

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
    if (!process.env.PROXY_URL) throw new Error("PROXY_URL missing from environment");

    const code = marketplace.toLowerCase().trim();
    let targetMarket = MARKETPLACE_MAP[code];
    if (!targetMarket) {
        targetMarket = MARKETPLACE_MAP['us'];
    }
    
    const cleanAsin = asin.toUpperCase().trim();
    const targetUrl = `https://www.${targetMarket.domain}/dp/${cleanAsin}?th=1&psc=1`;

    const response = await axios.get(targetUrl, {
        httpsAgent: new HttpsProxyAgent(process.env.PROXY_URL),
        timeout: 60000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        }
    });

    const parser = cheerio.load(response.data);
    const htmlBody = parser.html();
    const pageTitle = parser('title').text();

    if (pageTitle.includes('Robot Check')) throw new Error("Amazon served a CAPTCHA. Retry request.");
    if (pageTitle.includes('CAPTCHA')) throw new Error("Amazon served a CAPTCHA. Retry request.");

    const title = parser('#productTitle').text().trim();
    if (!title) {
        throw new Error(`Product not found. The ASIN '${cleanAsin}' may be invalid.`);
    }

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

    parser('script[type="application/ld+json"]').each((_, el) => {
        try {
            const data = JSON.parse(parser(el).html());
            let item = data;
            if (Array.isArray(data)) {
                item = data[0];
            }
            if (item['@type'] === 'Product' || item['@type'] === 'ItemPage') {
                if (item.brand && item.brand.name) product.brand = cleanText(item.brand.name);
                if (item.description) product.about_product = cleanText(item.description);
                
                let offers = item.offers;
                if (Array.isArray(offers)) {
                    offers = offers.find(o => o.price || o.lowPrice);
                }
                
                if (offers) {
                    if (offers.price) {
                        product.price = parseFloat(offers.price);
                    } else if (offers.lowPrice) {
                        product.price = parseFloat(offers.lowPrice);
                    }
                    
                    if (offers.priceCurrency === 'GBP') {
                        product.currency = '£';
                    } else if (offers.priceCurrency === 'EUR') {
                        product.currency = '€';
                    }
                }
            }
        } catch (e) {}
    });

    if (!product.brand) {
        let brandText = parser('#bylineInfo, #brand, .po-brand .a-span9').first().text();
        brandText = cleanText(brandText).replace(/^Visit the /i, '').replace(/ Store$/i, '').replace(/^Brand:\s*/i, '');
        if (brandText) {
            product.brand = brandText;
        } else {
            product.brand = title.split(' ')[0];
        }
    }

    if (!product.price) {
        let twisterPrice = parser('#twister-plus-price-data-price').val();
        if (!twisterPrice) {
            twisterPrice = parser('#twister-plus-price-data-price-core').val();
        }
        if (twisterPrice) {
            const parsed = parseFloat(twisterPrice);
            if (!isNaN(parsed) && parsed > 0) product.price = parsed;
        }
    }

    if (!product.price) {
        const priceSelectors = [
            '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
            '#corePrice_desktop .a-price .a-offscreen',
            '#price_inside_buybox',
            '#newBuyBoxPrice',
            '.priceToPay .a-offscreen',
            '.apexPriceToPay .a-offscreen',
            '#priceblock_ourprice',
            '#priceblock_dealprice',
            '.a-price-range .a-price:first-child .a-offscreen',
            'span.a-price span.a-offscreen'
        ];

        for (const selector of priceSelectors) {
            parser(selector).each((_, el) => {
                if (product.price) return;
                const priceText = parser(el).text();
                let priceMatch = priceText.replace(/\s/g, '').match(/[\d,]+\.\d{2}/);
                if (!priceMatch) {
                    priceMatch = priceText.replace(/\s/g, '').match(/[\d,]+/);
                }
                
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

    if (!product.price) {
        const rawMatches = [
            ...htmlBody.matchAll(/"priceAmount":\s*([\d.]+)/g),
            ...htmlBody.matchAll(/&quot;priceAmount&quot;:\s*([\d.]+)/g),
            ...htmlBody.matchAll(/"displayPrice":"[^0-9]*([\d.]+)"/g)
        ];
        
        for (const m of rawMatches) {
            const parsed = parseFloat(m[1]);
            if (!isNaN(parsed) && parsed > 0 && parsed < 50000) {
                product.price = parsed;
                break;
            }
        }
    }

    let ratingText = parser('#acrPopover').attr('title');
    if (!ratingText) {
        ratingText = parser('.a-icon-star .a-icon-alt').first().text();
    }
    if (ratingText) {
        const rMatch = ratingText.match(/([\d.]+)\s*out of/i);
        if (rMatch) product.rating = parseFloat(rMatch[1]);
    }

    const reviewText = parser('#acrCustomerReviewText').first().text();
    if (reviewText) {
        const revMatch = reviewText.replace(/,/g, '').match(/\d+/);
        if (revMatch) product.reviews_count = parseInt(revMatch[0], 10);
    }

    parser('#wayfinding-breadcrumbs_feature_div ul li a').each((_, el) => {
        const cat = cleanText(parser(el).text());
        if (cat) product.categories.push(cat);
    });

    let availText = parser('#availability span').first().text();
    if (availText) {
        product.availability = cleanText(availText);
    } else {
        product.availability = "Unknown";
    }

    if (htmlBody.includes('icon-prime')) {
        product.is_prime = true;
    } else if (htmlBody.includes('prime-logo')) {
        product.is_prime = true;
    }

    parser('#feature-bullets li span.a-list-item').each((_, el) => {
        const point = cleanText(parser(el).text());
        if (point && !point.toLowerCase().includes('make sure this fits')) {
            product.description.push(point);
        }
    });

    const imageSet = new Set();
    parser('#altImages img').each((_, el) => {
        const src = parser(el).attr('src');
        if (src && src.includes('/images/I/') && !src.includes('play-button')) {
            const highResUrl = src.replace(/\._.*?_\./g, '.');
            imageSet.add(highResUrl);
        }
    });
    product.images = Array.from(imageSet);

    parser('#productDetails_techSpec_section_1 tr, #prodDetails tr').each((_, el) => {
        const key = cleanText(parser(el).find('th, td.prodDetSectionEntry').text());
        const value = cleanText(parser(el).find('td:not(.prodDetSectionEntry)').text());
        if (key && value) product.specifications[key] = value;
    });

    if (Object.keys(product.specifications).length === 0) {
        parser('#detailBullets_feature_div li').each((_, el) => {
            const text = parser(el).text();
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

    const variantSet = new Set();
    parser('[data-defaultasin], [data-dp-url]').each((_, el) => {
        let dpUrl = parser(el).attr('data-dp-url');
        if (!dpUrl) dpUrl = "";
        
        let vAsin = parser(el).attr('data-defaultasin');
        if (!vAsin) {
            const urlMatch = dpUrl.match(/\/dp\/([A-Z0-9]{10})/);
            if (urlMatch) vAsin = urlMatch[1];
        }

        if (vAsin && vAsin.toUpperCase() !== cleanAsin) {
            variantSet.add(vAsin.toUpperCase());
        }
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
    let proxyPort = proxyUrl.port;
    if (!proxyPort) {
        if (proxyUrl.protocol === 'https:') {
            proxyPort = '443';
        } else {
            proxyPort = '80';
        }
    }
    
    const proxyConfig = {
        server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyPort}`,
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

        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                let distance = 500;
                let timer = setInterval(() => {
                    let scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;

                    if (totalHeight >= scrollHeight - window.innerHeight) {
                        clearInterval(timer);
                        resolve();
                    } else if (totalHeight > 15000) {
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
            
            const cards = document.querySelectorAll('[data-asin], li[class*="item"], div[class*="ProductGridItem"], div[class*="style__item__"]');
            
            cards.forEach(card => {
                let asin = card.getAttribute('data-asin');
                if (!asin) {
                    const link = card.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
                    if (link) {
                        const m = link.getAttribute('href').match(/\/(?:dp|product)\/([A-Z0-9]{10})/i);
                        if (m) asin = m[1].toUpperCase();
                    }
                }
                
                if (!asin) return;
                if (seenAsins.has(asin)) return;
                
                const ignoredASINs = new Set(['B084KP3NG6', 'B0DVBL912R', 'B079RQCGVB']);
                if (ignoredASINs.has(asin)) return;

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

                if (!name) {
                    const lines = (card.innerText || "").split('\n').map(l => l.trim());
                    const validLine = lines.find(l => l.length > 10 && !l.includes('$') && !l.toLowerCase().includes('out of'));
                    if (validLine) name = validLine;
                }

                if (!name) return;
                
                name = name.replace(/^Sponsored\s*/i, '').replace(/\n/g, ' ').trim();
                const lowerName = name.toLowerCase();
                
                if (lowerName.includes('overall pick')) return;
                if (lowerName.includes('products highlighted')) return;

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
                        const rawText = card.innerText.replace(/\s+/g, '');
                        const pMatch = rawText.match(/\$([\d,]+\.\d{2})/);
                        if (pMatch) price = parseFloat(pMatch[1].replace(/,/g, ''));
                    }
                }

                let rating = null;
                const ratingEl = card.querySelector('[aria-label*="out of 5"], [title*="out of 5"], .a-icon-alt, i[class*="star"]');
                
                if (ratingEl) {
                    let rText = ratingEl.getAttribute('aria-label');
                    if (!rText) rText = ratingEl.getAttribute('title');
                    if (!rText) rText = ratingEl.innerText;
                    if (!rText) rText = "";
                    
                    const rMatch = rText.match(/([\d.]+)\s*out of/i);
                    if (rMatch) rating = parseFloat(rMatch[1]);
                }

                if (rating === null) {
                    const rawText = card.innerText;
                    if (rawText) {
                        const rawMatch = rawText.match(/([\d.]+)\s*out of\s*5/i);
                        if (rawMatch) rating = parseFloat(rawMatch[1]);
                    }
                }

                let image = "";
                const img = card.querySelector('img');
                if (img) {
                    image = img.getAttribute('src');
                    if (!image) image = img.getAttribute('data-src');
                    if (!image) image = "";
                }

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

module.exports = { scrapeAmazonStorefront, scrapeAmazonSearchAPI, MARKETPLACE_MAP, scrapeAmazonProductAPI };