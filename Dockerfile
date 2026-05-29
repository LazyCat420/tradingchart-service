FROM mcr.microsoft.com/playwright/python:v1.44.0-jammy

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN chmod +x entrypoint.sh

# Expose ports for both servers
EXPOSE 3000
EXPOSE 8899

CMD ["./entrypoint.sh"]
