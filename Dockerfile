# syntax=docker/dockerfile:1.7

# Stage 1: build the Vite bundle
FROM node:22-alpine AS builder
WORKDIR /app

# Install deps with package-lock for determinism
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Build
COPY tsconfig.json vite.config.ts index.html .env.production ./
COPY src/ ./src/
COPY block.manifest.json civitai.app.json ./
RUN npm run build

# Stage 2: serve via nginx
FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Block bundle served at /generate-from-model/ to match the manifest's iframe.src
COPY --from=builder /app/dist/ /usr/share/nginx/html/generate-from-model/
# Also expose the manifest at the well-known path for the platform to fetch
COPY --from=builder /app/block.manifest.json /usr/share/nginx/html/generate-from-model/block.manifest.json
COPY --from=builder /app/civitai.app.json /usr/share/nginx/html/generate-from-model/civitai.app.json

EXPOSE 8080
USER nginx
CMD ["nginx", "-g", "daemon off;"]
