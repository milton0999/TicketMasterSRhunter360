FROM node:24-alpine

# sqlite3 needs build tools
RUN apk add --no-cache python3 make g++

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
