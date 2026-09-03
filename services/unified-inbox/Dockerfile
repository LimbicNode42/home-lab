FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY src ./src
EXPOSE 8766
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8766/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "src/index.js"]
