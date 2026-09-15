const AmazonFallback = require('./amazon-fallback');
const { notifyFailure } = require('../utils/notifier');

class AmazonOrchestrator {
    constructor() {
        this.primaryTimeout = 70000;
        this.fallback = this.initFallback();
    }

    initFallback() {
        try {
            const fallback = new AmazonFallback();
            console.log('Amazon fallback ready: SocialCrawl');
            return fallback;
        } catch (error) {
            console.warn(`Amazon fallback unavailable: ${error.message}`);
            return null;
        }
    }

    async executeSearch(primaryMethod, params) {
        return this.execute(
            primaryMethod,
            () => this.fallback.search(params.keyword, params.country, params.page),
            '/v1/amazon/search',
            params,
            data => ({
                keyword: params.keyword,
                marketplace: params.marketplace,
                page: params.page,
                total_products_extracted: data.length,
                products: data
            }),
            2
        );
    }

    async executeProduct(primaryMethod, params) {
        return this.execute(
            primaryMethod,
            () => this.fallback.product(params.asin, params.country),
            '/v1/amazon/product',
            params,
            data => data,
            1
        );
    }

    async executeStorefront(primaryMethod, params) {
        return this.execute(
            primaryMethod,
            () => this.fallback.storefront(params.url),
            '/v1/amazon/storefront',
            params,
            data => {
                const source = data.data && !Array.isArray(data.data) ? data.data : data;
                const products = Array.isArray(source)
                    ? source
                    : source.products || source.items || source.results || [];

                return {
                    storefront_url: params.url,
                    total_products_extracted: products.length,
                    products
                };
            },
            1
        );
    }

    async execute(primaryMethod, fallbackMethod, endpoint, params, normalize, userCreditCost) {
        const errors = [];

        try {
            const data = await this.withTimeout(primaryMethod(), this.primaryTimeout);
            return { success: true, data, provider: 'Your Playwright', creditCost: userCreditCost };
        } catch (error) {
            errors.push(`[PRIMARY] Amazon failed: ${error.message}`);
        }

        if (this.fallback) {
            try {
                const data = await fallbackMethod();
                return { success: true, data: normalize(data), provider: 'SocialCrawl', creditCost: userCreditCost };
            } catch (error) {
                errors.push(`[FALLBACK] SocialCrawl Amazon failed: ${error.message}`);
            }
        }

        const error = errors.join(' | ');
        await notifyFailure({ endpoint, params, statusCode: 503, errorMsg: error });
        return {
            success: false,
            error: 'All Amazon providers failed',
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

module.exports = new AmazonOrchestrator();
