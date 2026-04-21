FROM node:20

# Skip Puppeteer's bundled Chrome download — we use system Chromium instead
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install system Chromium — apt resolves all required shared libraries
RUN apt-get update && apt-get install -y \
    chromium \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run generate

CMD ["sh", "-c", "npm run generate && npm start"]
