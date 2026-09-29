const axios = require('axios');
const cheerio = require('cheerio');
const { HttpsProxyAgent } = require('https-proxy-agent');

async function scrapeTrustpilotReviews(domain, pageNum = 1, sort = 'recency', stars = '') {
    if (!process.env.PROXY_URL) throw new Error("PROXY_URL missing from environment");

    const cleanDomain = encodeURIComponent(domain.trim());
    
    // 1. Construct the correct Trustpilot review URL
    const urlObj = new URL(`https://www.trustpilot.com/review/${cleanDomain}`);
    urlObj.searchParams.append('page', pageNum);
    if (sort) urlObj.searchParams.append('sort', sort);
    if (stars) urlObj.searchParams.append('stars', stars);
    
    const targetUrl = urlObj.toString();

    // 2. Configure IPRoyal Web Unblocker
    // We pass rejectUnauthorized: false because IPRoyal uses MITM SSL certificates to bypass Cloudflare
    const httpsAgent = new HttpsProxyAgent(process.env.PROXY_URL, { rejectUnauthorized: false });

    // 3. Fetch the raw HTML using Axios (No Playwright needed!)
    const response = await axios.get(targetUrl, {
        httpsAgent,
        timeout: 35000 // 35 seconds to let IPRoyal solve the CAPTCHA in the background
    });

    // 4. Parse the HTML using Cheerio
    const $ = cheerio.load(response.data);
    const scriptContent = $('#__NEXT_DATA__').html();

    if (!scriptContent) {
        throw new Error("Cloudflare blocked the proxy, or the target JSON block was not found.");
    }

    // 5. Convert back to JSON and pass to your EXISTING parser
    const ssrData = JSON.parse(scriptContent);
    return extractTrustpilotReviews(ssrData, cleanDomain);
}


async function scrapeTrustpilotSearch(query) {
    if (!process.env.PROXY_URL) throw new Error("PROXY_URL missing from environment");

    const cleanQuery = encodeURIComponent(query.trim());
    const targetUrl = `https://www.trustpilot.com/search?query=${cleanQuery}`;

    const httpsAgent = new HttpsProxyAgent(process.env.PROXY_URL, { rejectUnauthorized: false });

    const response = await axios.get(targetUrl, {
        httpsAgent,
        timeout: 35000 
    });

    const $ = cheerio.load(response.data);
    const scriptContent = $('#__NEXT_DATA__').html();

    if (!scriptContent) {
        throw new Error("Cloudflare blocked the proxy, or the target JSON block was not found.");
    }

    const ssrData = JSON.parse(scriptContent);
    return extractTrustpilotBusinesses(ssrData);
}