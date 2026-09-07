FROM node:22-bookworm-slim

# sqlite3 needs build tools
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json ./
RUN npm install --omit=dev

# Copy app source
COPY server.js ./
COPY public/ ./public/

# SQLite data lives in a volume so it survives restarts
RUN mkdir -p /data

EXPOSE 3000

ENV NODE_ENV=production
ENV DB_PATH=/data/ticketdash.db

CMD ["node", "server.js"]
