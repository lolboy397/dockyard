# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --legacy-peer-deps

COPY . .
RUN npm run build -- --configuration=production

# Runtime stage
FROM nginx:1.27-alpine

# openssl to generate a default self-signed certificate at build time.
RUN apk add --no-cache openssl

COPY --from=builder /app/dist/frontend/browser /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Bake a self-signed cert so the image serves HTTPS out of the box. Mount real
# certs over /etc/nginx/certs (fullchain.pem + privkey.pem) in production.
RUN mkdir -p /etc/nginx/certs && \
    openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
      -keyout /etc/nginx/certs/privkey.pem \
      -out /etc/nginx/certs/fullchain.pem \
      -subj "/CN=dockyard.local" \
      -addext "subjectAltName=DNS:localhost,DNS:dockyard.local,IP:127.0.0.1" && \
    chmod 600 /etc/nginx/certs/privkey.pem

EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
