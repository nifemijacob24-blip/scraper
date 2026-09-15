const axios = require('axios');

class TrustpilotFallback {
    constructor() {
        this.baseUrl = 'https://www.socialcrawl.dev';
        this.apiKey = process.env.SOCIALCRAWL_API_KEY;

        if (!this.apiKey) {
            throw new Error('SOCIALCRAWL_API_KEY not found in environment');
        }
    }

    async search(query) {
        const response = await this.request('/v1/trustpilot/business-search', { query });
        const payload = response.data || {};
        const businesses = payload.items || payload.businesses || payload.results || payload.data || [];

        return Array.isArray(businesses) ? businesses : [];
    }

    async reviews(domain, sort = 'recency') {
        const response = await this.request('/v1/trustpilot/reviews', {
            domain,
            depth: 200,
            sort: sort === 'relevance' ? 'relevance' : 'recency'
        });

        const payload = response.data || {};
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
                throw new Error(response.data?.error?.message || response.data?.error || 'SocialCrawl request failed');
            }

            return response.data;
        } catch (error) {
            throw new Error(`SocialCrawl Trustpilot: ${error.message}`);
        }
    }
}

module.exports = TrustpilotFallback;
