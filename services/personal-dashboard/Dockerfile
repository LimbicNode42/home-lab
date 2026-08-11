FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV REPO_DOCS_ROOT=/app/repo-docs
ENV EPIC_DOCS_INDEX_PATH=/app/repo-docs/services/personal-dashboard/docs/epics/index.json

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --package-lock=false; fi

COPY src ./src
COPY public ./public
COPY config ./config
RUN mkdir -p /app/repo-docs/services/personal-dashboard
COPY README.md ./repo-docs/services/personal-dashboard/README.md
COPY docs ./repo-docs/services/personal-dashboard/docs

USER node
EXPOSE 4322
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4322/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
