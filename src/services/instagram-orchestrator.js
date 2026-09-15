const InstagramFallback = require('./instagram-fallback');
const { notifyFailure } = require('../utils/notifier');

class InstagramOrchestrator {
    constructor() {
        this.primaryTimeout = 60000;
        this.fallback = this.initFallback();
    }

    initFallback() {
        try {
            const fallback = new InstagramFallback();
            console.log('Instagram profile fallback ready: ScrapCreators');
            return fallback;
        } catch (error) {
            console.warn(`Instagram profile fallback unavailable: ${error.message}`);
            return null;
        }
    }

    async execute(primaryMethod, username) {
        const errors = [];

        try {
            console.log('[INSTAGRAM] Attempting profile with YOUR Playwright scraper...');
            const data = await this.withTimeout(primaryMethod(), this.primaryTimeout);

            return {
                success: true,
                data,
                provider: 'Your Playwright',
                creditCost: 1
            };
        } catch (error) {
            const errorMessage = `[PRIMARY] Instagram profile failed: ${error.message}`;
            console.error(errorMessage);
            errors.push(errorMessage);
        }

        if (this.fallback) {
            try {
                console.log('[INSTAGRAM] Trying ScrapCreators profile fallback...');
                const data = await this.fallback.scrapeProfile(username);

                return {
                    success: true,
                    data: {
                        status: 'success',
                        data
                    },
                    provider: 'ScrapCreators',
                    creditCost: 1
                };
            } catch (error) {
                const errorMessage = `[FALLBACK] ScrapCreators Instagram profile failed: ${error.message}`;
                console.error(errorMessage);
                errors.push(errorMessage);
            }
        }

        await notifyFailure({
            endpoint: '/v1/instagram/profile',
            params: { username },
            statusCode: 503,
            errorMsg: errors.join(' | ')
        });

        return {
            success: false,
            error: 'All Instagram profile providers failed',
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

module.exports = new InstagramOrchestrator();
