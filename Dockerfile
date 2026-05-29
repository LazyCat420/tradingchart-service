FROM python:3.12-slim

WORKDIR /app

# Install dependencies needed by playwright and the app
RUN apt-get update && apt-get install -y \
    wget gnupg curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt
RUN playwright install --with-deps chromium

COPY . .

RUN chmod +x entrypoint.sh

# Expose ports for both servers
EXPOSE 3000
EXPOSE 8899

CMD ["./entrypoint.sh"]
