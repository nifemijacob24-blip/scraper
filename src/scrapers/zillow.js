const axios = require('axios');
const cheerio = require('cheerio');

async function scrapeZillowSearchAPI(location, pageNum = 1) {
    if (!process.env.SCRAPER_API_KEY) throw new Error("SCRAPER_API_KEY missing from environment");

    const cleanLocation = encodeURIComponent(location.trim().replace(/\s+/g, '-'));
    const pagePath = pageNum > 1 ? `${pageNum}_p/` : '';
    const targetUrl = `https://www.zillow.com/homes/${cleanLocation}_rb/${pagePath}`;

    const response = await axios.get('https://api.scraperapi.com/', {
        params: {
            api_key: process.env.SCRAPER_API_KEY,
            url: targetUrl,
            premium: 'true',      // Crucial: Forces Residential IPs to bypass PerimeterX
            country_code: 'us'    // Forces US proxies for Zillow localization
        },
        timeout: 60000 // Allow up to 60s for the API to retry and rotate IPs internally
    });

    const $ = cheerio.load(response.data);
    
    // Safety check: Did PerimeterX somehow block the Scraping API's residential IP?
    if ($('title').text().includes('Robot') || response.data.includes('Pardon Our Interruption')) {
        throw new Error("PerimeterX blocked the Scraping API. The provider will rotate IPs on the next request.");
    }

    let finalPayload = null;
    
    // Check standard Next.js state
    const nextData = $('#__NEXT_DATA__').html();
    if (nextData) {
        try { finalPayload = JSON.parse(nextData); } catch (e) {}
    }
    
    // Check Apollo GraphQL state (Zillow's newer architecture)
    if (!finalPayload) {
        const apolloData = $('#hdpApolloPreloadedData').html();
        if (apolloData) {
            try { finalPayload = JSON.parse(apolloData); } catch (e) {}
        }
    }

    if (!finalPayload) {
        throw new Error("Data payload missing from the HTML. Zillow may have altered their layout.");
    }

    return extractZillowListings(finalPayload);
}

async function scrapeZillowDetailAPI(zpid, url) {
    if (!process.env.SCRAPER_API_KEY) throw new Error("SCRAPER_API_KEY missing from environment");

    let targetUrl = url;
    if (!targetUrl && zpid) {
        targetUrl = `https://www.zillow.com/homedetails/${zpid.trim()}_zpid/`;
    }

    const response = await axios.get('https://api.scraperapi.com/', {
        params: {
            api_key: process.env.SCRAPER_API_KEY,
            url: targetUrl,
            premium: 'true',
            country_code: 'us'
        },
        timeout: 60000 
    });

    const $ = cheerio.load(response.data);
    
    if ($('title').text().includes('Robot') || response.data.includes('Pardon Our Interruption')) {
        throw new Error("PerimeterX blocked the Scraping API. The provider will rotate IPs on the next request.");
    }

    let finalPayload = null;
    const nextData = $('#__NEXT_DATA__').html();
    if (nextData) {
        try { finalPayload = JSON.parse(nextData); } catch (e) {}
    }
    
    if (!finalPayload) {
        const apolloData = $('#hdpApolloPreloadedData').html();
        if (apolloData) {
            try { finalPayload = JSON.parse(apolloData); } catch (e) {}
        }
    }

    if (!finalPayload) {
        throw new Error("Data payload missing from the HTML. Zillow may have altered their layout.");
    }

    return extractZillowPropertyDetails(finalPayload);
}

// Data Extraction Logic
function extractZillowListings(payload) {
    let listings = [];
    try {
        let results = [];
        if (payload?.props?.pageProps?.searchPageState?.cat1?.searchResults?.listResults) {
            results = payload.props.pageProps.searchPageState.cat1.searchResults.listResults;
        } else if (payload?.searchPageState?.cat1?.searchResults?.listResults) {
            results = payload.searchPageState.cat1.searchResults.listResults; 
        }

        listings = results.map(item => ({
            zpid: item.zpid || "",
            status: item.statusType || item.statusText || "",
            price: item.price || item.unformattedPrice || "",
            address: item.address || "",
            address_zip: item.addressZipcode || "",
            beds: item.beds || 0,
            baths: item.baths || 0,
            area_sqft: item.area || 0,
            property_type: item.propertyTypeDimension || item.sgapt || "",
            latitude: item.latLong?.latitude || null,
            longitude: item.latLong?.longitude || null,
            broker_name: item.brokerName || "",
            image_url: item.imgSrc || "",
            detail_url: item.detailUrl ? (item.detailUrl.startsWith('http') ? item.detailUrl : `https://www.zillow.com${item.detailUrl}`) : ""
        }));
    } catch (e) { }
    return listings;
}

function extractZillowPropertyDetails(payload) {
    try {
        if (!payload) return null;

        const clientCacheStr = payload?.props?.pageProps?.componentProps?.gdpClientCache;
        if (clientCacheStr) {
            const cacheObj = JSON.parse(clientCacheStr);
            for (let key in cacheObj) {
                if (cacheObj[key]?.property) return cacheObj[key].property;
            }
        }

        if (payload?.props?.pageProps?.property) return payload.props.pageProps.property;
        if (payload?.props?.pageProps?.initialData?.property) return payload.props.pageProps.initialData.property;

        for (let key in payload) {
            if (payload[key]?.property) return payload[key].property;
        }
    } catch (e) {}

    return null;
}

module.exports = { scrapeZillowSearchAPI, scrapeZillowDetailAPI };