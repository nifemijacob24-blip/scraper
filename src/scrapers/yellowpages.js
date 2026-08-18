const axios = require('axios');
const cheerio = require('cheerio');

async function scrapeYellowpagesAPI(term, location, pageNum = 1) {
    if (!process.env.SCRAPER_API_KEY) throw new Error("SCRAPER_API_KEY missing from environment");

    const cleanTerm = term.trim();
    const cleanLocation = location.trim();
    const targetUrl = `https://www.yellowpages.com/search?search_terms=${encodeURIComponent(cleanTerm)}&geo_location_terms=${encodeURIComponent(cleanLocation)}&page=${pageNum}`;

    const response = await axios.get('https://api.scraperapi.com/', {
        params: {
            api_key: process.env.SCRAPER_API_KEY,
            url: targetUrl,
            premium: 'true',
            country_code: 'us',
            render: 'true'
        },
        timeout: 60000
    });

    const $ = cheerio.load(response.data);

    // Block detection check
    const pageText = $('body').text().toLowerCase();
    if (pageText.includes('sorry, you have been blocked') || pageText.includes('pardon our interruption') || $('title').text().includes('Robot Check')) {
        throw new Error("Yellowpages served a block/CAPTCHA page. The provider will rotate IPs on the next request.");
    }

    const businesses = [];
    const seenNames = new Set();

    $('.result, .srp-listing').each((i, el) => {
        const $el = $(el);

        const nameNode = $el.find('.business-name, .business-name span').first();
        const name = nameNode.text().trim();
        if (!name || seenNames.has(name)) return;

        let ypUrl = $el.find('.business-name').attr('href') || nameNode.attr('href') || "";
        if (ypUrl && !ypUrl.startsWith('http')) {
            ypUrl = `https://www.yellowpages.com${ypUrl}`;
        }

        const phone = $el.find('.phones').first().text().trim();

        const street = $el.find('.street-address').first().text().trim();
        const locality = $el.find('.locality').first().text().trim();
        const address = `${street} ${locality}`.trim();

        const website = $el.find('.track-visit-website, .links a[href^="http"]').first().attr('href') || null;

        const ratingNode = $el.find('.ratings .rating div').first();
        const ratingClass = ratingNode.attr('class') || "";
        const reviewCountText = $el.find('.ratings .count').first().text().replace(/\D/g, '') || "0";

        seenNames.add(name);
        businesses.push({
            name,
            phone,
            address,
            website,
            yellowpages_url: ypUrl,
            rating_indicator: ratingClass,
            review_count: parseInt(reviewCountText, 10) || 0
        });
    });

    return businesses;
}

module.exports = { scrapeYellowpagesAPI };