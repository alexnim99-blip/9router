FROM decolua/9router:0.5.112@sha256:fab111d99b23bde6c8944ca22982603ab0b09e917a0b1e4ce42a24b05753bec9

ENV PORT=20128 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/app/data \
    AUTH_COOKIE_SECURE=true \
    REQUIRE_API_KEY=true

COPY space-server.js /app/space-server.js

EXPOSE 20128

CMD ["node", "space-server.js"]
