# Build stage
FROM golang:1.26-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Build metadata stamped into the binary so the running app can report exactly
# which build it is (surfaced on the Updates page). Supplied by CI; empty on a
# plain local `docker compose up --build`, in which case the UI just omits them.
ARG DOCKYARD_COMMIT=""
ARG DOCKYARD_DATE=""
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
    -ldflags="-s -w \
      -X 'docker-manager/backend/api/handlers.appCommit=${DOCKYARD_COMMIT}' \
      -X 'docker-manager/backend/api/handlers.appBuildDate=${DOCKYARD_DATE}'" \
    -o /docker-manager .

# Runtime stage
FROM alpine:3.20

# ca-certificates for TLS; docker-cli + docker-cli-compose so the backend can run
# `docker compose` against the socket proxy; git/git-daemon for hosted repos;
# su-exec to drop from root to the unprivileged app user after fixing volume
# ownership (see entrypoint.sh).
RUN apk add --no-cache ca-certificates docker-cli docker-cli-compose docker-cli-buildx git git-daemon su-exec \
    && addgroup -g 10001 app \
    && adduser -D -u 10001 -G app -h /home/app app \
    && mkdir -p /data /backups

WORKDIR /app

COPY --from=builder /docker-manager .
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8080

# The entrypoint starts as root only long enough to take ownership of the data
# and backup volumes, then re-execs the binary as uid 10001 via su-exec.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
