import { useEffect, useState } from 'react';

type Article = { id: string; title: string; url: string; publisher: string; publishedAt: string; summary: string; thumbnail?: string | null };
type NewsFeed = { articles: Article[]; retrievedAt: string };
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
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setStatus('loading');
    async function load() {
      try {
        const response = await fetch(`/api/news/${encodeURIComponent(ticker)}`, { signal: controller.signal });
        if (!response.ok) throw new Error('News unavailable');
        const result = await response.json() as NewsFeed;
        if (!Array.isArray(result.articles)) throw new Error('Invalid news response');
        if (!controller.signal.aborted) { setFeed(result); setStatus('ok'); }
      } catch {
        if (!controller.signal.aborted) setStatus('error');
      }
    }
    void load();
    return () => controller.abort();
  }, [ticker, active, refresh]);
  return <section className="news-section" aria-labelledby="news-title" aria-busy={status === 'loading'}>
    <div className="news-heading"><div><span className="news-eyebrow">{ticker} · LATEST COVERAGE</span><h2 id="news-title">Recent News</h2><p>Newest first · Yahoo Finance via yfinance</p></div><button type="button" className="news-refresh" disabled={status === 'loading'} onClick={() => setRefresh(value => value + 1)}>{status === 'loading' ? 'Loading…' : 'Refresh news'}</button></div>
    {status === 'error' && <p className="news-message" role="alert">Recent news is temporarily unavailable. Use Refresh news to try again.{feed && ' Previously loaded articles are shown below.'}</p>}
    {status === 'loading' && !feed && <p className="news-message" role="status">Loading recent articles…</p>}
    {status === 'ok' && feed?.articles.length === 0 && <p className="news-message">No recent articles are available for {ticker}.</p>}
    {feed && feed.articles.length > 0 && <ol className="news-list">{feed.articles.map(article => <li key={article.id}><article><div className="news-copy">
      <div className="news-meta"><span>{article.publisher}</span><time dateTime={article.publishedAt}>{publishedDate(article.publishedAt)}</time></div>
      <h3><a href={article.url} target="_blank" rel="noopener noreferrer">{article.title}<span aria-hidden="true"> ↗</span></a></h3>
      {article.summary && <p>{article.summary}</p>}
    </div><NewsThumbnail key={article.thumbnail} url={article.thumbnail}/></article></li>)}</ol>}
    {feed && <p className="news-updated">Feed retrieved {publishedDate(feed.retrievedAt)}</p>}
  </section>;
}
