# Study loading performance

The initial view requests only Fundamentals fields and weekly chart prices.
SEC financials and Yahoo sections stream independently; EPS stays unavailable
until split history can verify its share basis. Completion streams daily prices
before waiting for optional market and peer research. Manual forecasts and
excluded years survive each update.

## Changes

- Share Yahoo profile work and reuse SEC HTTPS connections without caching SEC
  financial responses across newly created studies.
- Extract the initial financial subset first. Retain only relevant SEC concepts,
  units, and historical periods for full background extraction, including prior
  beginning balances. Preserve original values for split normalization.
- Reuse prepared snapshots, avoid redundant deep copies, serialize outside the
  database lock, and return compact JSON. The UI receives a projection containing
  its chart, valuation, dividend, and financial inputs; default API responses and
  JSON exports retain the full document.
- Fetch independent optional Yahoo sections concurrently. Daily chart updates
  arrive before peer research finishes.
- Load the Supabase SDK separately from the initial application bundle. Cache
  company-directory indexes, portfolio file parsing, calendar lookups, and recent
  successful news feeds. Memoize expensive chart/table rendering.
- Bound the browser study cache to four recent studies and preload metadata to
  eight entries. Discard unselected preload payloads immediately, cancel work
  between download/processing stages, and expire idle server preloads after
  60 seconds (checked every five seconds). Already-running upstream requests may
  finish, but discarded results cannot refill those caches. Release completed
  checkpoints, stream readers, and unused enrichment locks.

## Measurements

Local backend measurements used AAPL, MSFT, and NVDA with peers disabled on both
runs. Times include live providers, vary between requests, and are not browser
paint measurements. These are small samples, not latency guarantees.

| Measurement | Before | After |
| --- | --- | --- |
| Initial JavaScript, gzip | 252 KB | 194 KB |
| Stored completion checkpoint | 4.60–5.78 MB | 0.76–0.86 MB |
| Completed document sent to UI, uncompressed | 0.95–1.05 MB | about 0.15 MB |
| Background completion, peers disabled | 1.02–1.18 s | 0.39–0.47 s |
| First financial section | 0.19–0.29 s | 0.11–0.25 s |

Full Fundamentals readiness was 0.40–0.56 s before and 0.27–0.66 s after.
AAPL's Yahoo profile took longer in the second run, so readiness did not improve
on every request. Some initial measurements included Python profiling overhead.
In a separate normal three-peer AAPL run, Fundamentals was ready at 0.40 s,
daily prices arrived another 0.40 s later, and full completion took 1.99 s after
Fundamentals. Optional peers no longer hold up the daily chart.

All numeric annual and quarterly financial fields in AAPL's full export matched
before and after. Automated checks cover projection inputs, split verification,
streamed updates, forecast preservation, preload retries/cancellation/expiry,
news reuse, and cache eviction. At implementation time, 117 Python tests,
62 JavaScript tests, and the production build passed.

Repeat a live backend measurement without changing existing studies:

```sh
.venv/bin/python -m scripts.benchmarkLoading AAPL MSFT NVDA
.venv/bin/python -m scripts.benchmarkLoading AAPL --peers 3
```

The command uses a temporary SQLite database and makes real SEC/Yahoo requests.
The separate Supabase SDK chunk is about 59 KB gzip and still loads for auth.
Network latency, provider throttling, cold processes, and company filing size
remain sources of variation.
