Here is a clean, production-ready Markdown template for your frontend documentation. You can drop this directly into Mintlify, Readme, or whatever docs generator you are using for your DaaS.

# Reddit Subreddit Details API

Get comprehensive metadata, active user metrics, rules, and visual assets for any subreddit.

**Cost:** 1 credit per request

**Method:** `GET`

**Endpoint:** `/v1/reddit/subreddit/details`

---

### Headers

| Name | Type | Requirement | Description |
| --- | --- | --- | --- |
| `x-api-key` | `string` | **Required** | Your API key for authentication. |

### Query Parameters

| Name | Type | Requirement | Description |
| --- | --- | --- | --- |
| `subreddit` | `string` | **Required** | The target subreddit name (without the `r/` prefix). *Example: `saas*` |
| `cache_max_age` | `string` | Optional | Returns cached response if newer than this value (costs 0 credits). *Available options: `1d`, `3d`, `7d`, `14d`, `30d*` |

---

### Code Examples

**cURL**

```bash
curl -X GET "https://api.yourdomain.com/v1/reddit/subreddit/details?subreddit=saas" \
  -H "x-api-key: your_api_key_here"

```

**Node.js (Fetch)**

```javascript
const response = await fetch("https://api.yourdomain.com/v1/reddit/subreddit/details?subreddit=saas", {
  method: "GET",
  headers: {
    "x-api-key": "your_api_key_here"
  }
});

const data = await response.json();
console.log(data);

```

---

### Response Object

**200 OK**

```json
{
  "success": true,
  "credits_remaining": 33950255,
  "credits_charged": 1,
  "subreddit_id": "r/saas",
  "display_name": "saas",
  "weekly_active_users": 272250,
  "weekly_contributions": 13008,
  "rules": "Be respectful | No spam or self-promotion | Keep it relevant to SaaS",
  "description": "Discussions and useful links for SaaS owners, online business owners, and more.",
  "header_img": null,
  "icon_img": "https://styles.redditmedia.com/t5_2qkq6/styles/communityIcon_u7ddkuay2xn21.jpg?width=128&frame=1&auto=webp&s=c3e7ff18a2b8ba64e697be1cd7b934d75aa01ec0",
  "subscribers": 272250,
  "advertiser_category": "",
  "created_at": "2026-07-31T14:43:09.075Z",
  "submit_text": ""
}

```

### Error Codes

| Status Code | Description |
| --- | --- |
| **400** | Bad Request (Missing required parameters) |
| **401** | Unauthorized (Invalid or missing API key) |
| **402** | Payment Required (Insufficient credits) |
| **404** | Not Found (Subreddit does not exist or is banned) |
| **500** | Internal Server Error (Scraper failed after maximum retries) |