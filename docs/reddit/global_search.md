Markdown
# Global Reddit Search API

Search across all of Reddit for specific keywords, returning raw post objects and pagination tokens.

**Endpoint:** `/v1/reddit/search`  
**Method:** `GET`  
**Cost:** 1 Credit per request  

## Authentication

All requests require your API key passed in the headers.

| Header | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `x-api-key` | `string` | **Yes** | Your ScraperCreators API key |

## Query Parameters

| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `q` (or `query`) | `string` | **Yes** | - | The keyword or phrase to search for across all subreddits. |
| `sort` | `string` | No | `relevance` | Sort order: `relevance`, `hot`, `top`, `new`, `comments`. |
| `timeframe` | `string` | No | `all` | Time filter: `all`, `year`, `month`, `week`, `day`, `hour`. |
| `after` | `string` | No | `null` | Pagination token returned from the previous request's `after` field. |

## Success Response (200 OK)

Returns an array of global Reddit posts with an injected `created_at_iso` timestamp, and an `after` token for fetching the next page.

```json
{
  "success": true,
  "credits_remaining": 999999,
  "credits_charged": 1,
  "posts": [
    {
      "subreddit": "webscraping",
      "selftext": "1. Don't try putting scraping tools in Lambda.",
      "title": "After 2 months learning scraping, I'm sharing what I learned!",
      "name": "t3_1flgwup",
      "upvote_ratio": 0.99,
      "ups": 361,
      "score": 361,
      "is_self": true,
      "created": 1726851591,
      "domain": "self.webscraping",
      "id": "1flgwup",
      "author": "Sea_Cardiologist_212",
      "num_comments": 102,
      "permalink": "/r/webscraping/comments/1flgwup/...",
      "url": "[https://www.reddit.com/r/webscraping/comments/1flgwup/](https://www.reddit.com/r/webscraping/comments/1flgwup/)...",
      "created_utc": 1726851591,
      "created_at_iso": "2024-09-20T16:59:51.000Z"
    }
  ],
  "after": "t3_1ihh437"
}
Error Responses
400 Bad Request
Triggered when the query parameter is missing.

JSON
{
  "success": false,
  "error": "400 Bad Request: Missing required parameter 'q'"
}
403 Forbidden
Triggered when the API key is missing, invalid, or lacks sufficient credits.

JSON
{
  "success": false,
  "error": "403 Forbidden: Insufficient credits. This request requires 1 credits."
}
500 Internal Server Error
Triggered if the upstream data source times out or blocks the request. The engineering team is automatically notified via Discord when this occurs.

JSON
{
  "success": false,
  "error": "500: Playwright Global Search Error: Timeout"
}