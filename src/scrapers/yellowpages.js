const { ApifyClient } = require('apify-client');

const YELLOWPAGES_ACTOR = 'dainty_screw/advanced-yellowpages-scraper';

async function scrapeYellowpagesAPI(term, location, pageNum = 1) {
    if (!process.env.APIFY_API_TOKEN) throw new Error("APIFY_API_TOKEN missing from environment");

    const cleanTerm = term.trim();
    const cleanLocation = location.trim();
    const safePage = Number.isInteger(pageNum) && pageNum > 0 ? pageNum : 1;
    const targetUrl = new URL('https://www.yellowpages.com/search');
    targetUrl.searchParams.set('search_terms', cleanTerm);
    targetUrl.searchParams.set('geo_location_terms', cleanLocation);
    targetUrl.searchParams.set('page', safePage.toString());

    const client = new ApifyClient({ token: process.env.APIFY_API_TOKEN });
    const run = await client.actor(YELLOWPAGES_ACTOR).call({
        site: 'us',
        startUrls: [{ url: targetUrl.toString() }],
        maxItems: 1,
        proxyConfiguration: { useApifyProxy: false }
    });
    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    return (items || []).map(item => ({
        name: item.name || '',
        phone: item.phone || '',
        address: item.address || '',
        website: item.website || null,
        yellowpages_url: item.url || '',
        rating_indicator: item.rating ?? null,
        review_count: item.reviewCount || 0,
        rating: item.rating ?? null,
        review_snippet: item.reviewSnippet || '',
        categories: Array.isArray(item.categories) ? item.categories : []
    }));
}

module.exports = { scrapeYellowpagesAPI };