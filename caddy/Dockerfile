FROM caddy:2.11.4-builder AS builder

RUN xcaddy build v2.11.4 \
    --with github.com/caddy-dns/tencentcloud@v0.4.3

FROM caddy:2.11.4

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
