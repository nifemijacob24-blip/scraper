const axios = require('axios');

class InstagramFallback {
    constructor() {
        this.baseUrl = 'https://api.scrapecreators.com';
        this.apiKey = process.env.SCRAPE_CREATORS_API_KEY || process.env.SCRAPECREATORS_API_KEY;

        if (!this.apiKey) {
            throw new Error('SCRAPE_CREATORS_API_KEY not found in environment');
        }
    }

    async scrapeProfile(username) {
        try {
            const response = await axios.get(`${this.baseUrl}/v1/instagram/profile`, {
                params: { username },
                headers: { 'x-api-key': this.apiKey },
                timeout: 25000
            });

            if (!response.data?.success) {
                throw new Error(response.data?.error || 'ScrapCreators Instagram profile request failed');
            }

            return response.data.data || response.data;
        } catch (error) {
            throw new Error(`ScrapCreators Instagram profile: ${error.message}`);
        }
    }
}

module.exports = InstagramFallback;
