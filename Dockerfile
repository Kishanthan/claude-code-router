FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Install deps first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci

# Build from local source (exclude external volume if present)
COPY . .
# Build local llms to ensure dist matches source
RUN cd external/llms && npm ci --ignore-scripts && npm run build
# Override @musistudio/llms with local patched copy
RUN npm install --ignore-scripts --no-save ./external/llms
# Build router
RUN npm run build

# Build claude-trace from local source
WORKDIR /app/external/lemmy/apps/claude-trace
# Skip husky install/prepare during build (ignore scripts, then build with HUSKY=0)
RUN npm ci --ignore-scripts \
    && cd frontend && npm ci --ignore-scripts && cd .. \
    && HUSKY=0 npm run build

# Back to app root for final image copy
WORKDIR /app

# Final runtime image
FROM node:20-bookworm-slim
ENV NODE_ENV=production
ENV HOME=/home/ccr
WORKDIR /app

# Shell tooling and conda dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash curl bzip2 ca-certificates vim \
    && rm -rf /var/lib/apt/lists/*

# Install Miniconda
RUN curl -fsSL https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -o /tmp/miniconda.sh \
    && bash /tmp/miniconda.sh -b -p /opt/miniconda3 \
    && rm /tmp/miniconda.sh

ENV PATH="/opt/miniconda3/bin:${PATH}"

# Create non-root user
RUN groupadd -r ccr && useradd -r -g ccr -m -d /home/ccr -s /bin/bash ccr

# Install the router globally from the built workspace
COPY --from=builder /app /app
RUN npm install -g /app @anthropic-ai/claude-code@2.0.76 /app/external/lemmy/apps/claude-trace
# Ensure app directory and home are writable by non-root
RUN chown -R ccr:ccr /app /home/ccr

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

# Run from home so claude-trace can create .claude-trace
WORKDIR /home/ccr

# ENTRYPOINT ["/usr/local/bin/ccr-entrypoint.sh"]
# CMD ["sleep", "infinity"]

CMD ["ccr", "start"]
