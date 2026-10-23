# Stock Search

A simple company and stock ticker search page built with React, TypeScript, and Vite.

```sh
npm install
npm run dev
```

Search by company name or ticker. Exact ticker matches appear first. Results include the exchange and a link to the company's SEC filings. Search runs locally against the bundled SEC directory in `public/companies.json`; no API key is required. This is a snapshot of SEC ticker coverage, not a global securities directory or a live price feed.

Data source: https://www.sec.gov/files/company_tickers_exchange.json

To refresh the directory, replace `public/companies.json` with the latest JSON from the source, keeping its `fields` / `data` format.

Edit `src/App.tsx` for page behavior and `src/styles.css` for styling. Run `npm run build` to create a production build in `dist/`.
