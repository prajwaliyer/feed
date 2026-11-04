FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --legacy-peer-deps

COPY . .
RUN npm run build

FROM nginx:alpine

# The nginx:alpine tag lags Alpine's security releases (brotli-libs, curl), so
# the published image ships CVEs that are already fixed upstream. Patch the base
# packages at build time rather than waiting for a new nginx tag.
RUN apk upgrade --no-cache

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
