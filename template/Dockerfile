FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     python3 python3-pip ca-certificates git make g++ \
  && update-ca-certificates \
  && pip install --no-cache-dir --break-system-packages certifi \
  && npm install -g @apralabs/apra-fleet @anthropic-ai/claude-code \
  && apra-fleet install --skill none \
  && apt-get purge -y --auto-remove make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Use npm install — a generated project ships without a lockfile.
# Commit the lockfile npm writes here to enable lockfile-based installs.
COPY package.json ./
RUN npm install --omit=dev

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh

COPY . .

# The published @apralabs/apra-fleet has an internal file: dependency that npm
# hoists incorrectly — the sub-packages land but the parent doesn't. Copy the
# working global install into the local tree (not a symlink — Docker Desktop
# on Windows drops symlinks across overlay layers).
RUN mkdir -p node_modules/@apralabs \
  && rm -rf node_modules/@apralabs/apra-fleet \
  && cp -a /usr/local/lib/node_modules/@apralabs/apra-fleet node_modules/@apralabs/apra-fleet

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "host/index.mjs"]
