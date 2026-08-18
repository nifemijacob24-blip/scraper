Ah, got it! You just needed the documentation specifically for the Feed (profile posts) endpoint.

Here is the clean, isolated .md documentation for the Instagram Feed scraper, ready to drop into your docs:

Markdown
## Get User Feed (Profile Posts)
Retrieves the most recent public posts from a user's grid. The response includes clean engagement metrics (likes, comments, views) and direct high-resolution URLs for both images and videos. 

**Endpoint:** `GET /v1/instagram/feed`

### Query Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `username` | `string` | **Yes** | The Instagram handle to scrape (e.g., `barstoolsports`). |
| `max_id` | `string` | No | Pagination cursor returned from a previous request to fetch the next page of posts. |

### Example Request
```bash
curl -X GET "http://localhost:3000/v1/instagram/feed?username=barstoolsports" \
     -H "Authorization: Bearer YOUR_API_KEY"
Response Schema (200 OK)
JSON
{
    "success": true,
    "status": "success",
    "data": {
        "username": "barstoolsports",
        "post_count": 12,
        "has_more": true,
        "next_cursor": "3599731065704772932_260462810",
        "posts": [
            {
                "id": "3600545900919030401_260462810",
                "shortcode": "DH3tWudxIKB",
                "url": "[https://www.instagram.com/p/DH3tWudxIKB/](https://www.instagram.com/p/DH3tWudxIKB/)",
                "timestamp": 1743438570,
                "media_type": "video",
                "caption": "Dana is neglecting a pretty important level of the food pyramid @danabeers @francisccellis",
                "metrics": {
                    "likes": 387,
                    "comments": 12,
                    "views": 35499
                },
                "media_urls": {
                    "image_high_res": "[https://instagram.fcps3-1](https://instagram.fcps3-1)... (720x1280 thumbnail)",
                    "video": "[https://instagram.fcps3-1](https://instagram.fcps3-1)... (.mp4 file direct link)"
                }
            }
        ]
    }
}
Error Responses
400 Bad Request

JSON
{
    "success": false,
    "error": "400 Bad Request: Missing required parameter 'username'"
}
404 Not Found

JSON
{
    "success": false,
    "error": "404: That Instagram username does not exist."
}
500 Internal Server Error

JSON
{
    "success": false,
    "error": "500: Unable to fetch Instagram feed at this time."
}

get more by passing next_cursor query