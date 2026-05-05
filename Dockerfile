FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
# `npm install` (not `npm ci`) so we don't require package-lock.json in the
# repo. Once a lockfile lands in source control, switch back to `npm ci` for
# faster, reproducible builds.
RUN npm install
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/index.js"]
