# Sequenzy lifecycle emails

The backend sends these Sequenzy events:

| Event | When it fires |
| --- | --- |
| `signalqub.account_created` | A new row is inserted into the Supabase `profiles` table |
| `signalqub.user_idle_48h` | A profile is at least 48 hours old and has no `api_logs` rows |
| `signalqub.api_call_succeeded` | An authenticated `/v1/*` request returns HTTP 200 |
| `signalqub.credit_depletion` | The account crosses from above 200 credits to 200 or fewer |

All event delivery is asynchronous and fail-open. A Sequenzy outage never delays an API response. Event IDs make the idle and depletion events safe to retry.

## Environment

Add the workspace API key to the backend environment:

```env
SEQUENZY_API_KEY=your_sequenzy_api_key
```

The key needs `subscribers:write` and `automations:trigger` permissions. Without the key, the integration stays disabled.

## Sequenzy sequences

Create and activate these sequences in the Sequenzy dashboard:

1. **Account creation welcome**
    - Trigger: event `signalqub.account_created`
    - Email subject: `your 1,000 SignalQub credits + API key`
    - Body:

       ```text
       Hey {{firstName}},

       Your 1,000 free credits are loaded. You can generate your API key here: https://signalqub.com/dashboard

       To test the provider fallback instantly, just drop your API key into this curl request:
       curl -H "x-api-key: YOUR_KEY" https://api.signalqub.com/v1/reddit/subreddit/details?name=AskReddit

       The full docs are here: https://signalqub.com/docs. Let me know what latency you see on the first pull.
       ```

2. **48-hour idle rescue**
   - Trigger: event `signalqub.user_idle_48h`
   - Email subject: `everything working with the API?`
   - Body: use `{{firstName}}`, link to the n8n/Reddit video, and invite the user to reply with setup issues.

3. **Aha moment**
   - Trigger: frequency of `signalqub.api_call_succeeded`, five occurrences for the same subscriber.
   - Email subject: `nice pulls`
   - Explain that fallback routing is returning payloads and invite a production integration or higher rate-limit conversation.

4. **Credit depletion**
   - Trigger: event `signalqub.credit_depletion`.
   - Email subject: `SignalQub credits running low`
   - Use `{{event.creditsRemaining}}` and link to `https://signalqub.com/dashboard` for upgrading.

The signup listener requires Supabase Realtime to be enabled for `public.profiles`. It expects `profiles.id`, `profiles.email`, `profiles.created_at`, and `profiles.credits`, plus the existing `api_logs.user_id` column. The idle scanner runs hourly after the API starts as a retry/backfill path.