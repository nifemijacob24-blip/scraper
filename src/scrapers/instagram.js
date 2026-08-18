const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

async function fireFailureWebhook(endpoint, target, errorMessage) {
    const webhookUrl = process.env.WEBHOOK_URL;
    if (!webhookUrl) {
        console.log("⚠️ [Webhook] WEBHOOK_URL is missing!");
        return;
    }

    console.log(`📡 [Webhook] Sending alert to Discord for ${target}...`);

    try {
        const payload = {
            content: `🚨 **DaaS Scraper Failure**\n**Endpoint:** \`${endpoint}\`\n**Target:** \`${target}\`\n**Error:** ${errorMessage}`
        };

        const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            console.log("✅ [Webhook] Discord alert sent successfully.");
        } else {
            const text = await res.text();
            console.error(`❌ [Webhook Error] Discord rejected the request: HTTP ${res.status} - ${text}`);
        }
    } catch (err) {
        console.error("❌ [Webhook Error] Network failure:", err.message);
    }
}


function normalizeGql(gql) {
    let type = 'unknown';
    if (gql.is_video) type = 'video';
    else if (gql.edge_sidecar_to_children) type = 'carousel';
    else type = 'image';

    const carousel = [];
    if (type === 'carousel' && gql.edge_sidecar_to_children) {
        for (const edge of gql.edge_sidecar_to_children.edges) {
            carousel.push({
                id: edge.node.id,
                media_type: edge.node.is_video ? 'video' : 'image',
                video_duration: edge.node.video_duration || 0,
                media_urls: {
                    image_high_res: edge.node.display_url || null,
                    video: edge.node.video_url || null
                }
            });
        }
    }

    return {
        id: gql.id,
        shortcode: gql.shortcode,
        media_type: type,
        video_duration: gql.video_duration || 0,
        play_count: gql.video_play_count || gql.video_view_count || gql.play_count || 0,
        like_count: gql.edge_media_preview_like?.count || 0,
        comment_count: gql.edge_media_to_parent_comment?.count || gql.edge_media_to_comment?.count || 0,
        caption: gql.edge_media_to_caption?.edges?.[0]?.node?.text || "",
        media_urls: {
            image_high_res: gql.display_url || null,
            video: gql.video_url || null
        },
        carousel_media: carousel
    };
}

// 2. SINGLE POST & REEL SCRAPER
async function scrapeSinglePost(shortcode) {
    if (!process.env.PROXY_URL) throw new Error("PROXY_URL missing from environment");
    
    const proxyUrl = new URL(process.env.PROXY_URL);
    const proxyConfig = {
        server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
        username: proxyUrl.username, 
        password: proxyUrl.password
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
        let browser, context, page;
        
        try {
            browser = await chromium.launch({ headless: true, proxy: proxyConfig });
            
            context = await browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                extraHTTPHeaders: {
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Sec-Fetch-Dest': 'empty',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'same-origin'
                }
            });

            page = await context.newPage(); 
            
            let interceptedData = null;

            page.on('response', async (res) => {
                const url = res.url();
                if (url.includes('graphql/query') || url.includes('graphql')) {
                    try {
                        const json = await res.json();
                        if (json?.data?.xdt_shortcode_media) {
                            interceptedData = json.data.xdt_shortcode_media;
                        }
                    } catch (e) {}
                }
            });

            // Route directly to /reel/ first. It forces Instagram to expose video tags faster.
            const targetUrl = `https://www.instagram.com/reel/${shortcode}/`;
            
            try {
                await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 15000 });
            } catch (e) {
                console.log("[Navigation] Networkidle timeout bypassed, parsing DOM...");
            }
            
            await page.waitForTimeout(1000);
            let finalData = null;

            if (interceptedData) {
                finalData = normalizeGql(interceptedData);
            } 

            // TACTIC 2: Direct API fetch from inside the page
            if (!finalData || !finalData.media_urls.video) {
                const apiData = await page.evaluate(async (code) => {
                    try {
                        let res = await fetch(`https://www.instagram.com/reel/${code}/?__a=1&__d=dis`, {
                            headers: { 'x-ig-app-id': '936619743392459' }
                        });
                        let json = await res.json();
                        
                        if (!json?.graphql?.shortcode_media && !json?.items?.[0]) {
                            res = await fetch(`https://www.instagram.com/p/${code}/?__a=1&__d=dis`, {
                                headers: { 'x-ig-app-id': '936619743392459' }
                            });
                            json = await res.json();
                        }

                        if (json?.graphql?.shortcode_media) return json.graphql.shortcode_media;
                        
                        if (json?.items?.[0]) {
                            const item = json.items[0];
                            return {
                                id: item.pk, shortcode: item.code,
                                is_video: item.media_type === 2, video_duration: item.video_duration || 0,
                                video_play_count: item.play_count || 0,
                                edge_media_preview_like: { count: item.like_count || 0 },
                                edge_media_to_parent_comment: { count: item.comment_count || 0 },
                                edge_media_to_caption: { edges: [{ node: { text: item.caption?.text || "" } }] },
                                display_url: item.image_versions2?.candidates?.[0]?.url || "",
                                video_url: item.video_versions?.[0]?.url || ""
                            };
                        }
                    } catch (e) { return null; }
                }, shortcode);

                if (apiData) finalData = normalizeGql(apiData);
            }

            // TACTIC 3: Deep DOM regex (Fixed for video_versions array)
            if (!finalData || !finalData.media_urls.video) {
                finalData = await page.evaluate((code) => {
                    const html = document.documentElement.innerHTML;
                    let videoUrl = null;
                    let playCount = 0;
                    
                    // 1. Hunt for the nested video_versions array
                    const vvMatch = html.match(/"video_versions":\s*\[(.*?)\]/);
                    if (vvMatch) {
                        const urlMatch = vvMatch[1].match(/"url":\s*"([^"]+)"/);
                        if (urlMatch) videoUrl = urlMatch[1];
                    }

                    // 2. Hunt for flat video_url
                    if (!videoUrl) {
                        const vuMatch = html.match(/"video_url":\s*"([^"]+)"/);
                        if (vuMatch) videoUrl = vuMatch[1];
                    }

                    // Clean the escaped JSON characters
                    if (videoUrl) {
                        videoUrl = videoUrl.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
                    }

                    const playMatch = html.match(/"video_play_count":(\d+)/) || html.match(/"play_count":(\d+)/) || html.match(/"video_view_count":(\d+)/);
                    if (playMatch) playCount = parseInt(playMatch[1], 10);
                    
                    const getMeta = (prop) => document.querySelector(`meta[property="${prop}"]`)?.content || null;
                    if (!videoUrl) videoUrl = getMeta('og:video');
                    
                    const imgUrl = getMeta('og:image');
                    
                    // THE OVERRIDE: If the image URL contains CLIPS, it is 100% a Reel
                    const isReel = (videoUrl != null) || (imgUrl && imgUrl.includes('CLIPS'));
                    
                    let caption = getMeta('og:title') || "";
                    if (caption.includes(': "')) caption = caption.substring(caption.indexOf(': "') + 3, caption.length - 1);

                    let likeCount = 0, commentCount = 0;
                    const desc = document.querySelector('meta[name="description"]')?.content || "";
                    
                    const parseNum = (str) => {
                        if (!str) return 0;
                        let num = parseFloat(str.replace(/,/g, ''));
                        if (str.toLowerCase().includes('k')) num *= 1000;
                        if (str.toLowerCase().includes('m')) num *= 1000000;
                        return Math.floor(num);
                    };

                    const likesMatch = desc.match(/([\d,.]+[KM]?)\s+Likes/i);
                    if (likesMatch) likeCount = parseNum(likesMatch[1]);
                    
                    const commentsMatch = desc.match(/([\d,.]+[KM]?)\s+Comments/i);
                    if (commentsMatch) commentCount = parseNum(commentsMatch[1]);

                    if (!videoUrl && !imgUrl) return null;

                    return {
                        id: code,
                        shortcode: code,
                        media_type: isReel ? 'video' : 'image', // Guarantees 'video' for the transcript endpoint
                        video_duration: 0,
                        play_count: playCount,
                        like_count: likeCount,
                        comment_count: commentCount,
                        caption: caption,
                        media_urls: {
                            image_high_res: imgUrl,
                            video: videoUrl
                        },
                        carousel_media: []
                    };
                }, shortcode);
            }

            if (!finalData) {
                const html = await page.content();
                if (html.includes('Log In') || html.includes('Sign up')) {
                    throw new Error("Hit a hard login wall on the main post URL.");
                }
                throw new Error("Failed to extract details from network or DOM. Post may be strictly private.");
            }

            await browser.close();
            return { status: "success", data: finalData };

        } catch (error) {
            if (browser) await browser.close();
            
            if (attempt === 3) {
                const finalErrorMsg = `Failed after 3 attempts. Last error: ${error.message}`;
                await fireFailureWebhook('/v1/instagram/post', shortcode, finalErrorMsg);
                
                if (error.statusCode === 404) {
                    return { status: "error", statusCode: 404, error: error.message };
                }
                throw Object.assign(new Error("500: Unable to fetch Instagram post at this time."), { statusCode: 500 });
            }
            
            const backoff = Math.floor(Math.random() * (5000 - 3000) + 3000);
            console.log(`[Instagram Post] Attempt ${attempt} failed (${error.message}). Retrying in ${backoff}ms...`);
            await new Promise(resolve => setTimeout(resolve, backoff));
        }
    }
}

async function scrapeInstagramProfile(username) {
    if (!process.env.PROXY_URL) throw new Error("PROXY_URL missing from environment");
    
    const proxyUrl = new URL(process.env.PROXY_URL);
    const proxyConfig = {
        server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
        username: proxyUrl.username,
        password: proxyUrl.password
    };

    let cleanUsername = username.split('?')[0].replace(/\/$/, '');
    if (cleanUsername.includes('instagram.com/')) {
        cleanUsername = cleanUsername.split('instagram.com/')[1].split('/')[0];
    }
    cleanUsername = cleanUsername.replace('@', '');

    for (let attempt = 1; attempt <= 3; attempt++) {
        let browser, page;
        
        try {
            browser = await chromium.launch({ headless: true, proxy: proxyConfig });
            
            const context = await browser.newContext({
                viewport: { width: 1280, height: 720 },
                userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                extraHTTPHeaders: {
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Sec-Fetch-Dest': 'empty',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'same-origin'
                }
            });

            page = await context.newPage(); 
            
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                // Block media and styles to save proxy bandwidth and speed up execution
                if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
                    route.abort();
                } else {
                    route.continue();
                }
            });

            // Navigate directly to the profile. We know your Decodo proxies allow this!
            await page.goto(`https://www.instagram.com/${cleanUsername}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            
            // Wait for the title to populate, which confirms successful render 
            await page.waitForFunction(() => document.title !== '' && !document.title.includes('Just a moment'), { timeout: 15000 });
            
            if (await page.title() === 'Instagram') {
               throw new Error("Hit soft-login wall on render. Proxy pool IP burned.");
            }

            // The data is embedded in the HTML. Extract it instantly.
            const profileData = await page.evaluate((targetUsername) => {
                const data = {
                    username: targetUsername,
                    full_name: document.title.split('(@')[0].trim(),
                    followers: null,
                    following: null,
                    posts: null,
                    profile_pic_url: document.querySelector('meta[property="og:image"]')?.content || null,
                    biography: null
                };

                // Extract core metrics from the guaranteed Meta description tag
                // Format: "1.5M Followers, 400 Following, 200 Posts - See Instagram photos..."
                const metaDesc = document.querySelector('meta[name="description"]')?.content || '';
                const statsMatch = metaDesc.match(/([\d,bmk.]+)\s+Followers,\s+([\d,bmk.]+)\s+Following,\s+([\d,bmk.]+)\s+Posts/i);
                
                if (statsMatch) {
                    data.followers = statsMatch[1];
                    data.following = statsMatch[2];
                    data.posts = statsMatch[3];
                }

                // Dig out the biography from the JSON state embedded in the script tags
                try {
                    const scripts = Array.from(document.querySelectorAll('script'));
                    for (const script of scripts) {
                        if (script.textContent.includes('biography')) {
                            const bioMatch = script.textContent.match(/"biography":"(.*?)"/);
                            if (bioMatch) {
                                // JSON parse handles unicode escapes (e.g., emojis in bio) safely
                                data.biography = JSON.parse(`"${bioMatch[1]}"`); 
                                break;
                            }
                        }
                    }
                } catch (e) {
                    // Fail silently on deep extraction, core metrics are the priority
                }

                return data;
            }, cleanUsername);

            await browser.close();
            return {
                status: "success",
                data: profileData
            };

        } catch (error) {
            if (browser) await browser.close();
            
            if (attempt === 3) throw new Error(`Playwright Instagram Profile Error: ${error.message}`);
            
            const backoff = Math.floor(Math.random() * (5000 - 3000) + 3000);
            console.log(`[Instagram Profile] Attempt ${attempt} failed. Retrying in ${backoff}ms... | Error: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, backoff));
        }
    }
}






module.exports = { scrapeInstagramProfile,scrapeSinglePost,fireFailureWebhook };