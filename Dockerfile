FROM node:20-alpine AS builder
WORKDIR /app

# Install deps first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci

# Build from local source
COPY . .
RUN npm run build

# Final runtime image
FROM node:20-alpine
ENV NODE_ENV=production
ENV HOME=/home/ccr
WORKDIR /app

# Shell tooling for debugging/running bash inside the container
RUN apk add --no-cache bash

# Create non-root user
RUN addgroup -S ccr && adduser -S -G ccr ccr

# Install the router globally from the built workspace
COPY --from=builder /app /app
RUN npm install -g /app
RUN npm install -g @anthropic-ai/claude-code

# Place default config and custom router for container use
RUN mkdir -p /home/ccr/.claude-code-router
COPY docker/config.json /home/ccr/.claude-code-router/config.json
COPY docker/custom-router.js /home/ccr/.claude-code-router/custom-router.js
RUN chown -R ccr:ccr /home/ccr/.claude-code-router

# Entrypoint to ensure CCR service is started before running any command
# COPY docker/entrypoint.sh /usr/local/bin/ccr-entrypoint.sh
# RUN chmod +x /usr/local/bin/ccr-entrypoint.sh

EXPOSE 3456
VOLUME ["/home/ccr/.claude-code-router"]

USER ccr

# ENTRYPOINT ["/usr/local/bin/ccr-entrypoint.sh"]
# CMD ["sleep", "infinity"]

CMD ["ccr", "start"]
