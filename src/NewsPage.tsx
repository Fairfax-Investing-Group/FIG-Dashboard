import { useEffect, useRef, useState } from 'react';

type Article = { id: string; title: string; url: string; publisher: string; publishedAt: string; summary: string; thumbnail?: string | null };
type NewsFeed = { articles: Article[]; retrievedAt: string; nextCount: number | null };
const publishedDate = (value: string) => new Date(value).toLocaleString(undefined, {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
});

function NewsThumbnail({ url }: { url: string | null | undefined }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return null;
  return <img className="news-thumbnail" src={url} alt="" width={112} height={80} loading="lazy" decoding="async" onError={() => setFailed(true)}/>;
}

export default function NewsPage({ ticker, active }: { ticker: string; active: boolean }) {
  const [feed, setFeed] = useState<NewsFeed | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [refresh, setRefresh] = useState(0);
  const [count, setCount] = useState(25);
  const lastLoad = useRef<{ ticker: string; count: number; refresh: number; time: number } | null>(null);
  useEffect(() => {
    if (!active) return;
    const last = lastLoad.current;
    if (last && last.ticker === ticker && last.count === count && last.refresh === refresh && Date.now() - last.time < 60_000) return;
    const controller = new AbortController();
    setStatus('loading');
    async function load() {
      try {
        const response = await fetch(`/api/news/${encodeURIComponent(ticker)}?count=${count}`, { signal: controller.signal });
        if (!response.ok) throw new Error('News unavailable');
        const result = await response.json() as NewsFeed;
        if (!Array.isArray(result.articles)) throw new Error('Invalid news response');
        if (!controller.signal.aborted) {
          setFeed(previous => {
            if (count === 25 || !previous) return result;
            const seen = new Set(previous.articles.map(article => article.url));
            const additional = result.articles.filter(article => !seen.has(article.url));
            return { ...result, nextCount: additional.length ? result.nextCount : null,
              articles: [...previous.articles, ...additional].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)) };
          });
          lastLoad.current = { ticker, count, refresh, time: Date.now() };
          setStatus('ok');
        }
      } catch {
        if (!controller.signal.aborted) setStatus('error');
      }
    }
    void load();
    return () => controller.abort();
  }, [ticker, active, refresh, count]);
  return <section className="news-section" aria-labelledby="news-title" aria-busy={status === 'loading'}>
    <div className="news-heading"><div><span className="news-eyebrow">{ticker} · LATEST COVERAGE</span><h2 id="news-title">Recent News</h2><p>Newest first · Yahoo Finance via yfinance</p></div><button type="button" className="news-refresh" disabled={status === 'loading'} onClick={() => { setCount(25); setRefresh(value => value + 1); }}>{status === 'loading' && count === 25 ? 'Loading…' : 'Refresh news'}</button></div>
    {status === 'error' && <p className="news-message" role="alert">{count > 25 ? 'Older articles could not be loaded. Use Retry to try again.' : 'Recent news is temporarily unavailable. Use Refresh news to try again.'}{feed && ' Previously loaded articles are shown below.'}</p>}
    {status === 'loading' && !feed && <p className="news-message" role="status">Loading recent articles…</p>}
    {status === 'ok' && feed?.articles.length === 0 && <p className="news-message">No recent articles are available for {ticker}.</p>}
    {feed && feed.articles.length > 0 && <ol id="news-articles" className="news-list">{feed.articles.map(article => <li key={article.url}><article><div className="news-copy">
      <div className="news-meta"><span>{article.publisher}</span><time dateTime={article.publishedAt}>{publishedDate(article.publishedAt)}</time></div>
      <h3><a href={article.url} target="_blank" rel="noopener noreferrer">{article.title}<span aria-hidden="true"> ↗</span></a></h3>
      {article.summary && <p>{article.summary}</p>}
    </div><NewsThumbnail key={article.thumbnail} url={article.thumbnail}/></article></li>)}</ol>}
    {feed && <p className="news-updated">Feed retrieved {publishedDate(feed.retrievedAt)}</p>}
    {feed && feed.nextCount != null && <div className="news-load-more"><button type="button" className="news-refresh" aria-controls="news-articles" disabled={status === 'loading'} onClick={() => { if (status === 'error' && count > 25) setRefresh(value => value + 1); else setCount(feed.nextCount!); }}>{status === 'loading' && count > 25 ? 'Loading older articles…' : status === 'error' && count > 25 ? 'Retry' : 'Load more'}</button></div>}
    {feed && feed.articles.length > 0 && feed.nextCount == null && <p className="news-message" role="status">{count >= 250 ? 'Reached the 250-article limit for this feed.' : 'Yahoo Finance returned no additional articles.'}</p>}
  </section>;
}
