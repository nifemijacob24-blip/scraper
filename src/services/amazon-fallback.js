const axios = require('axios');

class AmazonFallback {
    constructor() {
        this.baseUrl = 'https://www.socialcrawl.dev';
        this.apiKey = process.env.SOCIALCRAWL_API_KEY;

        if (!this.apiKey) {
            throw new Error('SOCIALCRAWL_API_KEY not found in environment');
        }
    }

    async search(keyword, country, page) {
        const payload = await this.request('/v1/amazon/product-search', {
            query: keyword,
            country,
            page
        });
        return this.extractList(payload);
    }

    async product(asin, country) {
        const payload = await this.request('/v1/amazon/product', { asin, country });
        return payload.data || payload;
    }

    async storefront(url) {
        const payload = await this.request('/v1/amazon/shop', { url });
        return payload.data || payload;
    }

    async request(path, params) {
        try {
            const response = await axios.get(`${this.baseUrl}${path}`, {
                params,
                headers: { 'x-api-key': this.apiKey },
                timeout: 60000
            });

            if (!response.data?.success) {
                throw new Error(response.data?.error?.message || response.data?.error || 'SocialCrawl Amazon request failed');
            }

            return response.data;
        } catch (error) {
            throw new Error(`SocialCrawl Amazon: ${error.message}`);
        }
    }

    extractList(payload) {
        const source = payload.data && !Array.isArray(payload.data) ? payload.data : payload;
        const list = Array.isArray(source)
            ? source
            : source.items || source.products || source.results || [];
        return Array.isArray(list) ? list : [];
    }
}

module.exports = AmazonFallback;
