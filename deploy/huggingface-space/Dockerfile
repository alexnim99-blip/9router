FROM decolua/9router:0.5.112@sha256:fab111d99b23bde6c8944ca22982603ab0b09e917a0b1e4ce42a24b05753bec9

ENV PORT=20128 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/app/data \
    AUTH_COOKIE_SECURE=true \
    REQUIRE_API_KEY=true

COPY space-server.js /app/space-server.js
COPY persistence.js /app/persistence.js
COPY open-sse/utils/dnsResolver.js /app/open-sse/utils/dnsResolver.js
COPY open-sse/utils/proxyFetch.js /app/open-sse/utils/proxyFetch.js
COPY src/lib/network/dnsResolver.js /app/src/lib/network/dnsResolver.js
COPY src/mitm/server.js /app/src/mitm/server.js
COPY src/lib/tunnel/shared/dnsResolver.js /app/src/lib/tunnel/shared/dnsResolver.js

ENV NINE_ROUTER_PERSIST_DIR=/app/persist

EXPOSE 20128

CMD ["node", "space-server.js"]
