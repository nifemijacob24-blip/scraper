{/* Reason: Terminal documentation generation task based on the established code and schema. No follow-up required. */}
Here is the standard Markdown documentation for your `docs/` repository. You can save this as `docs/post-comments.md`.

```markdown
# Post Comments API

Extract a full Reddit post along with its recursively nested comment tree. The response includes pagination cursors (`more.cursor`) at every depth level to fetch deeply buried reply chains.

**Endpoint:** `/v1/reddit/post/comments`  
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
| `url` (or `permalink`) | `string` | **Yes** | - | The full URL of the Reddit post (e.g., `https://www.reddit.com/r/AskReddit/comments/ablzuq/...`). |

## Success Response (200 OK)

The response separates the core `post` data from the recursive `comments` array. Each comment contains a `replies` object, which holds nested comment `items` and a `more` pagination token if the thread continues.

```json
{
  "success": true,
  "credits_remaining": 999999,
  "credits_charged": 1,
  "post": {
    "id": "ablzuq",
    "name": "t3_ablzuq",
    "subreddit": "AskReddit",
    "title": "People who haven't pooped in 2019 yet, why are you still holding on to last years shit?",
    "score": 221995,
    "num_comments": 7925,
    "created_utc": 1546376787,
    "created_at_iso": "2019-01-01T21:06:27.000Z",
    "url": "[https://www.reddit.com/r/AskReddit/comments/ablzuq/](https://www.reddit.com/r/AskReddit/comments/ablzuq/)..."
  },
  "comments": [
    {
      "id": "ed1czme",
      "author": "sweatybeard",
      "body": "But when I finally do, it'll be the years biggest shit",
      "score": 12211,
      "created_utc": 1546378524,
      "created_at_iso": "2019-01-01T21:35:24.000Z",
      "permalink": "/r/AskReddit/comments/ablzuq/...",
      "replies": {
        "items": [
          {
            "id": "ed1su6t",
            "author": "jofwu",
            "body": "Somewhere out there, somebody has made the biggest poop of the year...",
            "score": 2415,
            "replies": {
              "items": [],
              "more": {
                "has_more": true,
                "cursor": "egos1bd,ef1lv5d,el1tr5b"
              }
            }
          }
        ],
        "more": {
          "has_more": true,
          "cursor": "ed1lvsa,ed3fnpq,ed25l2w"
        }
      }
    }
  ],
  "more": {
    "has_more": true,
    "cursor": "ed1jhoi,ed1f3kw,ed1qgjh,ed1e4vd,ed1benx"
  }
}

```

## Error Responses

**400 Bad Request**
Triggered when the URL is missing or is not a valid Reddit post link.

```json
{
  "success": false,
  "error": "400 Bad Request: Invalid Reddit post URL"
}

```

**403 Forbidden**
Triggered when the API key is missing, invalid, or lacks sufficient credits.

```json
{
  "success": false,
  "error": "403 Forbidden: Insufficient credits. This request requires 1 credits."
}

```

**500 Internal Server Error**
Triggered if the upstream data source times out or blocks the request. The engineering team is automatically notified via Discord when this occurs.

```json
{
  "success": false,
  "error": "500: Playwright Comments Scraper Error: Timeout"
}

```

```

```