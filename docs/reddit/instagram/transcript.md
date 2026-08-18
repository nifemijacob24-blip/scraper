Markdown
## Get Post Transcript (AI)
Get the audio transcript of an Instagram post or reel. 

*Note: This endpoint utilizes an AI model (OpenAI Whisper) to process the audio. You should expect results in 10-30 seconds. Transcripts are limited to videos under 2 minutes in length. If no one is speaking, the transcript will return `null`. For carousel posts, it will return an array of transcripts for each item in the carousel.*

**Endpoint:** `GET /v1/instagram/transcript`

### Query Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `shortcode` | `string` | **Yes** | The Instagram post shortcode (e.g., `DH3tWudxIKB`). |

### Example Request
```bash
curl -X GET "http://localhost:3000/v1/instagram/transcript?shortcode=DH3tWudxIKB" \
     -H "Authorization: Bearer YOUR_API_KEY"
Response Schema (200 OK)
JSON
{
    "success": true,
    "credits_remaining": 995,
    "credits_charged": 5,
    "status": "success",
    "data": {
        "shortcode": "DH3tWudxIKB",
        "transcripts": [
            {
                "id": "3600545900919030401",
                "type": "video",
                "transcript": "Welcome back to the channel, today we are building a SaaS..."
            },
            {
                "id": "3600545900919030402",
                "type": "image",
                "transcript": null
            },
            {
                "id": "3600545900919030403",
                "type": "video",
                "transcript": null,
                "error": "Video duration (145s) exceeds the 120-second limit."
            }
        ]
    }
}
Error Responses
400 Bad Request

JSON
{
    "success": false,
    "error": "400 Bad Request: Missing required parameter 'shortcode'"
}
403 Forbidden

JSON
{
    "success": false,
    "error": "403 Forbidden: Insufficient credits. Transcripts require 5 credits."
}
500 Internal Server Error

JSON
{
    "success": false,
    "error": "500: Failed to transcribe video using AI."
}