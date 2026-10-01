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
# The global @apralabs/apra-fleet is linked into the local tree because the
# published package's file: internal dependency can break a vanilla npm install.
COPY package.json ./
RUN npm install --omit=dev \
  && if ! node -e "require.resolve('@apralabs/apra-fleet')" 2>/dev/null; then \
       ln -s "$(npm root -g)/@apralabs" node_modules/@apralabs; \
     fi

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh

COPY . .

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "host/index.mjs"]
