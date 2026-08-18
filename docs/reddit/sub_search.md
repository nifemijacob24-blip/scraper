# Subreddit Search API

Search a specific subreddit for keywords, returning a categorized payload of posts, comments, and extracted media.

**Endpoint:** `/v1/reddit/subreddit/search`  
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
| `subreddit` (or `name`) | `string` | **Yes** | - | The name of the subreddit to search (e.g., `Fitness`). |
| `q` (or `query`) | `string` | **Yes** | - | The keyword or phrase to search for. |
| `sort` | `string` | No | `relevance` | Sort order: `relevance`, `hot`, `top`, `new`, `comments`. |
| `timeframe` | `string` | No | `all` | Time filter: `all`, `year`, `month`, `week`, `day`, `hour`. |
| `cursor` | `string` | No | `null` | Pagination token returned from the previous request's `cursor` field. |

## Success Response (200 OK)

The response payload automatically categorizes Reddit's search results into `posts`, `comments`, and extracted `media`. 

```json
{
  "success": true,
  "credits_remaining": 999999,
  "credits_charged": 1,
  "posts": [
    {
      "id": "t3_8gmjrb",
      "post_id": "t3_8gmjrb",
      "title": "Is doing 50-100 pushups a day doing anything?",
      "url": "[https://www.reddit.com/r/Fitness/comments/8gmjrb/](https://www.reddit.com/r/Fitness/comments/8gmjrb/)...",
      "permalink": "/r/Fitness/comments/8gmjrb/...",
      "nsfw": false,
      "spoiler": false,
      "is_crosspost": false,
      "subreddit": {
        "id": "t5_2qhx4",
        "name": "Fitness",
        "nsfw": false
      },
      "votes": 1414,
      "num_comments": 582,
      "created_at": "2018-05-03T01:09:17.620Z",
      "thumbnail": null,
      "position": 1
    }
  ],
  "comments": [
    {
      "id": "t1_nxf7p27",
      "post_id": "t3_1q2p898",
      "parent_comment_id": null,
      "is_reply_to_comment": false,
      "author": "Philser23",
      "body": "On the 30th my girlfriend out of the blue decided her new year's resolution...",
      "votes": 123,
      "permalink": "/r/Fitness/comments/1q2p898/gym_story_saturday/nxf7p27/",
      "created_at": "2026-01-03T11:26:02.434Z",
      "subreddit": {
        "id": "t5_2qhx4",
        "name": "Fitness"
      },
      "position": 2
    }
  ],
  "media": [
    {
      "id": "t3_geo4x",
      "title": "Bodyweight training for really strong people.",
      "url": "[https://external-preview.redd.it/](https://external-preview.redd.it/)...",
      "permalink": "/r/Fitness/comments/geo4x/...",
      "media_type": "image",
      "image": {
        "src": "[https://external-preview.redd.it/](https://external-preview.redd.it/)...",
        "width": 480,
        "height": 360
      },
      "nsfw": false,
      "spoiler": false,
      "subreddit": {
        "id": "t5_2qhx4",
        "name": "Fitness",
        "nsfw": false
      },
      "position": 3
    }
  ],
  "cursor": "eyJjYW5kaWRhdGVzX3JldHVybmVkIjoie1wic2..."
}