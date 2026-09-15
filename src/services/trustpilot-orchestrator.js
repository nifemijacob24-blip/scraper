const TrustpilotFallback = require('./trustpilot-fallback');
const { notifyFailure } = require('../utils/notifier');

class TrustpilotOrchestrator {
    constructor() {
        this.primaryTimeout = 50000;
        this.fallback = this.initFallback();
    }

    initFallback() {
        try {
            const fallback = new TrustpilotFallback();
            console.log('Trustpilot fallback ready: SocialCrawl');
            return fallback;
        } catch (error) {
            console.warn(`Trustpilot fallback unavailable: ${error.message}`);
            return null;
        }
    }

    async executeReviews(primaryMethod, params) {
        const errors = [];

        try {
            const data = await this.withTimeout(primaryMethod(), this.primaryTimeout);
            return { success: true, data, provider: 'Your Playwright', creditCost: 1 };
        } catch (error) {
            errors.push(`[PRIMARY] Trustpilot reviews failed: ${error.message}`);
        }

        if (this.fallback && params.page === 1 && !params.stars) {
            try {
                const data = await this.fallback.reviews(params.domain, params.sort);
                return { success: true, data, provider: 'SocialCrawl', creditCost: 1 };
            } catch (error) {
                errors.push(`[FALLBACK] SocialCrawl Trustpilot reviews failed: ${error.message}`);
            }
        } else if (this.fallback) {
            errors.push('[FALLBACK] SocialCrawl does not support page or stars filters');
        }

        return this.failure('/v1/trustpilot/reviews', params, errors);
    }

    async executeSearch(primaryMethod, query) {
        const errors = [];

        try {
            const data = await this.withTimeout(primaryMethod(), this.primaryTimeout);
            return { success: true, data, provider: 'Your Playwright', creditCost: 1 };
        } catch (error) {
            errors.push(`[PRIMARY] Trustpilot search failed: ${error.message}`);
        }

        if (this.fallback) {
            try {
                const businesses = await this.fallback.search(query);
                return {
                    success: true,
                    data: {
                        query,
                        total_results: businesses.length,
                        businesses
                    },
                    provider: 'SocialCrawl',
                    creditCost: 1
                };
            } catch (error) {
                errors.push(`[FALLBACK] SocialCrawl Trustpilot search failed: ${error.message}`);
            }
        }

        return this.failure('/v1/trustpilot/search', { query }, errors);
    }

    async failure(endpoint, params, errors) {
        const error = errors.join(' | ');
        await notifyFailure({ endpoint, params, statusCode: 503, errorMsg: error });
        return {
            success: false,
            error: 'All Trustpilot providers failed',
            details: errors,
            creditCost: 0
        };
    }

    withTimeout(promise, timeoutMs) {
        return Promise.race([
            promise,
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
            })
        ]);
    }
}

module.exports = new TrustpilotOrchestrator();
