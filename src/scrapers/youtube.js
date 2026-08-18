// --- 1. YOUTUBE CHANNEL SCRAPER (RAW FETCH + ytInitialData) ---
// --- 1. YOUTUBE CHANNEL SCHEMA SCRAPER ---
async function scrapeYouTubeChannelInfo(input) {
    let targetUrl = input;

    // Normalize Input
    if (!input.startsWith('http')) {
        if (input.startsWith('UC') && input.length === 24) {
            targetUrl = `https://www.youtube.com/channel/${input}`;
        } else {
            const cleanHandle = input.startsWith('@') ? input : `@${input}`;
            targetUrl = `https://www.youtube.com/${cleanHandle}`;
        }
    }

    try {
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) {
            const err = new Error(`YouTube returned HTTP ${response.status}`);
            err.statusCode = response.status === 404 ? 404 : 500;
            throw err;
        }

        const html = await response.text();
        const match = html.match(/var ytInitialData = ({.*?});<\/script>/);

        if (!match || !match[1]) {
            throw new Error("Could not locate ytInitialData. YouTube may have blocked the IP.");
        }

        const ytData = JSON.parse(match[1]);
        const metadata = ytData.metadata?.channelMetadataRenderer;
        
        if (!metadata) {
            const err = new Error("404 Not Found: Channel unavailable.");
            err.statusCode = 404;
            throw err;
        }

        // --- Helper: Convert "2.75M" to 2750000 ---
        const parseSubCount = (text) => {
            if (!text) return 0;
            const clean = text.replace(/subscribers?/i, '').trim();
            if (clean.includes('K')) return Math.round(parseFloat(clean) * 1000);
            if (clean.includes('M')) return Math.round(parseFloat(clean) * 1000000);
            return parseInt(clean.replace(/,/g, ''), 10) || 0;
        };

        // --- 1. Extract Core Meta ---
        let subscriberText = null;
        let videoCountText = null;

        const header = ytData.header?.pageHeaderRenderer?.content?.pageHeaderViewModel;
        const statsRows = header?.metadata?.contentMetadataViewModel?.metadataRows || [];
        
        if (statsRows.length > 1) {
            const parts = statsRows[1]?.metadataParts || [];
            subscriberText = parts.find(p => p.text?.content?.toLowerCase().includes('subscriber'))?.text?.content || null;
            videoCountText = parts.find(p => p.text?.content?.toLowerCase().includes('video'))?.text?.content || null;
        }

        // --- 2. Extract Hidden 'About' Data (Views, Joined Date, Country, Links) ---
        const rawJsonString = JSON.stringify(ytData);
        
        // Views
        const viewCountMatch = rawJsonString.match(/"content":"([0-9,]+ views?)"/);
        const viewCountText = viewCountMatch ? viewCountMatch[1] : null;

        // Joined Date - YouTube sometimes stores this as {"content": "Joined Aug 23, 2017"} 
        // OR deep in a text array like {"text": "Joined Aug 23, 2017"}
        const joinedMatch = rawJsonString.match(/"(?:content|text)":"(Joined [A-Za-z]{3} [0-9]{1,2}, [0-9]{4})"/);
        const joinedDateText = joinedMatch ? joinedMatch[1] : null;
        
        // Country
        const countryMatch = rawJsonString.match(/"country":"([^"]+)"/);
        const country = countryMatch ? countryMatch[1] : null;

        // External Links (Strict Filtering)
        const links = [];
        const linkMatches = rawJsonString.matchAll(/"url":"(http[s]?:\/\/[^"]+)"/g);
        
        // Domains we NEVER want in the external links array
        const blacklistedDomains = [
            'youtube.com', 
            'google.com', 
            'gstatic.com', 
            'ytimg.com', 
            'ggpht.com', 
            'googleusercontent.com', 
            'googlevideo.com'
        ];

        for (const linkMatch of linkMatches) {
            const decoded = decodeURIComponent(linkMatch[1]).replace(/\\u0026/g, '&');
            
            try {
                const urlObj = new URL(decoded);
                const isBlacklisted = blacklistedDomains.some(domain => urlObj.hostname.includes(domain));
                
                if (!isBlacklisted && !links.includes(decoded)) {
                    links.push(decoded);
                }
            } catch (e) {
                // If it's a malformed URL, just skip it
                continue;
            }
        }

        // Categorize Links
        const twitter = links.find(l => l.includes('twitter.com') || l.includes('x.com')) || null;
        const instagram = links.find(l => l.includes('instagram.com')) || null;
        const store = links.find(l => l.includes('store.') || l.includes('shop.')) || null;

        // --- 3. Format Keywords / Tags Safely ---
        let formattedTags = "";
        if (typeof metadata.keywords === 'string') {
            formattedTags = metadata.keywords;
        } else if (Array.isArray(metadata.keywords)) {
            formattedTags = metadata.keywords.join(', ');
        }

        // --- 4. Build Output ---
        return {
            channelId: metadata.externalId || null,
            channel: metadata.vanityChannelUrl || targetUrl,
            name: metadata.title || null,
            avatar: {
                image: {
                    sources: metadata.avatar?.thumbnails || []
                },
                avatarImageSize: "AVATAR_SIZE_XL",
                loggingDirectives: {
                    trackingParams: "DEFAULT_TRACKING",
                    visibility: { types: "12" }
                },
                processor: { borderImageProcessor: { circular: true } }
            },
            description: metadata.description || "",
            subscriberCount: parseSubCount(subscriberText),
            subscriberCountText: subscriberText,
            videoCountText: videoCountText,
            viewCountText: viewCountText,
            joinedDateText: joinedDateText,
            tags: formattedTags,
            email: null,
            store: store,
            twitter: twitter,
            instagram: instagram,
            links: links,
            country: country
        };

    } catch (error) {
        console.error("[YouTube Schema Scraper Error]:", error.message);
        throw error;
    }
}





module.exports = { scrapeYouTubeChannelInfo };


