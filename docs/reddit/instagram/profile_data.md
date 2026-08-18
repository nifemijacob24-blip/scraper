Markdown
# Instagram Profile API

Extract comprehensive metadata from a public Instagram profile, including biography, links, follower counts, business categories, and recent timeline media (posts/reels).

**Endpoint:** `/v1/instagram/profile`  
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
| `username` | `string` | **Yes** | - | The Instagram username (e.g., `adrianhorning`). Can optionally include the `@` symbol. |

## Success Response (200 OK)

The response payload mirrors Instagram's internal GraphQL structure. It includes detailed user metadata and a preview of the user's latest timeline posts under `edge_owner_to_timeline_media`.

```json
{
  "success": true,
  "credits_remaining": 999999,
  "credits_charged": 1,
  "data": {
    "user": {
      "biography": "Scraping the web",
      "bio_links": [
        {
          "title": "Social Media APIs",
          "url": "[https://scrapecreators.com](https://scrapecreators.com)",
          "link_type": "external"
        }
      ],
      "edge_followed_by": {
        "count": 25116
      },
      "edge_follow": {
        "count": 101
      },
      "full_name": "Adrian Horning",
      "is_business_account": true,
      "category_name": "Entrepreneur",
      "is_verified": true,
      "profile_pic_url": "[https://scontent-iad3-1.cdninstagram.com/](https://scontent-iad3-1.cdninstagram.com/)...",
      "username": "adrianhorning",
      "edge_owner_to_timeline_media": {
        "count": 71,
        "page_info": {
          "has_next_page": true,
          "end_cursor": "QVFDdUZKSGhpeXExc..."
        },
        "edges": [
          {
            "node": {
              "__typename": "GraphVideo",
              "id": "3540614075954356349",
              "shortcode": "DEiyb48AeB9",
              "is_video": true,
              "video_view_count": 1318,
              "edge_liked_by": {
                "count": 126
              }
            }
          }
        ]
      }
    }
  },
  "status": "ok"
}
Error Responses
400 Bad Request
Triggered when the username parameter is missing.

JSON
{
  "success": false,
  "error": "400 Bad Request: Missing required parameter 'username'"
}
404 Not Found
Triggered when the requested Instagram username does not exist.

JSON
{
  "success": false,
  "error": "404 Not Found: Instagram user does not exist"
}
403 Forbidden
Triggered when the API key is missing, invalid, or lacks sufficient credits.

JSON
{
  "success": false,
  "error": "403 Forbidden: Insufficient credits. This request requires 1 credits."
}
500 Internal Server Error
Triggered if the upstream data source times out, blocks the request, or requires a login challenge. The engineering team is automatically notified via Discord when this occurs.

JSON
{
  "success": false,
  "error": "500: Playwright Instagram Profile Error: Timeout"
}