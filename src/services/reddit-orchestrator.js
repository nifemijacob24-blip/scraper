/**
 * Reddit Fallback Orchestrator
 * 
 * Handles fallback logic for Reddit scrapers:
 * 1. Try YOUR Playwright scraper (PRIMARY - 1 credit)
 * 2. If timeout/error → Try ScrapCreators (Fallback 1 - 1 credit)
 * 3. If timeout/error → Try SocialCrawl (Fallback 2 - 1 credit)
 * 4. If timeout/error → Try SociaVault (Fallback 3 - 1 credit)
 * 5. All failed → Return error
 */

const RedditFallbackWrapper = require('./reddit-fallback');
const { notifyFailure } = require('../utils/notifier');

class RedditOrchestrator {
    constructor() {
        this.primaryTimeout = 30000; // 30s for your Playwright
        this.fallbackTimeout = 25000; // 25s for external APIs
        this.fallbackProviders = this.initFallbacks();
    }

    /**
     * Initialize fallback providers (do this once at startup)
     */
    initFallbacks() {
        const providers = [];

        ['scrapecreators', 'socialcrawl', 'sociavault'].forEach(provider => {
            try {
                new RedditFallbackWrapper(provider); // Test if API key exists
                providers.push({
                    name: provider.charAt(0).toUpperCase() + provider.slice(1),
                    provider: new RedditFallbackWrapper(provider)
                });
                console.log(`✅ Reddit fallback ready: ${provider}`);
            } catch (err) {
                console.warn(`⚠️  Reddit fallback unavailable: ${provider} - ${err.message}`);
            }
        });

        return providers;
    }

    /**
     * Execute any Reddit scraping method with fallback
     * 
     * @param {Function} primaryMethod - Your Playwright scraper function
     * @param {string} methodName - Which method is being called (for logging)
     * @returns {Promise<{success, data, provider, creditCost}>}
     */
    async execute(primaryMethod, methodName) {
        const errors = [];

        // --- PHASE 1: Try YOUR Playwright Scraper (PRIMARY) ---
        try {
            console.log(`[REDDIT] Attempting ${methodName} with YOUR Playwright scraper...`);
            
            const result = await this.withTimeout(primaryMethod(), this.primaryTimeout);

            console.log(`✅ [REDDIT] ${methodName} succeeded - Using your scraper`);
            return {
                success: true,
                data: result,
                     provider: 'Your Playwright',
                     creditCost: 1  // Every successful scrape costs 1 credit
            };
        } catch (error) {
            const errorMsg = `[PRIMARY] ${methodName} failed: ${error.message}`;
            console.error(errorMsg);
            errors.push(errorMsg);
        }

        // --- PHASE 2: Try Fallback Providers (EXTERNAL APIS) ---
        for (let i = 0; i < this.fallbackProviders.length; i++) {
            const { name, provider } = this.fallbackProviders[i];

            try {
                console.log(`[FALLBACK ${i + 1}/${this.fallbackProviders.length}] Trying ${name} for ${methodName}...`);
                
                const result = await this.withTimeout(
                    this.callFallbackMethod(provider, methodName),
                    this.fallbackTimeout
                );

                console.log(`✅ [FALLBACK ${i + 1}] ${name} succeeded for ${methodName}`);
                
                return {
                    success: true,
                    data: result,
                    provider: name,
                    creditCost: 1  // External APIs cost 1 credit each
                };
            } catch (error) {
                const errorMsg = `[FALLBACK ${i + 1}] ${name} failed: ${error.message}`;
                console.error(errorMsg);
                errors.push(errorMsg);

                if (i < this.fallbackProviders.length - 1) {
                    console.log(`⚠️  ${name} failed, trying next provider...`);
                }
            }
        }

        // --- PHASE 3: All Failed ---
        console.error(`❌ All Reddit scrapers failed for ${methodName}`);
        
        await notifyFailure({
            endpoint: `Reddit: ${methodName}`,
            statusCode: 503,
            errorMsg: `All providers failed: ${errors.join(' | ')}`
        });

        return {
            success: false,
            error: `All Reddit scrapers failed for ${methodName}`,
            details: errors,
            provider: null,
            creditCost: 0
        };
    }

    /**
     * Call the specific fallback method based on what we're scraping
     */
    callFallbackMethod(provider, methodName) {
        // methodName corresponds to your route, e.g., "subreddit/details"
        // Map it to the provider's method
        
        switch (methodName) {
            case 'subreddit/details':
                return provider.scrapeRedditDetails(...arguments);
            case 'subreddit/posts':
                return provider.scrapeRedditPosts(...arguments);
            case 'subreddit/search':
                return provider.scrapeRedditSearch(...arguments);
            case 'post/comments':
                return provider.scrapePostComments(...arguments);
            case 'global/search':
                return provider.scrapeGlobalSearch(...arguments);
            default:
                throw new Error(`Unknown method: ${methodName}`);
        }
    }

    /**
     * Helper: Promise with timeout
     */
    withTimeout(promise, ms) {
        return Promise.race([
            promise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
            )
        ]);
    }
}

// Export singleton instance
module.exports = new RedditOrchestrator();
