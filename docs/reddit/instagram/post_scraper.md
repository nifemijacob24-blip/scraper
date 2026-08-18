Markdown
## Get Single Post
Retrieves detailed metadata and high-resolution media URLs for a specific Instagram post, reel, or carousel using its shortcode.

**Endpoint:** `GET /v1/instagram/post`

### Query Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `shortcode` | `string` | **Yes** | The Instagram post shortcode (e.g., `DH3tWudxIKB`). |

### Example Request
```bash
curl -X GET "http://localhost:3000/v1/instagram/post?shortcode=DH3tWudxIKB" \
     -H "x-api-key: YOUR_API_KEY"
Response Schema (200 OK)
JSON
{
    "success": true,
    "credits_remaining": 998,
    "credits_charged": 1,
    "status": "success",
    "data": {
        "id": "3600545900919030401",
        "shortcode": "DH3tWudxIKB",
        "media_type": "video",
        "video_duration": 14.5,
        "media_urls": {
            "video": "[https://instagram.fcps3-1](https://instagram.fcps3-1)... (.mp4 file direct link)"
        },
        "carousel_media": []
    }
}
Error Responses
400 Bad Request

JSON
{
    "success": false,
    "error": "Missing required parameter 'shortcode'"
}
404 Not Found

JSON
{
    "success": false,
    "error": "Post not found or account is private."
}