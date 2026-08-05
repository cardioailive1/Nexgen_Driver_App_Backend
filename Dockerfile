FROM node:20-slim

WORKDIR /app

# Prisma's query engine needs OpenSSL. node:20-slim is a minimal Debian
# image that doesn't include it by default — without this, `prisma generate`
# during npm install below fails to detect/run the correct engine binary.
# This is the single most common Docker+Prisma build failure on a slim base
# image, and very likely what's actually breaking the Fly.io build.
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma

RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
