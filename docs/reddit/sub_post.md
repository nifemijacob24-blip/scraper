Charging 2 credits for this makes perfect sense. Pulling an array of full post objects, supporting pagination with the `after` token, and handling timeframe/sort filtering is a much heavier lift for your proxies and server than just grabbing a single static header. Plus, the data value for your users is significantly higher here.

Here is the clean, Mintlify/Readme-ready Markdown template for your new endpoint. You can save this as `reddit-subreddit-posts.md`.

```markdown
# Reddit Subreddit Posts API

Retrieve a list of posts from a specific subreddit. Supports pagination, sorting, and timeframe filtering.

**Cost:** 2 credits per request  
**Method:** `GET`  
**Endpoint:** `/v1/reddit/subreddit/posts`

---

### Headers

| Name | Type | Requirement | Description |
| :--- | :--- | :--- | :--- |
| `x-api-key` | `string` | **Required** | Your API key for authentication. |

### Query Parameters

| Name | Type | Requirement | Description |
| :--- | :--- | :--- | :--- |
| `subreddit` | `string` | **Required** | The target subreddit name (without the `r/` prefix). <br/>*Example: `AskReddit`* |
| `sort` | `string` | Optional | Sort order of the posts. <br/>*Available options: `best`, `hot`, `new`, `top`, `rising`* |
| `timeframe` | `string` | Optional | Timeframe to get posts from (used with specific sorts like `top`). <br/>*Available options: `all`, `day`, `week`, `month`, `year`* |
| `after` | `string` | Optional | Pagination token to get the next page of results. Get this from the `after` field of your previous response. <br/>*Example: `t3_1234567890`* |
| `trim` | `boolean` | Optional | Set to `true` to return a stripped-down, lightweight version of the response without null/empty fields. <br/>*Default: `false`* |
| `cache_max_age` | `string` | Optional | Returns cached response if newer than this value (costs 0 credits). <br/>*Available options: `1d`, `3d`, `7d`, `14d`, `30d`* |

---

### Code Examples

**cURL**
```bash
curl -X GET "[https://api.yourdomain.com/v1/reddit/subreddit/posts?subreddit=AskReddit&sort=hot&timeframe=day](https://api.yourdomain.com/v1/reddit/subreddit/posts?subreddit=AskReddit&sort=hot&timeframe=day)" \
  -H "x-api-key: your_api_key_here"

```

**Node.js (Fetch)**

```javascript
const response = await fetch("[https://api.yourdomain.com/v1/reddit/subreddit/posts?subreddit=AskReddit&sort=hot](https://api.yourdomain.com/v1/reddit/subreddit/posts?subreddit=AskReddit&sort=hot)", {
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
  "credits_remaining": 1000000,
  "credits_charged": 2,
  "posts": [
    {
      "subreddit": "AskReddit",
      "author_fullname": "t2_aelahp9al",
      "title": "What are your thoughts on California’s bill that would ban most law enforcement officers from wearing face masks while on duty?",
      "name": "t3_1ldr6b9",
      "upvote_ratio": 0.93,
      "ups": 12606,
      "score": 12606,
      "is_self": true,
      "created": 1750176516,
      "id": "1ldr6b9",
      "author": "Ecstatic-Medium-6320",
      "num_comments": 1921,
      "permalink": "/r/AskReddit/comments/1ldr6b9/what_are_your_thoughts_on_californias_bill_that/",
      "url": "[https://www.reddit.com/r/AskReddit/comments/1ldr6b9/what_are_your_thoughts_on_californias_bill_that/](https://www.reddit.com/r/AskReddit/comments/1ldr6b9/what_are_your_thoughts_on_californias_bill_that/)",
      "subreddit_subscribers": 56098571,
      "created_utc": 1750176516
    }
  ],
  "after": "t3_1ld8q7h"
}

```

*(Note: Response truncated for brevity. Set `trim=true` to receive this exact lightweight structure, or `trim=false` for the full metadata payload).*

### Error Codes

| Status Code | Description |
| --- | --- |
| **400** | Bad Request (Missing required parameters) |
| **401** | Unauthorized (Invalid or missing API key) |
| **402** | Payment Required (Insufficient credits) |
| **404** | Not Found (Subreddit does not exist) |
| **500** | Internal Server Error |

```

<FollowUp label="Need help mapping the trim logic?" query="Do you need help writing the JavaScript mapping function to strip down the payload when trim=true, or do you already have that logic handled?"/>

```