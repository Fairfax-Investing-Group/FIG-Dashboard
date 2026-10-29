FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 API_HOST=0.0.0.0 API_PORT=8000
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server ./server
COPY public/companies.json ./public/companies.json
COPY src/data/portfolio.json ./src/data/portfolio.json
RUN mkdir -p .data
EXPOSE 8000
CMD ["python", "-m", "server.app"]
