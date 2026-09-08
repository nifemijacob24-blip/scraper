/**
 * Reddit Fallback Wrapper
 * 
 * Wraps 3 external APIs (ScrapCreators, SocialCrawl, SociaVault)
 * for all Reddit scraping operations
 * 
 * Each method corresponds to one of your 5 Reddit endpoints
 */

const axios = require('axios');

class RedditFallbackWrapper {
    constructor(provider) {
        this.provider = provider; // 'scrapecreators', 'socialcrawl', or 'sociavault'
        this.setupProvider();
    }

    setupProvider() {
        switch (this.provider) {
            case 'scrapecreators':
                this.baseUrl = 'https://api.scrapecreators.com';
                this.apiKey = process.env.SCRAPECREATORS_API_KEY;
                this.headerName = 'x-api-key';
                break;
            case 'socialcrawl':
                this.baseUrl = 'https://www.socialcrawl.dev';
                this.apiKey = process.env.SOCIALCRAWL_API_KEY;
                this.headerName = 'x-api-key';
                break;
            case 'sociavault':
                this.baseUrl = 'https://api.sociavault.com';
                this.apiKey = process.env.SOCIAVAULT_API_KEY;
                this.headerName = 'x-api-key';
                break;
            default:
                throw new Error(`Unknown provider: ${this.provider}`);
        }

        if (!this.apiKey) {
            throw new Error(`${this.provider.toUpperCase()}_API_KEY not found in environment`);
        }
    }

    /**
     * ENDPOINT 1: Scrape subreddit details
     * Your endpoint: /v1/reddit/subreddit/details (1 credit)
     */
    async scrapeRedditDetails(subredditName) {
        const endpoint = `${this.baseUrl}/v1/reddit/subreddit/details`;
        
        try {
            const response = await axios.get(endpoint, {
                params: { name: subredditName },
                headers: { [this.headerName]: this.apiKey },
                timeout: 20000
            });

            if (!response.data.success) {
                throw new Error(response.data.error || 'API failed');
            }

            return response.data;
        } catch (error) {
            throw new Error(`${this.provider} subreddit details: ${error.message}`);
        }
    }

    /**
     * ENDPOINT 2: Scrape subreddit posts
     * Your endpoint: /v1/reddit/subreddit/posts (2 credits)
     */
    async scrapeRedditPosts(subredditName, options = {}) {
        const endpoint = `${this.baseUrl}/v1/reddit/subreddit`;
        
        try {
            const response = await axios.get(endpoint, {
                params: {
                    name: subredditName,
                    sort: options.sort || 'hot',
                    limit: options.limit || 100,
                    timeframe: options.timeframe || 'all'
                },
                headers: { [this.headerName]: this.apiKey },
                timeout: 20000
            });

            if (!response.data.success) {
                throw new Error(response.data.error || 'API failed');
            }

            return response.data;
        } catch (error) {
            throw new Error(`${this.provider} subreddit posts: ${error.message}`);
        }
    }

    /**
     * ENDPOINT 3: Scrape subreddit search
     * Your endpoint: /v1/reddit/subreddit/search (1 credit)
     */
    async scrapeRedditSearch(subredditName, query, options = {}) {
        const endpoint = `${this.baseUrl}/v1/reddit/subreddit/search`;
        
        try {
            const response = await axios.get(endpoint, {
                params: {
                    subreddit: subredditName,
                    q: query,
                    sort: options.sort || 'relevance',
                    limit: options.limit || 100,
                    timeframe: options.timeframe || 'all'
                },
                headers: { [this.headerName]: this.apiKey },
                timeout: 20000
            });

            if (!response.data.success) {
                throw new Error(response.data.error || 'API failed');
            }

            return response.data;
        } catch (error) {
            throw new Error(`${this.provider} subreddit search: ${error.message}`);
        }
    }

    /**
     * ENDPOINT 4: Scrape post comments
     * Your endpoint: /v1/reddit/post/comments (1 credit)
     */
    async scrapePostComments(postUrl, limit = 100, cursor = null) {
        const endpoint = `${this.baseUrl}/v1/reddit/post/comments`;
        
        try {
            const response = await axios.get(endpoint, {
                params: {
                    url: postUrl,
                    limit: limit,
                    cursor: cursor
                },
                headers: { [this.headerName]: this.apiKey },
                timeout: 20000
            });

            if (!response.data.success) {
                throw new Error(response.data.error || 'API failed');
            }

            return response.data;
        } catch (error) {
            throw new Error(`${this.provider} post comments: ${error.message}`);
        }
    }

    /**
     * ENDPOINT 5: Global Reddit search
     * Your endpoint: /v1/reddit/search (1 credit)
     */
    async scrapeGlobalSearch(query, options = {}) {
        const endpoint = `${this.baseUrl}/v1/reddit/search`;
        
        try {
            const response = await axios.get(endpoint, {
                params: {
                    q: query,
                    sort: options.sort || 'relevance',
                    limit: options.limit || 100,
                    timeframe: options.timeframe || 'all'
                },
                headers: { [this.headerName]: this.apiKey },
                timeout: 20000
            });

            if (!response.data.success) {
                throw new Error(response.data.error || 'API failed');
            }

            return response.data;
        } catch (error) {
            throw new Error(`${this.provider} global search: ${error.message}`);
        }
    }
}

module.exports = RedditFallbackWrapper;
