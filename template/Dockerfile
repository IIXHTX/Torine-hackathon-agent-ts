# ARC-Bench selftest app package.
# Build must work WITHOUT external network: this zip ships prebuilt
# frontend/dist and vendored backend/node_modules. npm only runs as a
# fallback when those artifacts are absent.
FROM node:20-slim

WORKDIR /app

COPY . .

RUN cd frontend && { test -f dist/index.html || (npm install --no-audit --no-fund && npm run build); }
RUN cd backend && { test -d node_modules || npm install --omit=dev --no-audit --no-fund; }

ENV PORT=3000
EXPOSE 3000

CMD ["sh", "-c", "cd backend && node src/index.js"]
