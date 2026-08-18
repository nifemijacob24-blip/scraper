// src/config/proxy.js
require('dotenv').config();

const proxyUrl = process.env.PROXY_URL;
if (!proxyUrl) {
    throw new Error("PROXY_URL is missing from your .env file!");
}

const proxyClient = {
    get: async (url, options = {}) => {
        try {
            const { gotScraping } = await import('got-scraping');

            const response = await gotScraping({
                url,
                method: 'GET',
                proxyUrl: proxyUrl,
                // THE FIX: Downgrade to HTTP/1.1 to bypass Fastly's H2 fingerprinting
                http2: false, 
                responseType: 'text',
                timeout: { request: 15000 },
                ...options
            });

            return {
                data: response.body,
                status: response.statusCode,
                headers: response.headers
            };
        } catch (error) {
            const formattedError = new Error(error.message);
            formattedError.response = {
                status: error.response ? error.response.statusCode : (error.statusCode || 500),
                data: error.response ? error.response.body : null
            };
            throw formattedError;
        }
    }
};

module.exports = proxyClient;