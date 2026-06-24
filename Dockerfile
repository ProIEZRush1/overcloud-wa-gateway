FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
RUN mkdir -p storage/auth storage/media

EXPOSE 8088
CMD ["node", "src/index.js"]
