# The same agent as the VM image, hosted by the Azure Functions runtime. Premium plan only.
FROM mcr.microsoft.com/azure-functions/node:4-node22

ENV AzureWebJobsScriptRoot=/home/site/wwwroot \
    AzureFunctionsJobHost__Logging__Console__IsEnabled=true \
    FUNCTIONS_WORKER_RUNTIME=node \
    WORKER_POOL_SIZE=0 \
    WORKER_EPHEMERAL_MAX=2 \
    JOBS_BACKEND=durable \
    DURABLE_TASK_HUB=fleetjobs

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates git curl make g++ \
  && update-ca-certificates \
  && pip install --no-cache-dir --break-system-packages certifi \
  && npm install -g @apralabs/apra-fleet @anthropic-ai/claude-code \
  && apra-fleet install --skill none \
  && apt-get purge -y --auto-remove make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /home/site/wwwroot
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --include=optional; else npm install --omit=dev --include=optional; fi
COPY . .
# The Functions host loads `main` from this package.json; point it at the Functions entry.
COPY deploy/azure-functions/wwwroot-package.json ./package.json
COPY comm/azure-functions/host.json ./host.json
# Patch the project's host.config.mjs for Azure Functions: switch adapter and dispatch backend.
RUN node deploy/azure-functions/patch-config.mjs host.config.mjs
RUN node -e "import('./transport/ensure-apralabs.mjs').then(m => m.ensureApralabs())"

# Provision Fleet auth from env at startup, then hand off to the Functions host.
COPY deploy/azure-functions/entrypoint.sh /usr/local/bin/agent-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/agent-entrypoint.sh && chmod +x /usr/local/bin/agent-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/agent-entrypoint.sh"]
CMD ["/opt/startup/start_nonappservice.sh"]

HEALTHCHECK --interval=10s --timeout=5s --start-period=90s --retries=12 \
  CMD curl -fsS http://localhost/api/health || exit 1
