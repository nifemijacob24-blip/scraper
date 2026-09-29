// @ts-nocheck
/* eslint-disable */

const axios = require('axios');
const cheerio = require('cheerio');
const { HttpsProxyAgent } = require('https-proxy-agent');

async function scrapeLinkedInProfile(profileUrl) {
    let htmlBody = "";
    let providerUsed = "";

    // ATTEMPT 1: IPRoyal (Cheaper Primary)
    try {
        if (!process.env.PROXY_URL) throw new Error("PROXY_URL missing");
        
        console.log(`[LinkedIn Scraper] Attempting IPRoyal for: ${profileUrl}`);
        
        const response = await axios.get(profileUrl, {
            httpsAgent: new HttpsProxyAgent(process.env.PROXY_URL),
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            }
        });

        htmlBody = response.data;
        const tempParser = cheerio.load(htmlBody);
        const pageTitle = tempParser('title').text().toLowerCase();

        if (pageTitle.includes('security verification')) {
            throw new Error("IPRoyal hit a CAPTCHA");
        }
        if (pageTitle.includes('authwall')) {
            throw new Error("IPRoyal hit an Authwall");
        }
        if (htmlBody.includes('/authwall?')) {
            throw new Error("IPRoyal hit an Authwall redirect");
        }

        providerUsed = "IPRoyal";

    } catch (primaryError) {
        console.log(`[LinkedIn Scraper] IPRoyal failed (${primaryError.message}). Falling back to Bright Data...`);

        // ATTEMPT 2: Bright Data REST API (Premium Fallback)
        const apiKey = process.env.BRIGHTDATA_API_KEY;
        if (!apiKey) {
            throw new Error("BRIGHTDATA_API_KEY missing for fallback.");
        }
        
        let zoneName = process.env.BRIGHTDATA_ZONE;
        if (!zoneName) {
            zoneName = 'web_unlocker1';
        }

        const bdResponse = await fetch('https://api.brightdata.com/request', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                zone: zoneName,
                url: profileUrl,
                format: 'raw'
            })
        });

        if (!bdResponse.ok) {
            const errorText = await bdResponse.text();
            throw new Error(`Bright Data API Error (${bdResponse.status}): ${errorText}`);
        }

        htmlBody = await bdResponse.text();
        const tempParser = cheerio.load(htmlBody);
        const pageTitle = tempParser('title').text().toLowerCase();

        if (pageTitle.includes('security verification')) {
            throw new Error("Bright Data failed to bypass LinkedIn CAPTCHA.");
        }
        if (pageTitle.includes('authwall')) {
            throw new Error("Bright Data failed to bypass LinkedIn Authwall.");
        }

        providerUsed = "BrightData";
    }

    console.log(`[LinkedIn Scraper] Successfully unlocked using ${providerUsed}`);

    // PARSE THE UNLOCKED HTML
    const parser = cheerio.load(htmlBody);
    
    const clean = (text) => {
        if (!text) return null;
        return text.replace(/\s+/g, ' ').trim();
    };

    let profileName = clean(parser('h1.top-card-layout__title').text());
    if (!profileName) {
        profileName = clean(parser('h1').first().text());
    }

    if (!profileName) {
        throw new Error("Failed to parse profile name. Structure was unexpected.");
    }

    let profileAbout = clean(parser('h2.top-card-layout__headline').text());
    if (!profileAbout) {
        profileAbout = clean(parser('.top-card-layout__headline').text());
    }

    let profileLocation = clean(parser('.profile-info-subheader .pr2').text());
    if (!profileLocation) {
        profileLocation = clean(parser('div.top-card__subline-item').first().text());
    }

    const profileData = {
        name: profileName,
        about: profileAbout,
        location: profileLocation,
        experience: [],
        education: []
    };

    // Extract Experience
    parser('.experience-item, li.experience-group__list-item').each((_, el) => {
        let title = clean(parser(el).find('.experience-item__title, h3.profile-section-card__title').text());
        let company = clean(parser(el).find('.experience-item__subtitle, h4.profile-section-card__subtitle').text());
        let dateRange = clean(parser(el).find('.date-range').text());
        
        if (title) {
            profileData.experience.push({ title: title, company: company, dateRange: dateRange });
        } else if (company) {
            profileData.experience.push({ title: title, company: company, dateRange: dateRange });
        }
    });

    // Extract Education
    parser('.education__list-item, li.education-group__list-item').each((_, el) => {
        let school = clean(parser(el).find('.profile-section-card__title').text());
        let degree = clean(parser(el).find('.profile-section-card__subtitle').text());
        
        if (school) {
            profileData.education.push({ school: school, degree: degree });
        }
    });

    return profileData;
}

module.exports = { scrapeLinkedInProfile };