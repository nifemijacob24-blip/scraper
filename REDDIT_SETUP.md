# 🔴 Reddit Fallback System - Setup Guide

## What We Built

✅ **Reddit Fallback Wrapper** - Calls 3 external APIs for Reddit scraping
✅ **Reddit Orchestrator** - Handles fallback logic (primary → fallbacks)
✅ **Route Example** - Copy-paste template for your 5 Reddit endpoints

## Files Created

```
src/services/
├── reddit-fallback.js         # Wraps 3 external APIs (ScrapCreators, SocialCrawl, SociaVault)
└── reddit-orchestrator.js     # Handles fallback orchestration

REDDIT_ROUTE_UPDATE_EXAMPLE.js # Copy-paste examples for your 5 routes
```

## Your 5 Reddit Endpoints

```
1. /v1/reddit/subreddit/details    → scrapeSubredditDetails(name)
2. /v1/reddit/subreddit/posts      → scrapeSubredditPosts(subreddit, sort, timeframe, cursor, limit)
3. /v1/reddit/subreddit/search     → scrapeRedditSearch(subreddit, query, sort, timeframe, cursor, limit)
4. /v1/reddit/post/comments        → scrapePostComments(postUrl, limit, cursor)
5. /v1/reddit/search               → scrapeGlobalSearch(query, sort, timeframe, cursor, limit)
```

## Step 1: Setup Environment Variables

Add to your `.env` file:

```env
# Fallback providers (required for fallback to work)
SCRAPECREATORS_API_KEY=your_key_from_https://app.scrapecreators.com
SOCIALCRAWL_API_KEY=your_key_from_https://www.socialcrawl.dev
SOCIAVAULT_API_KEY=your_key_from_https://docs.sociavault.com
```

## Step 2: Update Your Routes

In `server.js`, at the TOP, add:

```javascript
const redditOrchestrator = require('./src/services/reddit-orchestrator');
```

Then update each of your 5 Reddit routes. Copy the pattern from `REDDIT_ROUTE_UPDATE_EXAMPLE.js`:

### Change This:
```javascript
const data = await scrapeSubredditDetails(name);
req.user.credits -= 1;
```

### To This:
```javascript
const result = await redditOrchestrator.execute(
    () => scrapeSubredditDetails(name),
    'subreddit/details'
);

if (!result.success) {
    return res.status(503).json({ success: false, error: result.error });
}

if (result.creditCost > 0) {
    req.user.credits -= result.creditCost;
}
```

That's it! Just 3 changes per route.

## How It Works

### Successful Request Flow

```
User Request
    ↓
Auth Middleware ✅
    ↓
Route Handler
    ↓
redditOrchestrator.execute()
    ├─ Try YOUR Playwright scraper (30s timeout)
    │  └─ SUCCESS → Return data (0 cost)
    │
    └─ PRIMARY FAILED? → Try fallbacks:
       ├─ Try ScrapCreators (25s timeout)
       │  └─ SUCCESS → Return data (1 credit cost)
       │
       └─ SCRAPECREATORS FAILED? → Try SocialCrawl (25s timeout)
          └─ SUCCESS → Return data (1 credit cost)
          
          └─ SOCIALCRAWL FAILED? → Try SociaVault (25s timeout)
             └─ SUCCESS → Return data (1 credit cost)
             
             └─ ALL FAILED → Return 503 error
    ↓
Response includes:
  - success: true/false
  - provider: "Your Playwright" | "ScrapCreators" | "SocialCrawl" | "SociaVault"
  - credits_charged: 0 | 1 (depending on which provider succeeded)
  - data: {...}
```

## Cost Structure

| Scenario | Cost | When |
|----------|------|------|
| Your Playwright works | 0 credits | Your scraper succeeds |
| ScrapCreators used | 1 credit | Your scraper times out, fallback works |
| SocialCrawl used | 1 credit | First two fail, this one works |
| SociaVault used | 1 credit | Last resort succeeds |
| All fail | 0 credits | No provider succeeded (error response) |

**Key**: Credits only charged when external API is actually used AND succeeds.

## Example Response

### When Your Playwright Succeeds
```json
{
  "success": true,
  "provider": "Your Playwright",
  "credits_charged": 0,
  "credits_remaining": 100,
  "subreddit_id": "r/funny",
  "subscribers": 13500000,
  ...
}
```

### When Fallback Is Used (Your scraper timed out)
```json
{
  "success": true,
  "provider": "ScrapCreators",
  "credits_charged": 1,
  "credits_remaining": 99,
  "subreddit_id": "r/funny",
  "subscribers": 13500000,
  ...
}
```

### When All Fail
```json
{
  "success": false,
  "error": "All Reddit scrapers failed for subreddit/details",
  "details": [
    "[PRIMARY] subreddit/details failed: Timeout after 30000ms",
    "[FALLBACK 1] ScrapCreators failed: API error",
    "[FALLBACK 2] SocialCrawl failed: Connection refused",
    "[FALLBACK 3] SociaVault failed: Invalid API key"
  ]
}
```

## Testing Checklist

- [ ] Add API keys to `.env`
- [ ] Import orchestrator at top of `server.js`
- [ ] Update `/v1/reddit/subreddit/details` route (use example)
- [ ] Test: `curl -H "x-api-key: YOUR_KEY" http://localhost:3000/v1/reddit/subreddit/details?name=funny`
- [ ] Response includes `provider` field
- [ ] Check Supabase: credit was deducted only if fallback was used
- [ ] Update remaining 4 Reddit routes
- [ ] Full testing of all 5 endpoints
- [ ] Ready for Instagram!

## Troubleshooting

**"SCRAPECREATORS_API_KEY not found"**
- Check your `.env` file has the key
- Restart your server
- Keys are case-sensitive

**Fallback never used (always using your Playwright)**
- That's GOOD! Your scraper is working
- To test fallback, temporarily set your scraper timeout to 1ms or just comment it out

**Getting 503 errors**
- All providers failed
- Check if API keys are valid
- Check internet connectivity
- Check provider status pages

**Credits deducting unexpectedly**
- Verify your Playwright is actually succeeding (not hanging)
- Check logs for timeout messages
- Increase primary timeout in `reddit-orchestrator.js` if needed

## Next Steps

1. **Complete Reddit**: Update all 5 routes ✓
2. **Test thoroughly**: Verify auth, credits, fallback
3. **Move to Instagram**: Same pattern, new endpoint
4. **Repeat for all platforms**: One by one

## Support

- **ScrapCreators**: support@scrapecreators.com
- **SocialCrawl**: https://www.socialcrawl.dev/docs
- **SociaVault**: https://docs.sociavault.com/
