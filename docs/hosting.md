# Live studies on the hosted website

GitHub Pages serves the React frontend and any pre-generated snapshot files. It
cannot run the Python SEC/Yahoo research API. Supabase supplies authentication
and saved user inputs; it does not run this Python API either.

To generate studies for arbitrary companies, deploy this repository's Python API
as a web service, then configure GitHub Pages to use that service's HTTPS origin.

## Deploy the API

A backend-only `Dockerfile` is included. On Render, create a **Web Service** from
this GitHub repository and select the Docker runtime. The image runs
`python -m server.app` and accepts the platform's `PORT` automatically. Set the
health-check path to `/api/health`.

Set these service environment variables:

```dotenv
STUDY_ALLOWED_ORIGINS=https://research.fairfaxinvestinggroup.com
SEC_USER_AGENT=FairfaxInvestingGroup your-real-contact-email@example.com
```

Replace the contact email with your actual SEC contact identification. The image
sets `API_HOST=0.0.0.0`; local development continues to bind only to loopback.
No Supabase secret or service-role key is needed on this service.

After deployment, open `https://YOUR-SERVICE.onrender.com/api/health`. It should
return `{"status":"ok"}`. Use the actual assigned HTTPS service URL below.

## Connect the GitHub Pages frontend

In the GitHub repository, open **Settings → Secrets and variables → Actions →
Variables** and create:

```dotenv
VITE_STUDY_API_URL=https://YOUR-SERVICE.onrender.com
```

Use the origin only, without `/api`. `VITE_API_BASE_URL` is also supported for
existing deployments; `VITE_STUDY_API_URL` takes priority when both are set. The Pages workflow now passes this variable
to the Vite build. Keep the existing Supabase variables configured. Push these
changes and rerun **Deploy GitHub Pages** so the new origin is included in the
built JavaScript; changing a GitHub variable alone does not rebuild the site.

The frontend now sends study generation, preloading, completion, quotes, news,
portfolio requests, and exports to the API. Company search and Supabase requests
keep their existing locations. In local `.env.local`, leave
`VITE_STUDY_API_URL` empty to use Vite's normal `/api` proxy.

`CORS_ORIGINS` is a compatibility alias for `STUDY_ALLOWED_ORIGINS`;
`STUDY_ALLOWED_ORIGINS` takes priority. The production frontend domain is allowed
by default when neither is configured. CORS allows the exact origins in `STUDY_ALLOWED_ORIGINS` (comma separated, no
wildcards). Include any additional frontend domains you actually serve. This
also covers preflight requests and streamed Fundamentals/background responses.

## Storage and availability

The API keeps provider snapshots and completion checkpoints in local SQLite.
On hosts with ephemeral filesystems these are lost on redeploy/restart; cloud
saved user inputs stay in Supabase and can be reopened with fresh provider data.
To retain provider snapshots, attach a persistent volume and set, for example:

```dotenv
STUDY_DB=/data/studies.sqlite3
PORTFOLIO_CACHE=/data/portfolio.json
```

Use a single API instance with these local files. A service that sleeps when idle
adds a cold start before the first request; use an always-on service when startup
speed matters. SEC/Yahoo downloads still depend on provider availability.

References: [GitHub Pages is static hosting](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages),
[Render web services and port binding](https://render.com/docs/web-services),
[Render free-service limitations](https://render.com/docs/free).
