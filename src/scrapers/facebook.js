const { chromium } = require('playwright');

async function scrapeFacebookProfileNative(handleOrUrl) {
    if (!process.env.PROXY_URL) throw new Error("PROXY_URL missing from environment");

    const proxyUrl = new URL(process.env.PROXY_URL);
    const proxyConfig = {
        server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
        username: proxyUrl.username,
        password: proxyUrl.password
    };

    // Normalize handle/URL
    let cleanInput = handleOrUrl.trim().replace(/^@/, '');
    let cleanHandle = cleanInput;

    if (cleanInput.includes('facebook.com/')) {
        cleanHandle = cleanInput.split('facebook.com/')[1].split('/')[0].split('?')[0];
    }
    cleanHandle = cleanHandle.replace(/\/$/, '');

    // Force English locale via URL parameter to bypass proxy IP localization
    const targetUrl = `https://www.facebook.com/${cleanHandle}?locale=en_US`;

    for (let attempt = 1; attempt <= 3; attempt++) {
        let browser, page;

        try {
            browser = await chromium.launch({ headless: true, proxy: proxyConfig });

            const context = await browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                extraHTTPHeaders: {
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate'
                }
            });

            // Set locale cookies before page loads
            await context.addCookies([
                { name: 'locale', value: 'en_US', domain: '.facebook.com', path: '/' },
                { name: 'wd', value: '1280x720', domain: '.facebook.com', path: '/' }
            ]);

            page = await context.newPage();

            // Block media to save proxy bandwidth and speed up scraping
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
                    route.abort();
                } else {
                    route.continue();
                }
            });

            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await page.waitForFunction(() => document.title !== '' && !document.title.includes('Just a moment'), { timeout: 15000 });

            const pageTitle = await page.title();
            if (pageTitle.includes('Log in') || pageTitle.includes('Security Check') || page.url().includes('/login')) {
                throw new Error("Hit Facebook login wall. Proxy IP burned.");
            }

            const profileData = await page.evaluate((handle) => {
                const data = {
                    handle: handle,
                    url: `https://www.facebook.com/${handle}`,
                    name: document.title.split('|')[0].replace('- Home', '').trim(),
                    intro: null,
                    category: null,
                    likes: 0,
                    followers: 0,
                    talking_about: 0,
                    contact: {
                        address: null,
                        phone: null,
                        email: null,
                        website: null
                    },
                    stats: {
                        price_range: null,
                        rating: null
                    },
                    images: {
                        profile_pic: document.querySelector('meta[property="og:image"]')?.content || null,
                        cover_photo: null
                    }
                };

                const html = document.documentElement.innerHTML;
                const text = document.body.innerText;

                function parseNumber(str) {
                    if (!str) return 0;
                    let clean = str.replace(/,/g, '').trim().toUpperCase();
                    if (clean.endsWith('K')) return Math.round(parseFloat(clean) * 1000);
                    if (clean.endsWith('M')) return Math.round(parseFloat(clean) * 1000000);
                    return parseInt(clean, 10) || 0;
                }

                // 1. Meta Description Metrics
                const metaDesc = document.querySelector('meta[name="description"]')?.content || 
                                 document.querySelector('meta[property="og:description"]')?.content || '';

                data.intro = metaDesc;

                const likesMatch = metaDesc.match(/([\d,KMBkmb.]+)\s+likes/i);
                const followersMatch = metaDesc.match(/([\d,KMBkmb.]+)\s+followers/i) || metaDesc.match(/([\d,KMBkmb.]+)\s+people follow/i);
                const talkingMatch = metaDesc.match(/([\d,KMBkmb.]+)\s+talking about/i);

                if (likesMatch) data.likes = parseNumber(likesMatch[1]);
                if (followersMatch) {
                    data.followers = parseNumber(followersMatch[1]);
                } else if (likesMatch) {
                    data.followers = parseNumber(likesMatch[1]);
                }
                if (talkingMatch) data.talking_about = parseNumber(talkingMatch[1]);

                // 2. Extract Outbound External Website URL
                const extLinks = Array.from(document.querySelectorAll('a[href*="l.facebook.com/l.php"]'));
                for (const link of extLinks) {
                    try {
                        const uParam = new URL(link.href).searchParams.get('u');
                        if (uParam && !uParam.includes('facebook.com') && !uParam.includes('instagram.com')) {
                            data.contact.website = uParam;
                            break;
                        }
                    } catch (e) {}
                }

                // 3. Extract Email & Phone
                const mailtoLink = document.querySelector('a[href^="mailto:"]');
                if (mailtoLink) {
                    data.contact.email = mailtoLink.href.replace('mailto:', '').split('?')[0];
                } else {
                    const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
                    if (emailMatch && !emailMatch[0].endsWith('facebook.com') && !emailMatch[0].endsWith('fb.com')) {
                        data.contact.email = emailMatch[0];
                    }
                }

                const telLink = document.querySelector('a[href^="tel:"]');
                if (telLink) {
                    data.contact.phone = telLink.href.replace('tel:', '').trim();
                } else {
                    const phoneMatch = text.match(/(\+?\d{1,2}\s*)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
                    if (phoneMatch) data.contact.phone = phoneMatch[0].trim();
                }

                // 4. Extract Category, Address & Cover Photo from Embedded Relay/Script Data
                const scriptTexts = Array.from(document.querySelectorAll('script')).map(s => s.textContent);
                for (const scriptText of scriptTexts) {
                    if (!data.category) {
                        const catMatch = scriptText.match(/"category_name"\s*:\s*"([^"]+)"/);
                        if (catMatch) data.category = catMatch[1];
                    }

                    if (!data.contact.address) {
                        const addrMatch = scriptText.match(/"single_line_address"\s*:\s*"([^"]+)"/) || 
                                          scriptText.match(/"address_street"\s*:\s*"([^"]+)"/) ||
                                          scriptText.match(/"full_address"\s*:\s*"([^"]+)"/);
                        if (addrMatch) {
                            data.contact.address = addrMatch[1].replace(/\\u[\dA-Fa-f]{4}/g, m => String.fromCharCode(parseInt(m.substr(2), 16)));
                        }
                    }

                    if (!data.images.cover_photo) {
                        const coverMatch = scriptText.match(/"cover_photo"\s*:\s*\{\s*"image"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/) ||
                                           scriptText.match(/"cover_photo_uri"\s*:\s*"([^"]+)"/);
                        if (coverMatch) {
                            data.images.cover_photo = coverMatch[1].replace(/\\/g, '');
                        }
                    }
                }

                // 5. Fallback Address & Price Range
                if (!data.contact.address) {
                    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
                    for (const line of lines) {
                        if (/\d+\s+[A-Za-z0-9\s]+(Rd|Road|St|Street|Ave|Avenue|Blvd|Suite|Ste|Way|Dr|Drive)/i.test(line)) {
                            data.contact.address = line;
                            break;
                        }
                    }
                }

                const priceMatch = text.match(/(\${1,4})/);
                if (priceMatch) data.stats.price_range = priceMatch[1];

                // 6. Cleanup Logic - Remove Empty Objects & Nulls
                if (!data.contact.address && !data.contact.phone && !data.contact.email && !data.contact.website) {
                    delete data.contact;
                } else {
                    for (const key in data.contact) {
                        if (data.contact[key] === null) delete data.contact[key];
                    }
                }

                if (!data.stats.price_range && !data.stats.rating) {
                    delete data.stats;
                } else {
                    for (const key in data.stats) {
                        if (data.stats[key] === null) delete data.stats[key];
                    }
                }

                return data;
            }, cleanHandle);

            await browser.close();

            return {
                status: "success",
                data: profileData
            };

        } catch (error) {
            if (browser) await browser.close();

            if (attempt === 3) throw new Error(`Playwright Facebook Error: ${error.message}`);

            const backoff = Math.floor(Math.random() * (4000 - 2000) + 2000);
            console.log(`[FB Native Scraper] Attempt ${attempt} failed: ${error.message}. Retrying...`);
            await new Promise(resolve => setTimeout(resolve, backoff));
        }
    }
}


async function scrapeFacebookPostNative(postUrl) {
    if (!process.env.PROXY_URL) throw new Error("PROXY_URL missing from environment");

    const proxyUrl = new URL(process.env.PROXY_URL);
    const proxyConfig = {
        server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
        username: proxyUrl.username,
        password: proxyUrl.password
    };

    // Clean URL and force English locale to prevent proxy localization issues
    const targetUrl = `${postUrl.split('?')[0]}?locale=en_US`;

    for (let attempt = 1; attempt <= 3; attempt++) {
        let browser, page;

        try {
            browser = await chromium.launch({ headless: true, proxy: proxyConfig });
            const context = await browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
            });

            await context.addCookies([{ name: 'locale', value: 'en_US', domain: '.facebook.com', path: '/' }]);
            page = await context.newPage();

            // Block media to save proxy bandwidth
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
                    route.abort();
                } else {
                    route.continue();
                }
            });

            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await page.waitForFunction(() => document.title !== '' && !document.title.includes('Just a moment'), { timeout: 15000 });

            if (await page.title() === 'Facebook' || page.url().includes('/login')) {
                throw new Error("Hit Facebook login wall. Proxy IP burned.");
            }

            // Extract the Post/Reel data natively
            const postData = await page.evaluate((url) => {
                const html = document.documentElement.innerHTML;

                const data = {
                    post_id: null,
                    like_count: 0,
                    comment_count: 0,
                    share_count: 0,
                    view_count: 0,
                    description: "",
                    creation_time: null,
                    feedback_id: null,
                    url: url.split('?')[0],
                    image_url: null,
                    video: null,
                    author: {
                        id: null,
                        name: null,
                        is_verified: false,
                        url: null,
                        image: null
                    },
                    music: null
                };

                // Helper to safely parse Regex matches
                function getMatch(regex, group = 1, parseType = 'string') {
                    const match = html.match(regex);
                    if (!match) return null;
                    let val = match[group].replace(/\\/g, ''); // Clean escaped slashes
                    if (parseType === 'int') return parseInt(val, 10);
                    return val;
                }

                // 1. Core Post Metrics
                data.post_id = getMatch(/"post_id"\s*:\s*"(\d+)"/) || getMatch(/"video_id"\s*:\s*"(\d+)"/);
                data.like_count = getMatch(/"reaction_count"\s*:\s*(\d+)/, 1, 'int') || getMatch(/"like_count"\s*:\s*(\d+)/, 1, 'int') || 0;
                data.comment_count = getMatch(/"comment_count"\s*:\s*(\d+)/, 1, 'int') || 0;
                data.share_count = getMatch(/"share_count"\s*:\s*(\d+)/, 1, 'int') || 0;
                data.view_count = getMatch(/"play_count"\s*:\s*(\d+)/, 1, 'int') || getMatch(/"video_view_count"\s*:\s*(\d+)/, 1, 'int') || 0;
                
                // 2. Timestamps & IDs
                const rawCreation = getMatch(/"creation_time"\s*:\s*(\d+)/, 1, 'int');
                if (rawCreation) data.creation_time = new Date(rawCreation * 1000).toISOString();
                data.feedback_id = getMatch(/"feedback_id"\s*:\s*"([^"]+)"/);

                // 3. Text / Description
                const textMatch = html.match(/"message"\s*:\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                if (textMatch) {
                    // Unescape unicode and line breaks
                    data.description = textMatch[1]
                        .replace(/\\n/g, '\n')
                        .replace(/\\"/g, '"')
                        .replace(/\\u[\dA-Fa-f]{4}/g, m => String.fromCharCode(parseInt(m.substr(2), 16)));
                }

                // 4. Author Extraction
                const authorMatch = html.match(/"owner"\s*:\s*\{.*?__typename"\s*:\s*"(User|Page)".*?"id"\s*:\s*"(\d+)".*?"name"\s*:\s*"([^"]+)"/);
                if (authorMatch) {
                    data.author.id = authorMatch[2];
                    data.author.name = authorMatch[3];
                    data.author.url = `https://www.facebook.com/${authorMatch[2]}`;
                    
                    const isVerifiedMatch = html.match(new RegExp(`"id":"${data.author.id}".*?"is_verified":true`));
                    if (isVerifiedMatch) data.author.is_verified = true;
                }

                // 5. Video Details (If it's a Reel/Video)
                const isVideo = html.includes('"playable_duration_in_ms"');
                if (isVideo && data.post_id) {
                    data.video = {
                        id: data.post_id,
                        sd_url: getMatch(/"browser_native_sd_url"\s*:\s*"([^"]+)"/),
                        hd_url: getMatch(/"browser_native_hd_url"\s*:\s*"([^"]+)"/),
                        height: getMatch(/"height"\s*:\s*(\d+)/, 1, 'int'),
                        width: getMatch(/"width"\s*:\s*(\d+)/, 1, 'int'),
                        length_in_second: (getMatch(/"playable_duration_in_ms"\s*:\s*(\d+)/, 1, 'int') || 0) / 1000,
                        thumbnail: getMatch(/"thumbnail_image"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/) || getMatch(/"preferred_thumbnail"\s*:\s*\{\s*"image"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/),
                        captions_url: getMatch(/"captions_url"\s*:\s*"([^"]+)"/)
                    };
                } else {
                    // It's a photo/image post
                    data.image_url = getMatch(/"image"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/) || getMatch(/"viewer_image"\s*:\s*\{\s*"uri"\s*:\s*"([^"]+)"/);
                }

                // 6. Cleanup empty objects
                if (!data.video) delete data.video;
                if (!data.author.id) data.author = null;

                return data;
            }, targetUrl);

            await browser.close();
            return { status: "success", data: postData };

        } catch (error) {
            if (browser) await browser.close();
            if (attempt === 3) throw new Error(`Playwright Facebook Post Error: ${error.message}`);
            
            const backoff = Math.floor(Math.random() * (4000 - 2000) + 2000);
            console.log(`[FB Native Post] Attempt ${attempt} failed: ${error.message}. Retrying...`);
            await new Promise(resolve => setTimeout(resolve, backoff));
        }
    }
}


module.exports = { scrapeFacebookProfileNative,scrapeFacebookPostNative };